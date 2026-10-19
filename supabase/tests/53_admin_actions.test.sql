-- Portal function for activity: admin_list_actions.
begin;
create extension if not exists pgtap with schema extensions;
select plan(33);

-- Fixtures (as postgres) ------------------------------------------------------
-- boss is the admin; gone was deleted (only their audit row is left); kept still exists.
delete from admin.admin_actions;
insert into auth.users (id, email, aud, role, created_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'boss@portal.test', 'authenticated', 'authenticated', now() - interval '100 days'),
  ('11111111-1111-1111-1111-111111111111', 'kept@portal.test', 'authenticated', 'authenticated', now() - interval '50 days'),
  ('22222222-2222-2222-2222-222222222222', 'gone@portal.test', 'authenticated', 'authenticated', now() - interval '50 days');
insert into private.admins (user_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- Oldest to newest: a dashboard delete_user (performed_by postgres) of gone, the app's
-- delete_account, a portal set_user_plan on kept, a portal rename_plan, and a second set_user_plan
-- by an admin id that no longer exists.
insert into admin.admin_actions (id, action, target_user_id, target_household_id, target_plan_id, details, note, performed_by, created_at) values
  ('a0000000-0000-0000-0000-000000000001', 'delete_user', '22222222-2222-2222-2222-222222222222', null, null,
   '{"households":1}', 'asked by email', 'postgres', now() - interval '5 days'),
  ('a0000000-0000-0000-0000-000000000002', 'delete_account', '33333333-3333-3333-3333-333333333333', 'd1000000-0000-0000-0000-000000000001', null,
   '{}', null, 'authenticator', now() - interval '4 days'),
  ('a0000000-0000-0000-0000-000000000003', 'set_user_plan', '11111111-1111-1111-1111-111111111111', null, 'unlimited',
   '{"from":null,"to":"unlimited"}', 'friend', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now() - interval '3 days'),
  ('a0000000-0000-0000-0000-000000000004', 'rename_plan', null, null, 'basic',
   '{"before":{"name":"Basic"},"after":{"name":"Starter"}}', 'clearer', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now() - interval '2 days'),
  ('a0000000-0000-0000-0000-000000000005', 'set_user_plan', '11111111-1111-1111-1111-111111111111', null, null,
   '{"from":"unlimited","to":null}', 'back', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', now() - interval '1 day');
delete from auth.users where id = '22222222-2222-2222-2222-222222222222';

-- 205 more rows, to see the 200 cap.
insert into admin.admin_actions (action, performed_by, created_at)
select 'bulk', 'postgres', now() - interval '30 days' - n * interval '1 minute'
from generate_series(1, 205) n;

-- Privileges -------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.admin_list_actions(text, integer, integer)', 'execute'),
  'anon can''t execute admin_list_actions');
select ok(not has_function_privilege('service_role', 'public.admin_list_actions(text, integer, integer)', 'execute'),
  'service_role can''t execute admin_list_actions');
select ok(has_function_privilege('authenticated', 'public.admin_list_actions(text, integer, integer)', 'execute'),
  'authenticated can execute admin_list_actions');

-- A signed-in non-admin, and no user --------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select public.admin_list_actions() $$, '42501', 'not authorized',
  'admin_list_actions refuses a non-admin');
select set_config('request.jwt.claims', '', true);
select throws_ok($$ select public.admin_list_actions() $$, '42501', 'not authorized',
  'admin_list_actions refuses no user');

-- The admin ----------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);

select is((public.admin_list_actions() ->> 'total_count')::int, 210, 'total_count counts every row');
select is(jsonb_array_length(public.admin_list_actions() -> 'actions'), 50, 'the default page is 50');
select is(jsonb_array_length(public.admin_list_actions(null, 1000) -> 'actions'), 200, 'p_limit is capped at 200');
select is(jsonb_array_length(public.admin_list_actions(null, 1000, 200) -> 'actions'), 10, 'the last page has what''s left');
select is(jsonb_array_length(public.admin_list_actions(null, 0) -> 'actions'), 0, 'a limit of 0 returns no rows');
select is((public.admin_list_actions(null, 0) ->> 'total_count')::int, 210, 'but still the total');

select is(
  (select array_agg(e ->> 'action' order by o) from jsonb_array_elements(public.admin_list_actions(null, 6) -> 'actions') with ordinality as t (e, o)),
  array['set_user_plan', 'rename_plan', 'set_user_plan', 'delete_account', 'delete_user', 'bulk'],
  'newest first, every kind of action');
select is(
  (select array_agg(e ->> 'id' order by o) from jsonb_array_elements(public.admin_list_actions(null, 2, 1) -> 'actions') with ordinality as t (e, o)),
  array['a0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000003'],
  'p_offset skips the newest');

select is((public.admin_list_actions('set_user_plan') ->> 'total_count')::int, 2, 'p_action filters the total');
select is(
  (select array_agg(e ->> 'id' order by o) from jsonb_array_elements(public.admin_list_actions('set_user_plan') -> 'actions') with ordinality as t (e, o)),
  array['a0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000003'],
  'p_action filters the rows, newest first');
select is(
  (select array_agg(e ->> 'id' order by o) from jsonb_array_elements(public.admin_list_actions('set_user_plan', 1, 1) -> 'actions') with ordinality as t (e, o)),
  array['a0000000-0000-0000-0000-000000000003'],
  'paging applies within the filter');
select is(public.admin_list_actions('nothing_like_it'), '{"actions":[],"total_count":0}'::jsonb,
  'an action with no rows gives an empty list');
select is((public.admin_list_actions('  ') ->> 'total_count')::int, 210, 'a blank p_action is no filter');

-- One row's fields.
select is(
  (public.admin_list_actions('set_user_plan', 1, 1) -> 'actions' -> 0) - 'created_at',
  jsonb_build_object(
    'id', 'a0000000-0000-0000-0000-000000000003',
    'action', 'set_user_plan',
    'target_user_id', '11111111-1111-1111-1111-111111111111',
    'target_user_email', 'kept@portal.test',
    'target_household_id', null,
    'target_plan_id', 'unlimited',
    'details', '{"from":null,"to":"unlimited"}'::jsonb,
    'note', 'friend',
    'performed_by', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'performed_by_email', 'boss@portal.test'
  ),
  'a portal row has every field, with both emails');
select is((public.admin_list_actions('set_user_plan', 1, 1) -> 'actions' -> 0 ->> 'created_at')::timestamptz, now() - interval '3 days',
  'created_at comes through');

select is(public.admin_list_actions('delete_user') -> 'actions' -> 0 ->> 'performed_by', 'postgres',
  'a dashboard row keeps performed_by postgres');
select ok(public.admin_list_actions('delete_user') -> 'actions' -> 0 ? 'performed_by_email', 'performed_by_email is always present');
select is(public.admin_list_actions('delete_user') -> 'actions' -> 0 ->> 'performed_by_email', null,
  'a postgres row has a null performed_by_email');
select is(public.admin_list_actions('delete_user') -> 'actions' -> 0 ->> 'target_user_id', '22222222-2222-2222-2222-222222222222',
  'a deleted target keeps their id');
select is(public.admin_list_actions('delete_user') -> 'actions' -> 0 ->> 'target_user_email', null,
  'a deleted target user''s email is null');
select is(public.admin_list_actions('delete_user') -> 'actions' -> 0 ->> 'note', 'asked by email', 'the note comes through');

select is(public.admin_list_actions('delete_account') -> 'actions' -> 0 ->> 'target_household_id', 'd1000000-0000-0000-0000-000000000001',
  'target_household_id comes through');
select is(public.admin_list_actions('delete_account') -> 'actions' -> 0 ->> 'performed_by_email', null,
  'a non-uuid performed_by has a null email');
select is(public.admin_list_actions('delete_account') -> 'actions' -> 0 ->> 'note', null, 'a null note stays null');

select is(public.admin_list_actions('rename_plan') -> 'actions' -> 0 ->> 'target_user_id', null, 'a plan action has no target user');
select is(public.admin_list_actions('rename_plan') -> 'actions' -> 0 -> 'details' -> 'after' ->> 'name', 'Starter', 'details come through');

select is(public.admin_list_actions('set_user_plan', 1) -> 'actions' -> 0 ->> 'performed_by_email', null,
  'an admin id that no longer exists has a null performed_by_email');

-- Reading writes nothing.
reset role;
select is((select count(*)::int from admin.admin_actions), 210, 'listing writes no audit row');

select * from finish();
rollback;
