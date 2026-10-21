-- Portal functions for users (spec 4.12): admin_list_users and admin_user_detail (no plan of the
-- user's own: their households, each with its plan; admin_set_user_plan is dropped), and
-- private.first_month_ends_at (per household) behind private.monthly_limit.
begin;
create extension if not exists pgtap with schema extensions;
select plan(32);

-- Fixtures (as postgres) ------------------------------------------------------
-- Founding is the default here, as on hosted (supabase/seed.sql makes unlimited the default locally).
update public.plans set is_default = false where is_default;
update public.plans set is_default = true where id = 'founding';

-- young: 10 days old. mid: 20 days old, in no household. old: 60 days old.
insert into auth.users (id, email, aud, role, created_at, raw_user_meta_data) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'boss@portal.test', 'authenticated', 'authenticated', now() - interval '100 days', '{}'),
  ('11111111-1111-1111-1111-111111111111', 'Zed.Young@portal.test', 'authenticated', 'authenticated', now() - interval '10 days', '{"full_name":"Quixote Young"}'),
  ('22222222-2222-2222-2222-222222222222', 'zed.mid@portal.test', 'authenticated', 'authenticated', now() - interval '20 days', '{}'),
  ('33333333-3333-3333-3333-333333333333', 'zed.old@portal.test', 'authenticated', 'authenticated', now() - interval '60 days', '{}');
insert into private.admins (user_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- 205 more users, to see the 200 cap.
insert into auth.users (id, email, aud, role, created_at)
select gen_random_uuid(), 'bulk' || n || '@cap.test', 'authenticated', 'authenticated', now() - n * interval '1 minute'
from generate_series(1, 205) n;

-- young's usage: today, and a big day last month that mustn't count.
insert into private.recipe_import_usage (user_id, day, minute_start, imports) values
  ('11111111-1111-1111-1111-111111111111', (now() at time zone 'utc')::date, now() - interval '1 hour', 5),
  ('11111111-1111-1111-1111-111111111111', date_trunc('month', now() at time zone 'utc')::date - 1, now() - interval '1 hour', 1000);

-- young is in two households: Second comes first in their order and has two members. Limits and
-- the first month are per household now: First (founding, 10 days old) is young's oldest; Second
-- (free, 5 days old) has no features, so it neither lowers nor raises young's limits; Old
-- (founding, 60 days old) is old's oldest household and the only one of theirs with features.
insert into public.households (id, name, created_at) values
  ('d1000000-0000-0000-0000-000000000001', 'First', now() - interval '10 days'),
  ('d2000000-0000-0000-0000-000000000002', 'Second', now() - interval '5 days'),
  ('d3000000-0000-0000-0000-000000000003', 'Old', now() - interval '60 days');
insert into public.household_members (household_id, user_id, role, position) values
  ('d1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'owner', 2),
  ('d2000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'member', 1),
  ('d2000000-0000-0000-0000-000000000002', '33333333-3333-3333-3333-333333333333', 'owner', 2),
  ('d3000000-0000-0000-0000-000000000003', '33333333-3333-3333-3333-333333333333', 'owner', 1);
insert into public.household_plans (household_id, plan_id) values
  ('d1000000-0000-0000-0000-000000000001', 'founding'),
  ('d2000000-0000-0000-0000-000000000002', 'free'),
  ('d3000000-0000-0000-0000-000000000003', 'founding');

-- Privileges -------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.admin_list_users(text, integer, integer, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.admin_user_detail(uuid)', 'execute'),
  'anon can''t execute the user functions');
select ok(
  not has_function_privilege('service_role', 'public.admin_list_users(text, integer, integer, boolean)', 'execute')
  and not has_function_privilege('service_role', 'public.admin_user_detail(uuid)', 'execute'),
  'service_role can''t execute the user functions');
select ok(
  has_function_privilege('authenticated', 'public.admin_list_users(text, integer, integer, boolean)', 'execute')
  and has_function_privilege('authenticated', 'public.admin_user_detail(uuid)', 'execute'),
  'authenticated can execute the user functions');
select ok(
  not has_function_privilege('authenticated', 'private.first_month_ends_at(uuid)', 'execute')
  and not has_function_privilege('service_role', 'private.first_month_ends_at(uuid)', 'execute'),
  'no client role can execute first_month_ends_at');

-- first_month_ends_at and monthly_limit (as postgres) --------------------------------
select is(private.first_month_ends_at('d1000000-0000-0000-0000-000000000001'), now() + interval '20 days',
  'first_month_ends_at is the household''s created_at plus 30 days');
select is(private.first_month_ends_at('99999999-9999-9999-9999-999999999999'), null,
  'first_month_ends_at is null for an unknown household');
select is(private.monthly_limit('recipe_import', 'd1000000-0000-0000-0000-000000000001'), 100,
  'monthly_limit still doubles in a household''s first month');
select is(private.monthly_limit('recipe_import', 'd3000000-0000-0000-0000-000000000003'), 50,
  'monthly_limit doesn''t double after it');

-- A signed-in non-admin ----------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select * from public.admin_list_users() $$, '42501', 'not authorized',
  'admin_list_users refuses a non-admin');
select throws_ok($$ select public.admin_user_detail('11111111-1111-1111-1111-111111111111') $$, '42501', 'not authorized',
  'admin_user_detail refuses a non-admin');
reset role;

set local role anon;
select throws_ok($$ select * from public.admin_list_users() $$, '42501', null, 'anon can''t call admin_list_users');
reset role;

-- admin_list_users (as the admin) -----------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);

select is(
  (select array_agg(email order by created_at desc) from public.admin_list_users('ZED')),
  array['Zed.Young@portal.test', 'zed.mid@portal.test', 'zed.old@portal.test'],
  'search matches email case-insensitively');
select is(
  (select array_agg(email) from public.admin_list_users('ZED')),
  array['Zed.Young@portal.test', 'zed.mid@portal.test', 'zed.old@portal.test'],
  'newest first');
select is((select array_agg(email) from public.admin_list_users('quixote')), array['Zed.Young@portal.test'],
  'search matches the display name');
select is((select array_agg(email) from public.admin_list_users('  zed.mid  ')), array['zed.mid@portal.test'],
  'search is trimmed');
select is((select array_agg(email) from public.admin_list_users('22222222-2222-2222-2222-222222222222')),
  array['zed.mid@portal.test'], 'a uuid matches the user id');
select is((select count(*)::int from public.admin_list_users('99999999-9999-9999-9999-999999999999')), 0,
  'an unknown uuid matches nobody');
select is((select count(*)::int from public.admin_list_users('a_%')), 0,
  'LIKE wildcards in the search are literal');
select is(
  (select array_agg(email) from public.admin_list_users('zed', 2, 0)),
  array['Zed.Young@portal.test', 'zed.mid@portal.test'], 'p_limit pages');
select is(
  (select array_agg(email) from public.admin_list_users('zed', 2, 2)),
  array['zed.old@portal.test'], 'p_offset pages');
select is((select distinct total_count::int from public.admin_list_users('zed', 2, 2)), 3,
  'total_count is the matches before paging');
select is((select count(*)::int from public.admin_list_users('cap.test', 1000)), 200, 'p_limit is capped at 200');
select is((select distinct total_count::int from public.admin_list_users('cap.test', 1000)), 205,
  'total_count isn''t capped');
select ok((select distinct total_count >= 209 from public.admin_list_users(null)),
  'a null search lists everyone');
select is(
  (select array_agg(k order by k) from public.admin_list_users('zed.mid') r, jsonb_object_keys(to_jsonb(r)) k),
  array['ai_photos_blocked', 'created_at', 'display_name', 'email', 'last_sign_in_at', 'total_count', 'user_id'],
  'a row has no plan columns: a user has no plan of their own');

-- admin_user_detail -----------------------------------------------------------------
select throws_ok($$ select public.admin_user_detail('99999999-9999-9999-9999-999999999999') $$, 'P0002', 'user not found',
  'admin_user_detail raises user not found');

reset role;
create temp table young as
  select public.admin_user_detail('11111111-1111-1111-1111-111111111111') as d;

select is((select d ->> 'email' from young), 'Zed.Young@portal.test', 'detail has the email');
select is(
  (select array_agg(k order by k) from young, jsonb_object_keys(d) k),
  array['ai_flags', 'ai_photo_block', 'ai_photo_refusals_30d', 'created_at', 'display_name', 'email',
        'households', 'last_sign_in_at', 'user_id'],
  'the detail has no plan, first month, usage or plan history of the user''s own');
select is(
  (select d -> 'households' from young),
  '[{"id": "d2000000-0000-0000-0000-000000000002", "name": "Second", "role": "member", "member_count": 2,
     "plan_id": "free", "plan_name": "Free"},
    {"id": "d1000000-0000-0000-0000-000000000001", "name": "First", "role": "owner", "member_count": 1,
     "plan_id": "founding", "plan_name": "Founding"}]'::jsonb,
  'households in the user''s order, with role, member count and each one''s plan');
delete from public.household_plans where household_id = 'd2000000-0000-0000-0000-000000000002';
select is(
  (select h - 'member_count' - 'role' from jsonb_array_elements(public.admin_user_detail('11111111-1111-1111-1111-111111111111') -> 'households') h
   where h ->> 'name' = 'Second'),
  '{"id": "d2000000-0000-0000-0000-000000000002", "name": "Second", "plan_id": null, "plan_name": null}'::jsonb,
  'a household with no row has no plan');
insert into public.household_plans (household_id, plan_id) values ('d2000000-0000-0000-0000-000000000002', 'free');
set local role authenticated;

select is(public.admin_user_detail('22222222-2222-2222-2222-222222222222') -> 'households', '[]'::jsonb,
  'a user in no household has none listed');

-- Per-user plans are gone ------------------------------------------------------------
reset role;
select ok(to_regprocedure('public.admin_set_user_plan(uuid, text, text)') is null,
  'admin_set_user_plan is dropped: a user has no plan of their own');

select * from finish();
rollback;
