-- Portal functions for users (spec 4.12): admin_list_users, admin_user_detail and
-- admin_set_user_plan, and private.first_month_ends_at (per household) behind private.monthly_limit.
begin;
create extension if not exists pgtap with schema extensions;
select plan(54);

-- Fixtures (as postgres) ------------------------------------------------------
-- Founding is the default here, as on hosted (supabase/seed.sql makes unlimited the default locally).
update public.plans set is_default = false where is_default;
update public.plans set is_default = true where id = 'founding';

-- young: founding by default, 10 days old. mid: free, 20 days old. old: default, 60 days old.
insert into auth.users (id, email, aud, role, created_at, raw_user_meta_data) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'boss@portal.test', 'authenticated', 'authenticated', now() - interval '100 days', '{}'),
  ('11111111-1111-1111-1111-111111111111', 'Zed.Young@portal.test', 'authenticated', 'authenticated', now() - interval '10 days', '{"full_name":"Quixote Young"}'),
  ('22222222-2222-2222-2222-222222222222', 'zed.mid@portal.test', 'authenticated', 'authenticated', now() - interval '20 days', '{}'),
  ('33333333-3333-3333-3333-333333333333', 'zed.old@portal.test', 'authenticated', 'authenticated', now() - interval '60 days', '{}');
insert into private.admins (user_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
insert into public.user_plans (user_id, plan_id) values ('22222222-2222-2222-2222-222222222222', 'free');

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
  and not has_function_privilege('anon', 'public.admin_user_detail(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.admin_set_user_plan(uuid, text, text)', 'execute'),
  'anon can''t execute the user functions');
select ok(
  not has_function_privilege('service_role', 'public.admin_list_users(text, integer, integer, boolean)', 'execute')
  and not has_function_privilege('service_role', 'public.admin_user_detail(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.admin_set_user_plan(uuid, text, text)', 'execute'),
  'service_role can''t execute the user functions');
select ok(
  has_function_privilege('authenticated', 'public.admin_list_users(text, integer, integer, boolean)', 'execute')
  and has_function_privilege('authenticated', 'public.admin_user_detail(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.admin_set_user_plan(uuid, text, text)', 'execute'),
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
select is(private.monthly_limit('11111111-1111-1111-1111-111111111111'::uuid, 'recipe_import'), 100,
  'monthly_limit still doubles in a household''s first month');
select is(private.monthly_limit('33333333-3333-3333-3333-333333333333'::uuid, 'recipe_import'), 50,
  'monthly_limit doesn''t double after it');

-- A signed-in non-admin ----------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select * from public.admin_list_users() $$, '42501', 'not authorized',
  'admin_list_users refuses a non-admin');
select throws_ok($$ select public.admin_user_detail('11111111-1111-1111-1111-111111111111') $$, '42501', 'not authorized',
  'admin_user_detail refuses a non-admin');
select throws_ok($$ select public.admin_set_user_plan('11111111-1111-1111-1111-111111111111', 'unlimited', 'me') $$,
  '42501', 'not authorized', 'admin_set_user_plan refuses a non-admin');
reset role;
select is((select plan_id from public.user_plans where user_id = '11111111-1111-1111-1111-111111111111'), null,
  'the refused plan change changed nothing');

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
  (select row(plan_id, plan_assigned, assigned_at)::text from public.admin_list_users('zed.old')),
  row('founding', false, null::timestamptz)::text, 'a defaulted user shows the default plan, not assigned');
select is(
  (select row(plan_id, plan_assigned, display_name)::text from public.admin_list_users('zed.mid')),
  row('free', true, 'zed.mid')::text, 'an assigned user shows their plan, assigned');

-- admin_user_detail -----------------------------------------------------------------
select throws_ok($$ select public.admin_user_detail('99999999-9999-9999-9999-999999999999') $$, 'P0002', 'user not found',
  'admin_user_detail raises user not found');

reset role;
create temp table young as
  select public.admin_user_detail('11111111-1111-1111-1111-111111111111') as d;

select is((select d ->> 'email' from young), 'Zed.Young@portal.test', 'detail has the email');
select is((select d -> 'plan' from young),
  '{"id": "founding", "name": "Founding", "assigned": false, "assigned_at": null}'::jsonb,
  'a defaulted user''s plan is the default, not assigned');
select is((select (d -> 'first_month' ->> 'doubled')::boolean from young), true,
  'a user whose oldest household is 10 days old is doubled');
select is((select (d -> 'first_month' ->> 'ends_at')::timestamptz from young), now() + interval '20 days',
  'first month ends 30 days after the user''s oldest household was made');
select is(
  (select array_agg(u ->> 'feature' order by o) from young, jsonb_array_elements(d -> 'usage') with ordinality as e (u, o)),
  array['recipe_import', 'recipe_photo_ai'],
  'usage lists the two features in order');
select is(
  (select u from young, jsonb_array_elements(d -> 'usage') u where u ->> 'feature' = 'recipe_import'),
  jsonb_build_object('feature', 'recipe_import', 'in_plan', true, 'used', 5, 'limit', 100,
    'resets_at', (date_trunc('month', now() at time zone 'utc') + interval '1 month') at time zone 'utc'),
  'recipe_import counts only this month, with founding''s limit doubled and the reset');
select is(
  (select u - 'resets_at' from young, jsonb_array_elements(d -> 'usage') u where u ->> 'feature' = 'recipe_photo_ai'),
  '{"feature": "recipe_photo_ai", "in_plan": true, "used": 0, "limit": 40}'::jsonb,
  'recipe_photo_ai''s limit is doubled too');
select is(
  (select d -> 'households' from young),
  '[{"id": "d2000000-0000-0000-0000-000000000002", "name": "Second", "role": "member", "member_count": 2},
    {"id": "d1000000-0000-0000-0000-000000000001", "name": "First", "role": "owner", "member_count": 1}]'::jsonb,
  'households in the user''s order, with role and member count');
select is((select d -> 'plan_history' from young), '[]'::jsonb, 'no plan history yet');
set local role authenticated;

select is(
  (select u from jsonb_array_elements(public.admin_user_detail('22222222-2222-2222-2222-222222222222') -> 'usage') u
   where u ->> 'feature' = 'recipe_import') - 'resets_at',
  '{"feature": "recipe_import", "in_plan": false, "used": 0, "limit": 0}'::jsonb,
  'a feature in none of the user''s households'' plans reads in_plan false with limit 0');
select is(
  public.admin_user_detail('33333333-3333-3333-3333-333333333333') -> 'first_month' -> 'doubled',
  'false'::jsonb, 'a user whose oldest household is 60 days old isn''t doubled');

-- admin_set_user_plan ---------------------------------------------------------------
select is(public.admin_set_user_plan('11111111-1111-1111-1111-111111111111', 'free', 'asked for less'),
  '{"from": null, "to": "free"}'::jsonb, 'setting a plan returns from and to');
reset role;
select is((select plan_id from public.user_plans where user_id = '11111111-1111-1111-1111-111111111111'), 'free',
  'setting a plan writes user_plans');
select is(
  (select row(target_plan_id, details, note, performed_by)::text from admin.admin_actions
   where action = 'set_user_plan' and target_user_id = '11111111-1111-1111-1111-111111111111'),
  row('free', '{"from": null, "to": "free"}'::jsonb, 'asked for less', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')::text,
  'one audit row with the admin''s id');
-- The next row must sort after this one: now() is fixed within the transaction.
update admin.admin_actions set created_at = now() - interval '1 minute'
where action = 'set_user_plan' and target_user_id = '11111111-1111-1111-1111-111111111111';

set local role authenticated;
select is(public.admin_set_user_plan('11111111-1111-1111-1111-111111111111', null, 'back to default'),
  '{"from": "free", "to": null}'::jsonb, 'setting null returns to null');
reset role;
select is((select count(*)::int from public.user_plans where user_id = '11111111-1111-1111-1111-111111111111'), 0,
  'setting null deletes the user_plans row');
select is((select count(*)::int from admin.admin_actions
  where action = 'set_user_plan' and target_user_id = '11111111-1111-1111-1111-111111111111'), 2,
  'setting null writes one more audit row');

set local role authenticated;
select is(public.admin_set_user_plan('22222222-2222-2222-2222-222222222222', 'free', 'same again'),
  '{"from": "free", "to": "free"}'::jsonb, 'setting the plan they''re on returns it as both');
select is((select count(*)::int from public.admin_list_users('zed.mid') where plan_id = 'free'), 1,
  'and they stay on it');

select throws_ok($$ select public.admin_set_user_plan('22222222-2222-2222-2222-222222222222', 'gold', 'typo') $$,
  'P0002', 'plan not found', 'an unknown plan raises plan not found');
select throws_ok($$ select public.admin_set_user_plan('22222222-2222-2222-2222-222222222222', 'founding', '   ') $$,
  '22023', 'note required', 'a blank note raises note required');
select throws_ok($$ select public.admin_set_user_plan('22222222-2222-2222-2222-222222222222', 'founding', null) $$,
  '22023', 'note required', 'a null note raises note required');
select throws_ok($$ select public.admin_set_user_plan('99999999-9999-9999-9999-999999999999', 'founding', 'who') $$,
  'P0002', 'user not found', 'an unknown user raises user not found');
reset role;
select is(
  (select row(
    (select plan_id from public.user_plans where user_id = '22222222-2222-2222-2222-222222222222'),
    (select count(*) from admin.admin_actions where action = 'set_user_plan'
       and target_user_id = '22222222-2222-2222-2222-222222222222'))::text),
  row('free', 1::bigint)::text, 'the refused changes changed nothing and wrote no audit row');

-- plan_history: newest first, with the admin's email, and null for a dashboard row ---------------
insert into admin.admin_actions (action, target_user_id, details, note, created_at)
values ('set_user_plan', '11111111-1111-1111-1111-111111111111', '{"from": null, "to": "founding"}', 'from the dashboard',
  now() - interval '1 hour');
set local role authenticated;
select is(
  (select jsonb_agg(jsonb_build_object('note', h ->> 'note', 'by', h ->> 'performed_by', 'email', h ->> 'performed_by_email'))
   from jsonb_array_elements(public.admin_user_detail('11111111-1111-1111-1111-111111111111') -> 'plan_history') h),
  '[{"note": "back to default", "by": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "email": "boss@portal.test"},
    {"note": "asked for less", "by": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "email": "boss@portal.test"},
    {"note": "from the dashboard", "by": "postgres", "email": null}]'::jsonb,
  'plan_history is newest first, with the admin''s email');
reset role;

select * from finish();
rollback;
