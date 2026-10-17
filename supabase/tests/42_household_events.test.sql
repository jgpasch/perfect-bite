-- Household events (spec 4.13, 8): adds and checks queue an event on household_events, from
-- apply_mutations and from any other write; merges don't queue twice; a queue failure never fails
-- the write.
begin;
create extension if not exists pgtap with schema extensions;
select plan(30);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex and Sam share household H, which has the list Groceries and the recipe Tacos.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Home');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'member', 2);
insert into public.lists (id, household_id, name, position) values
  ('a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Groceries', 1);
insert into public.recipes (id, household_id, name) values
  ('a3000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tacos');

select has_table('pgmq', 'q_household_events', 'the household_events queue exists');
select ok(
  (select bool_and(c.relrowsecurity) from pg_class c
   where c.oid in ('pgmq.q_household_events'::regclass, 'pgmq.a_household_events'::regclass)),
  'RLS is on for the queue and its archive');
select ok(
  not has_function_privilege('authenticated', 'private.queue_items_added()', 'execute')
  and not has_function_privilege('authenticated', 'private.queue_shopping()', 'execute')
  and not has_function_privilege('anon', 'private.queue_items_added()', 'execute')
  and not has_function_privilege('anon', 'private.queue_shopping()', 'execute'),
  'clients can''t call the trigger functions');

-- An add through apply_mutations ------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000000-0000-alex",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "banana", "display_name": "Bananas", "added_by": "11111111-1111-1111-1111-111111111111" } },
    { "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000001", "hlc": "1760000000000-0001-alex",
      "fields": { "list_item_id": "a2000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "added_by": "11111111-1111-1111-1111-111111111111", "created_at": "2026-10-10T10:00:00Z" } }
  ] $$),
  '[{"status": "applied"}, {"status": "applied"}]'::jsonb,
  'an add syncs');
reset role;
select results_eq(
  $$ select message from pgmq.q_household_events order by msg_id $$,
  $$ values (jsonb_build_object(
    'kind', 'items_added',
    'household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
    'list_id', 'a1000000-0000-7000-8000-000000000001'::uuid,
    'actor', '11111111-1111-1111-1111-111111111111'::uuid,
    'contribution_id', 'a4000000-0000-7000-8000-000000000001'::uuid,
    'list_item_id', 'a2000000-0000-7000-8000-000000000001'::uuid,
    'recipe_id', null::uuid,
    'source', 'manual',
    'at', '2026-10-10T10:00:00Z'::timestamptz)) $$,
  'the add queues one items_added event, with the list looked up from the item (the item itself queues nothing)');
delete from pgmq.q_household_events;

-- A recipe add written directly: one event per contribution ----------------------
insert into public.list_items (id, list_id, household_id, ingredient_name, display_name, added_by) values
  ('a2000000-0000-7000-8000-000000000002', 'a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'onion', 'Onion', '22222222-2222-2222-2222-222222222222'),
  ('a2000000-0000-7000-8000-000000000003', 'a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'garlic', 'Garlic', '22222222-2222-2222-2222-222222222222'),
  ('a2000000-0000-7000-8000-000000000004', 'a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'tomato', 'Tomatoes', '22222222-2222-2222-2222-222222222222');
insert into public.list_item_contributions (id, list_item_id, household_id, source, recipe_id, added_by) values
  ('a4000000-0000-7000-8000-000000000002', 'a2000000-0000-7000-8000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'recipe', 'a3000000-0000-7000-8000-000000000001', '22222222-2222-2222-2222-222222222222'),
  ('a4000000-0000-7000-8000-000000000003', 'a2000000-0000-7000-8000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'recipe', 'a3000000-0000-7000-8000-000000000001', '22222222-2222-2222-2222-222222222222'),
  ('a4000000-0000-7000-8000-000000000004', 'a2000000-0000-7000-8000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'recipe', 'a3000000-0000-7000-8000-000000000001', '22222222-2222-2222-2222-222222222222');
select results_eq(
  $$ select message ->> 'kind', message ->> 'actor', message ->> 'list_id', message ->> 'contribution_id',
       message ->> 'list_item_id', message ->> 'recipe_id', message ->> 'source'
     from pgmq.q_household_events order by msg_id $$,
  $$ values
    ('items_added', '22222222-2222-2222-2222-222222222222', 'a1000000-0000-7000-8000-000000000001', 'a4000000-0000-7000-8000-000000000002', 'a2000000-0000-7000-8000-000000000002', 'a3000000-0000-7000-8000-000000000001', 'recipe'),
    ('items_added', '22222222-2222-2222-2222-222222222222', 'a1000000-0000-7000-8000-000000000001', 'a4000000-0000-7000-8000-000000000003', 'a2000000-0000-7000-8000-000000000003', 'a3000000-0000-7000-8000-000000000001', 'recipe'),
    ('items_added', '22222222-2222-2222-2222-222222222222', 'a1000000-0000-7000-8000-000000000001', 'a4000000-0000-7000-8000-000000000004', 'a2000000-0000-7000-8000-000000000004', 'a3000000-0000-7000-8000-000000000001', 'recipe') $$,
  'a recipe add written outside apply_mutations queues one event per ingredient, each with the recipe');
select is(
  (select count(*)::int from pgmq.q_household_events
   where (message ->> 'at')::timestamptz = (select c.created_at from public.list_item_contributions c where c.id = (message ->> 'contribution_id')::uuid)),
  3, 'each event''s time is its contribution''s created_at');
delete from pgmq.q_household_events;

-- Combine into an open item: a contribution and no new item -----------------------
insert into public.list_item_contributions (id, list_item_id, household_id, quantity, added_by) values
  ('a4000000-0000-7000-8000-000000000005', 'a2000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 2, '22222222-2222-2222-2222-222222222222');
select results_eq(
  $$ select message ->> 'kind', message ->> 'actor', message ->> 'list_item_id', message ->> 'list_id', message ->> 'contribution_id'
     from pgmq.q_household_events $$,
  $$ values ('items_added', '22222222-2222-2222-2222-222222222222', 'a2000000-0000-7000-8000-000000000001', 'a1000000-0000-7000-8000-000000000001', 'a4000000-0000-7000-8000-000000000005') $$,
  'combining into an open item queues an items_added event for that item');
delete from pgmq.q_household_events;

-- Checks ------------------------------------------------------------------------
update public.list_items set checked_at = '2026-10-10T11:00:00Z', checked_by = '11111111-1111-1111-1111-111111111111'
where id = 'a2000000-0000-7000-8000-000000000002';
select results_eq(
  $$ select message from pgmq.q_household_events $$,
  $$ values (jsonb_build_object(
    'kind', 'shopping',
    'household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
    'list_id', 'a1000000-0000-7000-8000-000000000001'::uuid,
    'actor', '11111111-1111-1111-1111-111111111111'::uuid,
    'list_item_id', 'a2000000-0000-7000-8000-000000000002'::uuid,
    'at', '2026-10-10T11:00:00Z'::timestamptz)) $$,
  'checking an item queues a shopping event at its checked_at');
delete from pgmq.q_household_events;

update public.list_items set checked_at = '2026-10-10T11:05:00Z', checked_by = '22222222-2222-2222-2222-222222222222'
where id = 'a2000000-0000-7000-8000-000000000002';
select is_empty($$ select 1 from pgmq.q_household_events $$, 're-checking an already checked item queues nothing');

update public.list_items set checked_at = null, checked_by = null
where id = 'a2000000-0000-7000-8000-000000000002';
select is_empty($$ select 1 from pgmq.q_household_events $$, 'unchecking an item queues nothing');

update public.list_items set note = 'red ones' where id = 'a2000000-0000-7000-8000-000000000002';
select is_empty($$ select 1 from pgmq.q_household_events $$, 'editing another field queues nothing');

-- No actor, or a deleted row ------------------------------------------------------
update public.list_items set checked_at = '2026-10-10T11:10:00Z', checked_by = null
where id = 'a2000000-0000-7000-8000-000000000002';
select is_empty($$ select 1 from pgmq.q_household_events $$, 'a check with no checked_by queues nothing');

insert into public.list_item_contributions (id, list_item_id, household_id, added_by) values
  ('a4000000-0000-7000-8000-000000000006', 'a2000000-0000-7000-8000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null);
select is_empty($$ select 1 from pgmq.q_household_events $$, 'a contribution with no added_by queues nothing');

insert into public.list_item_contributions (id, list_item_id, household_id, added_by, deleted_at) values
  ('a4000000-0000-7000-8000-000000000007', 'a2000000-0000-7000-8000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', now());
select is_empty($$ select 1 from pgmq.q_household_events $$, 'a contribution that arrives already deleted queues nothing');

update public.list_item_contributions set deleted_at = now() where id = 'a4000000-0000-7000-8000-000000000003';
update public.list_item_contributions set deleted_at = null where id = 'a4000000-0000-7000-8000-000000000003';
select is_empty($$ select 1 from pgmq.q_household_events $$, 'undoing and redoing an add (updates) queues nothing');

-- Merges (7.3) ------------------------------------------------------------------
-- Bread i5 is checked with contribution c8; bread i6 is open with contribution c9.
set local role authenticated;
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000005", "hlc": "1760000000100-0000-alex",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "bread", "display_name": "Bread", "checked_at": "2026-10-10T09:00:00Z", "checked_by": "11111111-1111-1111-1111-111111111111" } },
    { "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000008", "hlc": "1760000000100-0001-alex",
      "fields": { "list_item_id": "a2000000-0000-7000-8000-000000000005", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "added_by": "11111111-1111-1111-1111-111111111111" } },
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000006", "hlc": "1760000000100-0002-alex",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "bread", "display_name": "Sourdough" } },
    { "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000009", "hlc": "1760000000100-0003-alex",
      "fields": { "list_item_id": "a2000000-0000-7000-8000-000000000006", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "added_by": "11111111-1111-1111-1111-111111111111" } }
  ] $$),
  '[{"status": "applied"}, {"status": "applied"}, {"status": "applied"}, {"status": "applied"}]'::jsonb,
  'a checked bread and an open bread sync side by side');
reset role;
select results_eq(
  $$ select message ->> 'kind', message ->> 'contribution_id' from pgmq.q_household_events order by msg_id $$,
  $$ values ('items_added', 'a4000000-0000-7000-8000-000000000008'), ('items_added', 'a4000000-0000-7000-8000-000000000009') $$,
  'each contribution queues one event, and an item created already checked queues no shopping event');
delete from pgmq.q_household_events;

-- Unchecking i5 merges it into the open i6, re-pointing c8 with an update.
set local role authenticated;
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000005", "hlc": "1760000000200-0000-alex", "fields": { "checked_at": null, "checked_by": null } }
  ] $$),
  '[{"status": "merged", "merged_into": "a2000000-0000-7000-8000-000000000006"}]'::jsonb,
  'unchecking the bread merges it into the open one');
reset role;
select is(
  (select list_item_id from public.list_item_contributions where id = 'a4000000-0000-7000-8000-000000000008'),
  'a2000000-0000-7000-8000-000000000006'::uuid, 'the merged item''s contribution now points at the open item');
select is_empty($$ select 1 from pgmq.q_household_events $$, 'the merge queues no second event for the re-pointed contribution');

-- A new bread arriving with its contribution merges, and its one contribution queues once.
set local role authenticated;
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000007", "hlc": "1760000000300-0000-alex",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "bread", "display_name": "Bread" } },
    { "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000010", "hlc": "1760000000300-0001-alex",
      "fields": { "list_item_id": "a2000000-0000-7000-8000-000000000007", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "added_by": "11111111-1111-1111-1111-111111111111" } }
  ] $$),
  '[{"status": "merged", "merged_into": "a2000000-0000-7000-8000-000000000006"}, {"status": "applied"}]'::jsonb,
  'a second open bread merges, and its contribution applies');
reset role;
select results_eq(
  $$ select message ->> 'contribution_id', message ->> 'list_item_id' from pgmq.q_household_events $$,
  $$ values ('a4000000-0000-7000-8000-000000000010', 'a2000000-0000-7000-8000-000000000006') $$,
  'the merged add queues exactly one event, for the item it merged into');
delete from pgmq.q_household_events;

-- A check through apply_mutations ------------------------------------------------
set local role authenticated;
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000004", "hlc": "1760000000400-0000-alex",
      "fields": { "checked_at": "2026-10-10T12:00:00Z", "checked_by": "11111111-1111-1111-1111-111111111111" } }
  ] $$),
  '[{"status": "applied"}]'::jsonb, 'a check syncs');
reset role;
select results_eq(
  $$ select message ->> 'kind', message ->> 'actor', message ->> 'list_item_id' from pgmq.q_household_events $$,
  $$ values ('shopping', '11111111-1111-1111-1111-111111111111', 'a2000000-0000-7000-8000-000000000004') $$,
  'a synced check queues a shopping event');

-- A queue failure never fails the write ---------------------------------------------
select pgmq.drop_queue('household_events');

select lives_ok(
  $$ insert into public.list_item_contributions (id, list_item_id, household_id, added_by) values
       ('a4000000-0000-7000-8000-000000000011', 'a2000000-0000-7000-8000-000000000006', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222') $$,
  'an add succeeds when the queue is gone');
select is(
  (select count(*)::int from public.list_item_contributions where id = 'a4000000-0000-7000-8000-000000000011'),
  1, 'the add is kept');

select lives_ok(
  $$ update public.list_items set checked_at = '2026-10-10T13:00:00Z', checked_by = '22222222-2222-2222-2222-222222222222'
     where id = 'a2000000-0000-7000-8000-000000000003' $$,
  'a check succeeds when the queue is gone');
select is(
  (select checked_by from public.list_items where id = 'a2000000-0000-7000-8000-000000000003'),
  '22222222-2222-2222-2222-222222222222'::uuid, 'the check is kept');

set local role authenticated;
select is(
  public.apply_mutations($$ [
    { "table": "list_item_contributions", "id": "a4000000-0000-7000-8000-000000000012", "hlc": "1760000000500-0000-alex",
      "fields": { "list_item_id": "a2000000-0000-7000-8000-000000000006", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "added_by": "11111111-1111-1111-1111-111111111111" } }
  ] $$),
  '[{"status": "applied"}]'::jsonb, 'a synced add still applies when the queue is gone');
reset role;

select * from finish();
rollback;
