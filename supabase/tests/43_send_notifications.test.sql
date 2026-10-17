-- The send-notifications worker's database side (spec 4.13, 8.5): the queue functions, the group
-- re-read, the send log, receipts, token deletion, privileges and the cron jobs.
begin;
create extension if not exists pgtap with schema extensions;
select plan(33);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex and Sam share household H, which has the lists Groceries and Old (deleted) and the recipe Tacos.
insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated', '{"full_name":"Alex  Rivera"}'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated', '{"full_name":"Sam"}');
update public.profiles set display_name = '  Alex  Rivera' where user_id = '11111111-1111-1111-1111-111111111111';
insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Home');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'member', 2);
insert into public.lists (id, household_id, name, position, deleted_at) values
  ('a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Groceries', 1, null),
  ('a1000000-0000-7000-8000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Old', 2, now());
insert into public.recipes (id, household_id, name) values
  ('a3000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tacos');
-- Items 1-3 on Groceries (3 deleted), 4 checked by Alex, 5 checked by Sam.
insert into public.list_items (id, list_id, household_id, ingredient_name, display_name, added_by, deleted_at, checked_at, checked_by) values
  ('a2000000-0000-7000-8000-000000000001', 'a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'onion', '**Onion** 🧅', '11111111-1111-1111-1111-111111111111', null, null, null),
  ('a2000000-0000-7000-8000-000000000002', 'a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'garlic', 'Garlic', '11111111-1111-1111-1111-111111111111', null, null, null),
  ('a2000000-0000-7000-8000-000000000003', 'a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'tomato', 'Tomato', '11111111-1111-1111-1111-111111111111', now(), null, null),
  ('a2000000-0000-7000-8000-000000000004', 'a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'milk', 'Milk', '11111111-1111-1111-1111-111111111111', null, now(), '11111111-1111-1111-1111-111111111111'),
  ('a2000000-0000-7000-8000-000000000005', 'a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'egg', 'Eggs', '11111111-1111-1111-1111-111111111111', null, now(), '22222222-2222-2222-2222-222222222222');
-- Contributions: 1 (recipe, item 1), 2 (recipe, item 2), 3 (undone, item 2), 4 (on deleted item 3).
insert into public.list_item_contributions (id, list_item_id, household_id, source, recipe_id, added_by, deleted_at, created_at) values
  ('a4000000-0000-7000-8000-000000000001', 'a2000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'recipe', 'a3000000-0000-7000-8000-000000000001', '11111111-1111-1111-1111-111111111111', null, '2026-10-10T10:00:00Z'),
  ('a4000000-0000-7000-8000-000000000002', 'a2000000-0000-7000-8000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'recipe', 'a3000000-0000-7000-8000-000000000001', '11111111-1111-1111-1111-111111111111', null, '2026-10-10T10:00:01Z'),
  ('a4000000-0000-7000-8000-000000000003', 'a2000000-0000-7000-8000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'manual', null, '11111111-1111-1111-1111-111111111111', now(), '2026-10-10T10:00:02Z'),
  ('a4000000-0000-7000-8000-000000000004', 'a2000000-0000-7000-8000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'manual', null, '11111111-1111-1111-1111-111111111111', null, '2026-10-10T10:00:03Z');
-- The fixtures queued events; start from an empty queue.
delete from pgmq.q_household_events;

-- Privileges ------------------------------------------------------------------
select ok(
  not has_function_privilege('authenticated', 'public.read_household_events(integer, integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.archive_household_events(bigint[])', 'execute')
  and not has_function_privilege('authenticated', 'public.release_household_events(bigint[])', 'execute')
  and not has_function_privilege('authenticated', 'public.notification_group(text, uuid, uuid, uuid[])', 'execute')
  and not has_function_privilege('authenticated', 'public.notification_recipients(uuid, uuid, text, timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.record_push_sent(uuid, uuid, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.delete_push_tokens(text[])', 'execute')
  and not has_function_privilege('authenticated', 'public.save_push_receipts(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.due_push_receipts(interval, integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.delete_push_receipts(text[])', 'execute')
  and not has_function_privilege('anon', 'public.read_household_events(integer, integer)', 'execute')
  and not has_function_privilege('anon', 'public.notification_group(text, uuid, uuid, uuid[])', 'execute')
  and not has_function_privilege('authenticated', 'private.request_send_notifications()', 'execute'),
  'clients can''t call the worker''s functions');
select ok(
  has_function_privilege('service_role', 'public.read_household_events(integer, integer)', 'execute')
  and has_function_privilege('service_role', 'public.archive_household_events(bigint[])', 'execute')
  and has_function_privilege('service_role', 'public.release_household_events(bigint[])', 'execute')
  and has_function_privilege('service_role', 'public.notification_group(text, uuid, uuid, uuid[])', 'execute')
  and has_function_privilege('service_role', 'public.notification_recipients(uuid, uuid, text, timestamptz)', 'execute')
  and has_function_privilege('service_role', 'public.record_push_sent(uuid, uuid, uuid, text)', 'execute')
  and has_function_privilege('service_role', 'public.delete_push_tokens(text[])', 'execute')
  and has_function_privilege('service_role', 'public.save_push_receipts(jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.due_push_receipts(interval, integer)', 'execute')
  and has_function_privilege('service_role', 'public.delete_push_receipts(text[])', 'execute'),
  'service_role can call them');
select ok(
  (select bool_and(c.relrowsecurity) from pg_class c
   where c.oid in ('private.push_sent'::regclass, 'private.push_receipts'::regclass)),
  'RLS is on for push_sent and push_receipts');

-- The queue -------------------------------------------------------------------
select pgmq.send('household_events', '{"n": 1}');
select pgmq.send('household_events', '{"n": 2}');
select pgmq.send('household_events', '{"n": 3}');
set local role service_role;
create temp table first_read on commit drop as select * from public.read_household_events(2, 120);
reset role;
select results_eq($$ select message ->> 'n' from first_read order by msg_id $$, $$ values ('1'), ('2') $$, 'read takes up to p_qty events, oldest first');
select results_eq($$ select (message ->> 'n') from public.read_household_events(10, 120) $$, $$ values ('3') $$, 'events read are hidden from the next read');
select is((select count(*)::int from public.read_household_events(10, 120)), 0, 'nothing is visible while all are hidden');

set local role service_role;
select public.release_household_events((select array_agg(msg_id) from first_read where message ->> 'n' = '1'));
reset role;
select results_eq($$ select (message ->> 'n') from public.read_household_events(10, 120) $$, $$ values ('1') $$, 'a released event is visible again at once');

set local role service_role;
select public.archive_household_events((select array_agg(msg_id) from first_read));
select public.archive_household_events('{}');
select public.release_household_events(null);
reset role;
select results_eq(
  $$ select message ->> 'n' from pgmq.a_household_events order by msg_id $$, $$ values ('1'), ('2') $$,
  'archived events move to the archive');
select results_eq(
  $$ select message ->> 'n' from pgmq.q_household_events $$, $$ values ('3') $$,
  'and leave the queue; an empty or null list is a no-op');
delete from pgmq.q_household_events;

-- The group re-read: adds -----------------------------------------------------
set local role service_role;
create temp table added on commit drop as
  select public.notification_group('items_added', 'a1000000-0000-7000-8000-000000000001', '11111111-1111-1111-1111-111111111111',
    array['a4000000-0000-7000-8000-000000000002', 'a4000000-0000-7000-8000-000000000001',
          'a4000000-0000-7000-8000-000000000003', 'a4000000-0000-7000-8000-000000000004']::uuid[]) as g;
reset role;
select is((select g ->> 'list_name' from added), 'Groceries', 'the list''s name');
select is((select g ->> 'actor_name' from added), 'Alex', 'the actor''s first word, trimmed');
select is(
  (select g -> 'items' from added),
  jsonb_build_array(
    jsonb_build_object('id', 'a2000000-0000-7000-8000-000000000001', 'name', '**Onion** 🧅', 'recipe_id', 'a3000000-0000-7000-8000-000000000001', 'recipe_name', 'Tacos'),
    jsonb_build_object('id', 'a2000000-0000-7000-8000-000000000002', 'name', 'Garlic', 'recipe_id', 'a3000000-0000-7000-8000-000000000001', 'recipe_name', 'Tacos')),
  'live contributions only (not undone, not on a deleted item), oldest first, with the item name as it is and the recipe');
select is((select g -> 'last_sent_at' from added), 'null'::jsonb, 'never sent: no last_sent_at');

select is(
  public.notification_group('items_added', 'a1000000-0000-7000-8000-000000000002', '11111111-1111-1111-1111-111111111111',
    array['a4000000-0000-7000-8000-000000000001']::uuid[]) -> 'items',
  '[]'::jsonb, 'contributions are only counted on the group''s list');
select is(
  public.notification_group('items_added', 'a1000000-0000-7000-8000-000000000002', '11111111-1111-1111-1111-111111111111', '{}') -> 'list_name',
  'null'::jsonb, 'a deleted list has no name');
select is(
  public.notification_group('items_added', 'a1000000-0000-7000-8000-000000000001', '99999999-9999-9999-9999-999999999999', '{}') -> 'actor_name',
  'null'::jsonb, 'an actor with no profile has no name');
select throws_ok(
  $$ select public.notification_group('party', 'a1000000-0000-7000-8000-000000000001', '11111111-1111-1111-1111-111111111111', '{}') $$,
  '22023', 'invalid kind', 'an unknown kind is refused');

-- The group re-read: checks ---------------------------------------------------
select is(
  public.notification_group('shopping', 'a1000000-0000-7000-8000-000000000001', '11111111-1111-1111-1111-111111111111',
    array['a2000000-0000-7000-8000-000000000004', 'a2000000-0000-7000-8000-000000000005', 'a2000000-0000-7000-8000-000000000001']::uuid[]) -> 'items',
  jsonb_build_array(jsonb_build_object('id', 'a2000000-0000-7000-8000-000000000004', 'name', 'Milk', 'recipe_id', null, 'recipe_name', null)),
  'only items still checked by the actor count (not one checked by someone else, not an unchecked one)');
update public.list_items set checked_at = null, checked_by = null where id = 'a2000000-0000-7000-8000-000000000004';
select is(
  public.notification_group('shopping', 'a1000000-0000-7000-8000-000000000001', '11111111-1111-1111-1111-111111111111',
    array['a2000000-0000-7000-8000-000000000004']::uuid[]) -> 'items',
  '[]'::jsonb, 'an item unchecked again doesn''t count');

-- The send log ----------------------------------------------------------------
set local role service_role;
select public.record_push_sent('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a1000000-0000-7000-8000-000000000001', 'shopping');
reset role;
insert into private.push_sent (household_id, actor, list_id, kind, sent_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a1000000-0000-7000-8000-000000000001', 'shopping', now() - interval '3 hours'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'a1000000-0000-7000-8000-000000000001', 'shopping', now() + interval '1 hour');
select is(
  (public.notification_group('shopping', 'a1000000-0000-7000-8000-000000000001', '11111111-1111-1111-1111-111111111111', '{}') ->> 'last_sent_at')::timestamptz,
  now(), 'last_sent_at is the latest push for this actor, list and kind');
select is(
  public.notification_group('items_added', 'a1000000-0000-7000-8000-000000000001', '11111111-1111-1111-1111-111111111111', '{}') -> 'last_sent_at',
  'null'::jsonb, 'and is per kind');
select throws_ok(
  $$ insert into private.push_sent (household_id, actor, list_id, kind) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'party') $$,
  '23514', null, 'push_sent only takes the two kinds');

-- Recipients ------------------------------------------------------------------
insert into public.push_tokens (token, user_id, platform) values
  ('ExponentPushToken[alex]', '11111111-1111-1111-1111-111111111111', 'ios'),
  ('ExponentPushToken[sam]', '22222222-2222-2222-2222-222222222222', 'ios'),
  ('ExponentPushToken[sam2]', '22222222-2222-2222-2222-222222222222', 'ios');
set local role service_role;
select results_eq(
  $$ select user_id, token, platform from public.notification_recipients('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'items_added', now()) $$,
  $$ values ('22222222-2222-2222-2222-222222222222'::uuid, 'ExponentPushToken[sam]', 'ios'), ('22222222-2222-2222-2222-222222222222'::uuid, 'ExponentPushToken[sam2]', 'ios') $$,
  'notification_recipients is private.push_recipients: everyone else''s devices, not the actor''s');

-- Tokens ----------------------------------------------------------------------
select public.delete_push_tokens(array['ExponentPushToken[sam2]', 'ExponentPushToken[unknown]']);
reset role;
select results_eq(
  $$ select token from public.push_tokens order by token $$,
  $$ values ('ExponentPushToken[alex]'), ('ExponentPushToken[sam]') $$,
  'delete_push_tokens removes the named tokens; an unknown one is fine');

-- Receipts --------------------------------------------------------------------
set local role service_role;
select public.save_push_receipts('[{"ticket_id": "t-new", "token": "ExponentPushToken[sam]"}, {"ticket_id": "t-new", "token": "ExponentPushToken[sam]"}, {"ticket_id": null, "token": "x"}]');
select public.save_push_receipts(null);
reset role;
select results_eq(
  $$ select ticket_id, token from private.push_receipts $$,
  $$ values ('t-new', 'ExponentPushToken[sam]') $$,
  'save_push_receipts stores each ticket once and skips incomplete ones');
insert into private.push_receipts (ticket_id, token, created_at) values
  ('t-16min', 'ExponentPushToken[sam]', now() - interval '16 minutes'),
  ('t-20min', 'ExponentPushToken[alex]', now() - interval '20 minutes'),
  ('t-25h', 'ExponentPushToken[alex]', now() - interval '25 hours');
set local role service_role;
create temp table due on commit drop as select * from public.due_push_receipts(interval '15 minutes', 10);
reset role;
select results_eq(
  $$ select ticket_id, token from due $$,
  $$ values ('t-20min', 'ExponentPushToken[alex]'), ('t-16min', 'ExponentPushToken[sam]') $$,
  'due_push_receipts returns those at least 15 minutes old, oldest first');
select ok(not exists (select 1 from private.push_receipts where ticket_id = 't-25h'), 'and drops those older than 24 hours');
select is((select count(*)::int from public.due_push_receipts(interval '15 minutes', 1)), 1, 'up to the limit');
set local role service_role;
select public.delete_push_receipts(array['t-16min', 't-20min']);
reset role;
select results_eq($$ select ticket_id from private.push_receipts $$, $$ values ('t-new') $$, 'delete_push_receipts removes checked receipts');

-- Schedule --------------------------------------------------------------------
select is((select schedule from cron.job where jobname = 'send-notifications'), '* * * * *', 'the worker runs every minute');
select is((select schedule from cron.job where jobname = 'push-sent-retention'), '47 3 * * *', 'the send log is cleaned daily');
select ok(
  (select command from cron.job where jobname = 'push-sent-retention') like '%interval ''7 days''%',
  'keeping 7 days');
delete from vault.secrets where name in ('project_url', 'notifications_worker_key');
select is(private.request_send_notifications(), false, 'without the Vault secrets the job does nothing');

select * from finish();
rollback;
