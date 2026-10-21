-- Portal functions for households (spec 4.12 Changing a household's plan): admin_set_household_plan,
-- admin_list_households and admin_household_detail.
begin;
create extension if not exists pgtap with schema extensions;
select plan(50);

-- Fixtures (as postgres) ------------------------------------------------------
-- Founding is the default here, as on hosted (supabase/seed.sql makes unlimited the default locally).
update public.plans set is_default = false where is_default;
update public.plans set is_default = true where id = 'founding';

-- Young (10 days old, founding) has ann (owner) and bo (member); Old (60 days old, free) has bo;
-- Bare (no household_plans row) has nobody.
insert into auth.users (id, email, aud, role, created_at, raw_user_meta_data) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'boss@hh.test', 'authenticated', 'authenticated', now() - interval '100 days', '{}'),
  ('11111111-1111-1111-1111-111111111111', 'Ann@HH.test', 'authenticated', 'authenticated', now() - interval '10 days', '{"full_name":"Quilla Ann"}'),
  ('22222222-2222-2222-2222-222222222222', 'bo@hh.test', 'authenticated', 'authenticated', now() - interval '60 days', '{}');
insert into private.admins (user_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
insert into public.households (id, name, created_at) values
  ('d1000000-0000-0000-0000-000000000001', 'Young Kitchen', now() - interval '10 days'),
  ('d2000000-0000-0000-0000-000000000002', 'Old Pantry', now() - interval '60 days'),
  ('d3000000-0000-0000-0000-000000000003', 'Bare 100%', now() - interval '70 days');
insert into public.household_members (household_id, user_id, role, position, joined_at) values
  ('d1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'owner', 1, now() - interval '10 days'),
  ('d1000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'member', 2, now() - interval '9 days'),
  ('d2000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'owner', 1, now() - interval '60 days');
insert into public.household_plans (household_id, plan_id) values
  ('d1000000-0000-0000-0000-000000000001', 'founding'),
  ('d2000000-0000-0000-0000-000000000002', 'free');

-- Young's imports: 6 this month, and a big day last month that mustn't count.
insert into private.household_ai_usage (household_id, feature, day, used) values
  ('d1000000-0000-0000-0000-000000000001', 'recipe_import', (now() at time zone 'utc')::date, 6),
  ('d1000000-0000-0000-0000-000000000001', 'recipe_import', date_trunc('month', now() at time zone 'utc')::date - 1, 1000);

-- 205 more households, to see the 200 cap.
insert into public.households (id, name, created_at)
select gen_random_uuid(), 'Bulk ' || n, now() - interval '200 days' - n * interval '1 minute'
from generate_series(1, 205) n;

create temporary table expected (key text primary key, n integer);
insert into expected values ('audit', (select count(*) from admin.admin_actions));
grant select on expected to authenticated;

-- Privileges -------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.admin_set_household_plan(uuid, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.admin_list_households(text, integer, integer)', 'execute')
  and not has_function_privilege('anon', 'public.admin_household_detail(uuid)', 'execute'),
  'anon can''t execute the household functions');
select ok(
  not has_function_privilege('service_role', 'public.admin_set_household_plan(uuid, text, text)', 'execute')
  and not has_function_privilege('service_role', 'public.admin_list_households(text, integer, integer)', 'execute')
  and not has_function_privilege('service_role', 'public.admin_household_detail(uuid)', 'execute'),
  'service_role can''t execute the household functions');
select ok(
  has_function_privilege('authenticated', 'public.admin_set_household_plan(uuid, text, text)', 'execute')
  and has_function_privilege('authenticated', 'public.admin_list_households(text, integer, integer)', 'execute')
  and has_function_privilege('authenticated', 'public.admin_household_detail(uuid)', 'execute'),
  'authenticated can execute the household functions');

-- A signed-in non-admin ----------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select * from public.admin_list_households() $$, '42501', 'not authorized',
  'admin_list_households refuses a non-admin');
select throws_ok($$ select public.admin_household_detail('d1000000-0000-0000-0000-000000000001') $$, '42501', 'not authorized',
  'admin_household_detail refuses a non-admin');
select throws_ok($$ select public.admin_set_household_plan('d1000000-0000-0000-0000-000000000001', 'unlimited', 'me') $$,
  '42501', 'not authorized', 'admin_set_household_plan refuses a non-admin, even a member');
reset role;
set local role anon;
select throws_ok($$ select * from public.admin_list_households() $$, '42501', null, 'anon can''t call admin_list_households');
reset role;
select is(
  (select row((select plan_id from public.household_plans where household_id = 'd1000000-0000-0000-0000-000000000001'),
              (select count(*)::int from admin.admin_actions) - (select n from expected where key = 'audit'))::text),
  row('founding', 0)::text, 'the refused calls changed nothing and wrote no audit row');

-- admin_list_households (as the admin) -------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);

select is((select array_agg(name) from public.admin_list_households('young KITCHEN')), array['Young Kitchen'],
  'search matches the household name case-insensitively');
select is((select array_agg(name) from public.admin_list_households('ann@hh')), array['Young Kitchen'],
  'search matches a member''s email case-insensitively');
select is((select array_agg(name) from public.admin_list_households('bo@hh.test')), array['Young Kitchen', 'Old Pantry'],
  'a member in two households finds both, newest first');
select is((select array_agg(name) from public.admin_list_households('quilla')), array['Young Kitchen'],
  'search matches a member''s display name');
select is((select array_agg(name) from public.admin_list_households('  d2000000-0000-0000-0000-000000000002 ')),
  array['Old Pantry'], 'a uuid (trimmed) matches the household id');
select is((select count(*)::int from public.admin_list_households('11111111-1111-1111-1111-111111111111')), 0,
  'a user id isn''t a household id');
select is((select array_agg(name) from public.admin_list_households('100%')), array['Bare 100%'],
  'LIKE wildcards in the search are literal');
select is((select count(*)::int from public.admin_list_households('%0')), 0,
  'a wildcard matches nothing it doesn''t contain');
select is(
  (select row(household_id, name, member_count, plan_id, plan_name)::text from public.admin_list_households('young')),
  row('d1000000-0000-0000-0000-000000000001'::uuid, 'Young Kitchen', 2, 'founding', 'Founding')::text,
  'a row has the id, name, member count and plan');
select is(
  (select row(member_count, plan_id, plan_name)::text from public.admin_list_households('bare')),
  row(0, null::text, null::text)::text, 'a household with no row and no members shows none of either');
select is((select count(*)::int from public.admin_list_households('bulk', 1000)), 200, 'p_limit is capped at 200');
select is((select distinct total_count::int from public.admin_list_households('bulk', 1000)), 205,
  'total_count isn''t capped');
select is((select array_agg(name) from public.admin_list_households('bulk', 2, 1)), array['Bulk 2', 'Bulk 3'],
  'p_limit and p_offset page, newest first');
select ok((select distinct total_count >= 208 from public.admin_list_households(null)), 'a null search lists every household');
select is((select distinct total_count from public.admin_list_households('  ')),
  (select distinct total_count from public.admin_list_households(null)), 'a blank search lists everyone too');

-- admin_household_detail ---------------------------------------------------------------
select throws_ok($$ select public.admin_household_detail('99999999-9999-9999-9999-999999999999') $$, 'P0002',
  'household not found', 'an unknown household raises household not found');

create temp table young as select public.admin_household_detail('d1000000-0000-0000-0000-000000000001') as d;
select is((select d - 'members' - 'usage' - 'plan_history' - 'first_month' - 'plan' - 'created_at' from young),
  '{"household_id": "d1000000-0000-0000-0000-000000000001", "name": "Young Kitchen"}'::jsonb, 'detail has the id and name');
select is((select (d ->> 'created_at')::timestamptz from young), now() - interval '10 days', 'and when it was made');
select is((select d -> 'first_month' from young),
  jsonb_build_object('doubled', true, 'ends_at', now() + interval '20 days'),
  'a 10-day-old household is in its first month, ending 30 days after it was made');
select is(
  (select jsonb_agg(m - 'joined_at') from young, jsonb_array_elements(d -> 'members') m),
  '[{"user_id": "11111111-1111-1111-1111-111111111111", "email": "Ann@HH.test", "display_name": "Quilla Ann", "role": "owner"},
    {"user_id": "22222222-2222-2222-2222-222222222222", "email": "bo@hh.test", "display_name": "bo", "role": "member"}]'::jsonb,
  'members, earliest joined first, with email, name and role');
select is((select (d -> 'plan') - 'assigned_at' from young), '{"id": "founding", "name": "Founding"}'::jsonb,
  'the plan');
select is(
  (select jsonb_agg(u order by o) from young, jsonb_array_elements(d -> 'usage') with ordinality as e (u, o)),
  jsonb_build_array(
    jsonb_build_object('feature', 'recipe_import', 'in_plan', true, 'used', 6, 'limit', 100,
      'resets_at', (date_trunc('month', now() at time zone 'utc') + interval '1 month') at time zone 'utc'),
    jsonb_build_object('feature', 'recipe_photo_ai', 'in_plan', true, 'used', 0, 'limit', 40,
      'resets_at', (date_trunc('month', now() at time zone 'utc') + interval '1 month') at time zone 'utc')),
  'usage: both features in order, this month only, against founding''s limits doubled, with the reset');
select is((select d -> 'plan_history' from young), '[]'::jsonb, 'no plan history yet');

select is(
  (select jsonb_build_object('first_month', d -> 'first_month' -> 'doubled', 'plan', d -> 'plan' ->> 'id',
                             'usage', (select jsonb_agg(u - 'resets_at') from jsonb_array_elements(d -> 'usage') u))
   from (select public.admin_household_detail('d2000000-0000-0000-0000-000000000002') as d) x),
  '{"first_month": false, "plan": "free",
    "usage": [{"feature": "recipe_import", "in_plan": false, "used": 0, "limit": 0},
              {"feature": "recipe_photo_ai", "in_plan": false, "used": 0, "limit": 0}]}'::jsonb,
  'a 60-day-old household on free: no first month, neither feature, limits 0');
select is(
  (select jsonb_build_object('plan', d -> 'plan', 'members', d -> 'members', 'in_plan', d -> 'usage' -> 0 -> 'in_plan')
   from (select public.admin_household_detail('d3000000-0000-0000-0000-000000000003') as d) x),
  '{"plan": null, "members": [], "in_plan": false}'::jsonb,
  'a household with no row has no plan and no features');

-- admin_set_household_plan -------------------------------------------------------------
select is(public.admin_set_household_plan('d1000000-0000-0000-0000-000000000001', 'unlimited', 'testing a cookbook'),
  '{"from": "founding", "to": "unlimited"}'::jsonb, 'setting a plan returns from and to');
reset role;
select is((select plan_id from public.household_plans where household_id = 'd1000000-0000-0000-0000-000000000001'),
  'unlimited', 'setting a plan writes household_plans');
select is(
  (select row(target_household_id, target_user_id, target_plan_id, details, note, performed_by)::text
   from admin.admin_actions where action = 'set_household_plan'),
  row('d1000000-0000-0000-0000-000000000001'::uuid, null::uuid, 'unlimited', '{"from": "founding", "to": "unlimited"}'::jsonb,
      'testing a cookbook', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')::text,
  'one audit row with the household, the plan, the note and the admin''s id');
select ok(public.has_feature('22222222-2222-2222-2222-222222222222', 'recipe_import', 'd1000000-0000-0000-0000-000000000001')
  and private.monthly_limit('recipe_import', 'd1000000-0000-0000-0000-000000000001') is null,
  'every member gets the new plan at once');
-- The next row must sort after this one: now() is fixed within the transaction.
update admin.admin_actions set created_at = now() - interval '1 minute' where action = 'set_household_plan';
set local role authenticated;

select is(public.admin_set_household_plan('d1000000-0000-0000-0000-000000000001', 'unlimited', 'same again'),
  '{"from": "unlimited", "to": "unlimited"}'::jsonb, 'setting the plan it''s on returns it as both');
select is(public.admin_set_household_plan('d3000000-0000-0000-0000-000000000003', 'free', 'give it a row'),
  '{"from": null, "to": "free"}'::jsonb, 'a household with no row gets one, from null');

select throws_ok($$ select public.admin_set_household_plan('d2000000-0000-0000-0000-000000000002', null, 'clear it') $$,
  '22023', 'plan required', 'a null plan is refused: a household''s plan can''t be cleared');
select throws_ok($$ select public.admin_set_household_plan('d2000000-0000-0000-0000-000000000002', 'gold', 'typo') $$,
  'P0002', 'plan not found', 'an unknown plan raises plan not found');
select throws_ok($$ select public.admin_set_household_plan('99999999-9999-9999-9999-999999999999', 'free', 'who') $$,
  'P0002', 'household not found', 'an unknown household raises household not found');
select throws_ok($$ select public.admin_set_household_plan(null, 'free', 'who') $$,
  'P0002', 'household not found', 'a null household raises household not found');
select throws_ok($$ select public.admin_set_household_plan('d2000000-0000-0000-0000-000000000002', 'founding', '  ') $$,
  '22023', 'note required', 'a blank note raises note required');
select throws_ok($$ select public.admin_set_household_plan('d2000000-0000-0000-0000-000000000002', 'founding', null) $$,
  '22023', 'note required', 'a null note raises note required');
reset role;
select is(
  (select row((select plan_id from public.household_plans where household_id = 'd2000000-0000-0000-0000-000000000002'),
              (select count(*)::int from admin.admin_actions where action = 'set_household_plan'))::text),
  row('free', 3)::text, 'the refused changes changed nothing and wrote no audit row');

-- Changing the default moves no household.
set local role authenticated;
select lives_ok($$ select public.admin_set_default_plan('unlimited', 'new households get everything') $$,
  'the default can change');
reset role;
select is(
  (select array_agg(plan_id order by household_id) from public.household_plans
   where household_id in ('d1000000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000002',
                          'd3000000-0000-0000-0000-000000000003')),
  array['unlimited', 'free', 'free'], 'and every household keeps its plan');

-- plan_history: newest first, with the admin's email, null for a dashboard row ------------------
insert into admin.admin_actions (action, target_household_id, details, note, created_at)
values ('set_household_plan', 'd1000000-0000-0000-0000-000000000001', '{"from": null, "to": "founding"}', 'from the dashboard',
  now() - interval '1 hour');
set local role authenticated;
select is(
  (select jsonb_agg(jsonb_build_object('note', h ->> 'note', 'by', h ->> 'performed_by', 'email', h ->> 'performed_by_email',
                                       'to', h -> 'details' ->> 'to'))
   from jsonb_array_elements(public.admin_household_detail('d1000000-0000-0000-0000-000000000001') -> 'plan_history') h),
  '[{"note": "same again", "by": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "email": "boss@hh.test", "to": "unlimited"},
    {"note": "testing a cookbook", "by": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "email": "boss@hh.test", "to": "unlimited"},
    {"note": "from the dashboard", "by": "postgres", "email": null, "to": "founding"}]'::jsonb,
  'plan_history is the household''s own, newest first, with the admin''s email');
select is(
  (select array_agg(row(plan_id, plan_name)::text) from public.admin_list_households('young')),
  array[row('unlimited', 'Unlimited')::text], 'the list shows the new plan');
reset role;

select * from finish();
rollback;
