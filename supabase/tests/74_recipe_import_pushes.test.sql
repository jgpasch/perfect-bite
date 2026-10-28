-- "Recipe ready" and "Couldn't import" pushes (spec 4.13): a share import reaching `done` or
-- `failed` queues a `recipe_import` event on household_events; the worker re-reads the job through
-- recipe_import_notification and sends to recipe_import_recipients, the sharer's own tokens, as
-- their `recipe_imports` setting and quiet hours allow.
begin;
create extension if not exists pgtap with schema extensions;
select plan(33);

-- Fixtures (as postgres) ---------------------------------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'kim@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Smith home');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'member', 2);
insert into public.lists (id, household_id, name, position) values
  ('a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Groceries', 1);
insert into public.push_tokens (token, user_id, platform) values
  ('ExponentPushToken[alex-phone]', '11111111-1111-1111-1111-111111111111', 'ios'),
  ('ExponentPushToken[alex-ipad]', '11111111-1111-1111-1111-111111111111', 'ios'),
  ('ExponentPushToken[sam]', '22222222-2222-2222-2222-222222222222', 'ios'),
  ('ExponentPushToken[kim]', '33333333-3333-3333-3333-333333333333', 'ios');
delete from pgmq.q_household_events;

-- A share import in p_status under p_lease, as claim_share_import leaves it.
create function pg_temp.job(p_id uuid, p_status text, p_lease uuid, p_attempts int default 1) returns void language sql as $$
  insert into public.share_imports (id, user_id, household_id, list_id, add_to_list, url, url_key, payload_hash,
    page, status, attempts, lease_token, lease_expires_at)
  values (p_id, '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'a1000000-0000-7000-8000-000000000001', false, 'https://example.com/r', 'https://example.com/r', '\x00',
    '{"title": "Captured"}', p_status, p_attempts, p_lease, now() + interval '2 minutes');
$$;

create function pg_temp.queued() returns setof jsonb language sql as $$
  select message - 'at' from pgmq.q_household_events where message ->> 'kind' = 'recipe_import' order by msg_id
$$;

create function pg_temp.commit_recipe_only(p_id uuid, p_lease uuid, p_recipe uuid) returns jsonb language sql as $$
  select public.commit_share_import(p_id, p_lease,
    jsonb_build_object('household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'list_id', null, 'list_gone', false,
      'recipe_id', p_recipe, 'items_added', 0, 'items_combined', 0),
    jsonb_build_array(jsonb_build_object('op', 'insert', 'table', 'recipes', 'id', p_recipe,
      'fields', jsonb_build_object('household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'name', 'Lemon pasta',
        'source_url', 'https://example.com/r', 'total_minutes', null, 'steps', null, 'servings', 4, 'image_url', null))),
    jsonb_build_array(jsonb_build_object('kind', 'recipeAbsent', 'recipeId', p_recipe)));
$$;

-- The setting --------------------------------------------------------------------------------------
select col_not_null('public', 'notification_settings', 'recipe_imports', 'notification_settings.recipe_imports is not null');
select col_default_is('public', 'notification_settings', 'recipe_imports', 'true', 'and on by default');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;
insert into public.notification_settings (user_id) values ('11111111-1111-1111-1111-111111111111');
select is((select recipe_imports from public.notification_settings), true, 'a new row has recipe imports on');
update public.notification_settings set recipe_imports = false;
select is((select recipe_imports from public.notification_settings), false, 'the user turns their own recipe imports off');
update public.notification_settings set recipe_imports = true;
reset role;
select set_config('request.jwt.claims', '', true);

-- Privileges -------------------------------------------------------------------------------------
select ok(has_function_privilege('service_role', 'public.recipe_import_notification(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.recipe_import_recipients(uuid, timestamptz)', 'execute'),
  'the worker (service role) can read a job and its recipients');
select ok(not has_function_privilege('authenticated', 'public.recipe_import_notification(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.recipe_import_recipients(uuid, timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.recipe_import_notification(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.recipe_import_recipients(uuid, timestamptz)', 'execute'),
  'clients can''t');

-- Done ---------------------------------------------------------------------------------------------
select pg_temp.job('f0000000-0000-4000-8000-000000000001', 'committing', 'e0000000-0000-4000-8000-000000000001');
select is_empty($$ select * from pg_temp.queued() $$, 'a job being created or claimed queues nothing');

set local role service_role;
select pg_temp.commit_recipe_only('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001');
reset role;
select results_eq($$ select * from pg_temp.queued() $$,
  $$ values ('{"kind": "recipe_import", "share_import_id": "f0000000-0000-4000-8000-000000000001",
              "user_id": "11111111-1111-1111-1111-111111111111", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
              "status": "done"}'::jsonb) $$,
  'commit_share_import queues one recipe_import event for the sharer, status done');
select ok((select (message ->> 'at')::timestamptz = now() from pgmq.q_household_events where message ->> 'kind' = 'recipe_import'),
  'stamped with the commit''s time');

set local role service_role;
select pg_temp.commit_recipe_only('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001');
reset role;
select is((select count(*)::int from pg_temp.queued()), 1, 'a repeated commit (the stored receipt) queues nothing more');

set local role service_role;
select is(public.recipe_import_notification('f0000000-0000-4000-8000-000000000001'),
  '{"status": "done", "kind": "link", "user_id":"11111111-1111-1111-1111-111111111111", "recipe_id": "c0000000-0000-4000-8000-000000000001",
    "recipe_name": "Lemon pasta", "applied_list_id": null, "list_name": null, "household_name": "Smith home",
    "list_gone": false, "error_code": null, "resets_at": null}'::jsonb,
  'recipe_import_notification re-reads the job: a recipe-only import into Smith home');
select is(public.recipe_import_notification('f0000000-0000-4000-8000-0000000000ff'), null, 'and null for a job that''s gone');
reset role;

-- With the list, and with the list gone.
update public.share_imports set applied_list_id = 'a1000000-0000-7000-8000-000000000001', items_added = 3
where id = 'f0000000-0000-4000-8000-000000000001';
select results_eq(
  $$ select r ->> 'applied_list_id', r ->> 'list_name' from public.recipe_import_notification('f0000000-0000-4000-8000-000000000001') r $$,
  $$ values ('a1000000-0000-7000-8000-000000000001', 'Groceries') $$,
  'an import onto a list names it');
update public.lists set deleted_at = now() where id = 'a1000000-0000-7000-8000-000000000001';
select is(public.recipe_import_notification('f0000000-0000-4000-8000-000000000001') ->> 'list_name', null,
  'a list deleted since has no name');
update public.lists set deleted_at = null where id = 'a1000000-0000-7000-8000-000000000001';
update public.share_imports set applied_list_id = null, list_gone = true where id = 'f0000000-0000-4000-8000-000000000001';
select is((public.recipe_import_notification('f0000000-0000-4000-8000-000000000001') ->> 'list_gone')::boolean, true,
  'and list_gone is passed on');

-- A commit that fails queues nothing ----------------------------------------------------------------
delete from pgmq.q_household_events;
select pg_temp.job('f0000000-0000-4000-8000-000000000002', 'committing', 'e0000000-0000-4000-8000-000000000002');
set local role service_role;
select throws_ok(
  $$ select pg_temp.commit_recipe_only('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-0000000000ee',
       'c0000000-0000-4000-8000-000000000002') $$,
  '55000', null, 'a commit under a lost lease is refused');
reset role;
select is_empty($$ select * from pg_temp.queued() $$, 'and queues nothing');

-- Failed -------------------------------------------------------------------------------------------
set local role service_role;
select is(public.release_share_import('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000002',
  'transient', 'fetch_failed'), 'extracted', 'a transient failure with attempts left goes back');
reset role;
select is_empty($$ select * from pg_temp.queued() $$, 'and queues nothing');

select pg_temp.job('f0000000-0000-4000-8000-000000000003', 'extracting', 'e0000000-0000-4000-8000-000000000003');
set local role service_role;
select is(public.release_share_import('f0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000003',
  'waiting', 'rate_limited'), 'received', 'a rate-limited job waits');
reset role;
select is_empty($$ select * from pg_temp.queued() $$, 'and queues nothing');

select pg_temp.job('f0000000-0000-4000-8000-000000000004', 'extracting', 'e0000000-0000-4000-8000-000000000004');
set local role service_role;
select public.release_share_import('f0000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000004',
  'permanent', 'limit_reached', null, '2026-11-01T00:00:00Z');
reset role;
select results_eq($$ select * from pg_temp.queued() $$,
  $$ values ('{"kind": "recipe_import", "share_import_id": "f0000000-0000-4000-8000-000000000004",
              "user_id": "11111111-1111-1111-1111-111111111111", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
              "status": "failed"}'::jsonb) $$,
  'release_share_import failing a job queues a recipe_import event, status failed');
set local role service_role;
select results_eq(
  $$ select r ->> 'status', r ->> 'error_code', (r ->> 'resets_at')::timestamptz, r ->> 'recipe_id'
     from public.recipe_import_notification('f0000000-0000-4000-8000-000000000004') r $$,
  $$ values ('failed', 'limit_reached', '2026-11-01T00:00:00Z'::timestamptz, null) $$,
  'recipe_import_notification gives the reason and when the limit resets');
reset role;

-- A photo share's kind, so the worker words its not_a_recipe about the photo.
update public.share_imports
  set kind = 'photo', url = null, url_key = null, page_count = 2, images = null, error_code = 'not_a_recipe', resets_at = null
  where id = 'f0000000-0000-4000-8000-000000000004';
set local role service_role;
select results_eq(
  $$ select r ->> 'kind', r ->> 'status', r ->> 'error_code'
     from public.recipe_import_notification('f0000000-0000-4000-8000-000000000004') r $$,
  $$ values ('photo', 'failed', 'not_a_recipe') $$,
  'recipe_import_notification gives a photo share''s kind');
reset role;

delete from pgmq.q_household_events;
select pg_temp.job('f0000000-0000-4000-8000-000000000005', 'committing', 'e0000000-0000-4000-8000-000000000005', 8);
set local role service_role;
select is(public.release_share_import('f0000000-0000-4000-8000-000000000005', 'e0000000-0000-4000-8000-000000000005',
  'transient', 'internal'), 'failed', 'a transient failure on its 8th attempt fails');
reset role;
select is((select array_agg(m ->> 'status') from pg_temp.queued() m), array['failed'], 'and queues a failed event');

-- Try again puts it back: nothing is queued until it finishes again.
delete from pgmq.q_household_events;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select public.retry_share_import('f0000000-0000-4000-8000-000000000005');
reset role;
select set_config('request.jwt.claims', '', true);
select is_empty($$ select * from pg_temp.queued() $$, 'Try again queues nothing');
set local role service_role;
select is(public.recipe_import_notification('f0000000-0000-4000-8000-000000000005') ->> 'status', 'received',
  'and the job''s status no longer matches its earlier failed event, which the worker drops');
reset role;

-- Recipients ---------------------------------------------------------------------------------------
set local role service_role;
select results_eq(
  $$ select user_id, token from public.recipe_import_recipients('11111111-1111-1111-1111-111111111111', '2026-10-23T12:00:00Z') $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid, 'ExponentPushToken[alex-ipad]'),
            ('11111111-1111-1111-1111-111111111111'::uuid, 'ExponentPushToken[alex-phone]') $$,
  'the sharer''s own devices, every one, and no other member''s');
select results_eq(
  $$ select token from public.recipe_import_recipients('33333333-3333-3333-3333-333333333333', '2026-10-23T12:00:00Z') $$,
  $$ values ('ExponentPushToken[kim]') $$,
  'a user with no settings row gets the default: on, and needn''t be in the household');
reset role;

update public.notification_settings set recipe_imports = false where user_id = '11111111-1111-1111-1111-111111111111';
set local role service_role;
select is_empty($$ select 1 from public.recipe_import_recipients('11111111-1111-1111-1111-111111111111', '2026-10-23T12:00:00Z') $$,
  'nothing with recipe imports turned off');
reset role;

-- Quiet hours 22:00–07:00 in Mexico City (UTC-6 in late October 2026).
update public.notification_settings
set recipe_imports = true, quiet_hours_start = '22:00', quiet_hours_end = '07:00', time_zone = 'America/Mexico_City'
where user_id = '11111111-1111-1111-1111-111111111111';
set local role service_role;
select is_empty($$ select 1 from public.recipe_import_recipients('11111111-1111-1111-1111-111111111111', '2026-10-23T06:00:00Z') $$,
  'nothing in their quiet hours, in their own time zone (00:00 there)');
select is((select count(*)::int from public.recipe_import_recipients('11111111-1111-1111-1111-111111111111', '2026-10-23T18:00:00Z')), 2,
  'and both devices outside them (12:00 there)');
reset role;

select * from finish();
rollback;
