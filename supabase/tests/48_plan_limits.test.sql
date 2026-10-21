-- Monthly limits per plan and household (spec 4.12, 5, 6.1, 6.6–6.11): public.plan_limits and its
-- seed, private.monthly_limit per household (the plan, the first-month doubling by household age),
-- private.household_ai_usage and private.monthly_usage per household, each limit function's
-- 'monthly_limit' answer against the household's allowance (shared by its members, link and photo
-- imports together; a null household is the user's oldest), and the AI photo monthly limit.
-- Categorize, tags and step matching have no monthly limit and no household counts.
-- now() is fixed within the transaction, so a month's usage is seeded straight into the usage
-- tables: spread over the month's first three days (any of them may be today or later, which still
-- counts) plus a big day last month that mustn't count.
begin;
create extension if not exists pgtap with schema extensions;
select plan(85);

-- Fixtures (as postgres) ------------------------------------------------------
-- Each user owns one household: Fay a founding one 60 days old, Uma an unlimited one, Rex a free
-- one, Yan a founding one 29 days old, Oli a founding one 31 days old. Ned is in no household;
-- Nia's household has no household_plans row. Gus owns a founding household 90 days old (B) and is
-- a member of Fay's (A), so Fay's is his newer one.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'fay@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'rex@test.local', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'uma@test.local', 'authenticated', 'authenticated'),
  ('44444444-4444-4444-4444-444444444444', 'yan@test.local', 'authenticated', 'authenticated'),
  ('55555555-5555-5555-5555-555555555555', 'oli@test.local', 'authenticated', 'authenticated'),
  ('66666666-6666-6666-6666-666666666666', 'ned@test.local', 'authenticated', 'authenticated'),
  ('77777777-7777-7777-7777-777777777777', 'nia@test.local', 'authenticated', 'authenticated'),
  ('88888888-8888-8888-8888-888888888888', 'gus@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name, created_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Fay''s', now() - interval '60 days'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Rex''s', now() - interval '60 days'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Uma''s', now() - interval '60 days'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Yan''s', now() - interval '29 days'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Oli''s', now() - interval '31 days'),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Nia''s', now() - interval '60 days'),
  ('abababab-abab-abab-abab-abababababab', 'Gus''s', now() - interval '90 days');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner', 1),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '33333333-3333-3333-3333-333333333333', 'owner', 1),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', '44444444-4444-4444-4444-444444444444', 'owner', 1),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '55555555-5555-5555-5555-555555555555', 'owner', 1),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', '77777777-7777-7777-7777-777777777777', 'owner', 1),
  ('abababab-abab-abab-abab-abababababab', '88888888-8888-8888-8888-888888888888', 'owner', 1),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '88888888-8888-8888-8888-888888888888', 'member', 2);
insert into public.household_plans (household_id, plan_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'founding'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'free'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'unlimited'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'founding'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'founding'),
  ('abababab-abab-abab-abab-abababababab', 'founding');

-- The month's usage below is seeded over its first three days, any of which may be today, so the
-- daily safety limits (60_ai_safety_limits) are lifted: this file is about the month.
update public.ai_safety_limits set per_day = null;

-- Seeds p_total of a per-user usage column this month (split over three days), and 1,000 on the
-- last day of last month. The minute window is an hour old, so the per-minute limit doesn't bite.
create function pg_temp.use(p_table text, p_col text, p_user uuid, p_total int)
returns void
language plpgsql
as $$
declare
  v_month date := date_trunc('month', now() at time zone 'utc')::date;
begin
  execute format(
    'insert into private.%I (user_id, day, minute_start, %I) values
       ($1, $2, $4, $3 - 2 * ($3 / 3)), ($1, $2 + 1, $4, $3 / 3), ($1, $2 + 2, $4, $3 / 3), ($1, $2 - 1, $4, 1000)
     on conflict (user_id, day) do update set %I = excluded.%I, minute_start = excluded.minute_start',
    p_table, p_col, p_col, p_col)
  using p_user, v_month, p_total, now() - interval '1 hour';
end;
$$;

-- The same for a household's use of a plan feature in household_ai_usage.
create function pg_temp.household_use(p_household uuid, p_feature text, p_total int)
returns void
language plpgsql
as $$
declare
  v_month date := date_trunc('month', now() at time zone 'utc')::date;
begin
  insert into private.household_ai_usage as u (household_id, feature, day, used) values
    (p_household, p_feature, v_month, p_total - 2 * (p_total / 3)),
    (p_household, p_feature, v_month + 1, p_total / 3),
    (p_household, p_feature, v_month + 2, p_total / 3),
    (p_household, p_feature, v_month - 1, 1000)
  on conflict (household_id, feature, day) do update set used = excluded.used;
end;
$$;

-- A user's count today on a per-user usage table (0 with no row).
create function pg_temp.today(p_table text, p_col text, p_user uuid)
returns int
language plpgsql
as $$
declare
  v int;
begin
  execute format('select %I from private.%I where user_id = $1 and day = (now() at time zone ''utc'')::date', p_col, p_table)
  into v using p_user;
  return coalesce(v, 0);
end;
$$;

-- plan_limits -------------------------------------------------------------------
select set_eq(
  $$ select plan_id, feature, monthly_limit from public.plan_limits $$,
  $$ values ('founding', 'recipe_import', 50), ('founding', 'recipe_photo_ai', 20),
            ('unlimited', 'recipe_import', null::int), ('unlimited', 'recipe_photo_ai', null) $$,
  'plan_limits holds exactly the seeded rows (free has none)');
select col_is_pk('public', 'plan_limits', array['plan_id', 'feature'], 'the key is (plan_id, feature)');
select throws_ok($$ insert into public.plan_limits values ('free', 'recipe_import', -1) $$, '23514', null,
  'a negative limit is rejected');
select throws_ok($$ insert into public.plan_limits values ('free', 'recipe_tags', 5) $$, '23514', null,
  'an old feature key is rejected');
select throws_ok($$ insert into public.plan_limits values ('gold', 'recipe_import', 5) $$, '23503', null,
  'an unknown plan is rejected');
select ok((select relrowsecurity from pg_class where oid = 'public.plan_limits'::regclass), 'RLS is on');
select ok(obj_description('public.plan_limits'::regclass, 'pg_class') like '%null monthly_limit means no monthly limit%',
  'the table''s comment says what null and a missing row mean');
select ok(
  not has_table_privilege('authenticated', 'public.plan_limits', 'select')
  and not has_table_privilege('authenticated', 'public.plan_limits', 'update')
  and not has_table_privilege('anon', 'public.plan_limits', 'select')
  and not has_table_privilege('authenticated', 'private.recipe_photo_ai_usage', 'select')
  and not has_table_privilege('anon', 'private.recipe_photo_ai_usage', 'select'),
  'clients have no privileges on plan_limits or recipe_photo_ai_usage');
select ok(
  not has_function_privilege('authenticated', 'private.monthly_limit(text, uuid)', 'execute')
  and not has_function_privilege('service_role', 'private.monthly_limit(text, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.first_month_ends_at(uuid)', 'execute'),
  'clients can''t call the household monthly_limit or first_month_ends_at');
select hasnt_function('private', 'monthly_limit', array['uuid', 'text', 'uuid'],
  'the per-user monthly_limit wrapper is gone');

-- household_ai_usage --------------------------------------------------------------
select col_is_pk('private', 'household_ai_usage', array['household_id', 'feature', 'day'],
  'household_ai_usage''s key is (household_id, feature, day)');
select ok((select relrowsecurity from pg_class where oid = 'private.household_ai_usage'::regclass), 'household_ai_usage has RLS on');
select ok(
  not has_table_privilege('authenticated', 'private.household_ai_usage', 'select')
  and not has_table_privilege('authenticated', 'private.household_ai_usage', 'insert')
  and not has_table_privilege('anon', 'private.household_ai_usage', 'select')
  and not has_table_privilege('anon', 'private.household_ai_usage', 'insert'),
  'clients have no privileges on household_ai_usage');
select ok(
  not has_function_privilege('authenticated', 'private.monthly_usage(uuid, text)', 'execute')
  and not has_function_privilege('service_role', 'private.monthly_usage(uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'private.oldest_household(uuid)', 'execute')
  and not has_function_privilege('service_role', 'private.oldest_household(uuid)', 'execute')
  and not has_function_privilege('service_role', 'private.check_household_monthly_limit(uuid, uuid, text)', 'execute')
  and not has_function_privilege('service_role', 'private.count_household_ai_usage(uuid, text)', 'execute'),
  'clients can''t call the household usage helpers');
select throws_ok($$ insert into private.household_ai_usage (household_id, feature, day) values
                   ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'categorize', current_date) $$, '23514', null,
  'household_ai_usage holds only the two plan features');
select throws_ok($$ insert into private.household_ai_usage (household_id, feature, day) values
                   ('99999999-9999-9999-9999-999999999999', 'recipe_import', current_date) $$, '23503', null,
  'household_ai_usage needs a real household');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select * from public.plan_limits $$, '42501', null, 'authenticated can''t read plan_limits');
select throws_ok($$ select * from private.household_ai_usage $$, '42501', null, 'authenticated can''t read household_ai_usage');
reset role;

-- private.first_month_ends_at and private.monthly_limit(feature, household) -------------------
select is(private.first_month_ends_at('dddddddd-dddd-dddd-dddd-dddddddddddd'), now() - interval '29 days' + interval '30 days',
  'a household''s first month ends 30 days after households.created_at');
select is(private.first_month_ends_at('99999999-9999-9999-9999-999999999999'), null::timestamptz,
  'an unknown household has no first month');
select is(array[private.monthly_limit('recipe_import'::text, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
                private.monthly_limit('recipe_photo_ai'::text, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')],
  array[50, 20], 'a founding household 60 days old gets founding''s 50 and 20');
select is(array[private.monthly_limit('recipe_import'::text, 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
                private.monthly_limit('recipe_photo_ai'::text, 'dddddddd-dddd-dddd-dddd-dddddddddddd')],
  array[100, 40], 'a household 29 days old gets twice its plan''s limits');
select is(private.monthly_limit('recipe_import'::text, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'), 50,
  'a household 31 days old doesn''t');
select is(array[private.monthly_limit('recipe_import'::text, 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
                private.monthly_limit('recipe_photo_ai'::text, 'cccccccc-cccc-cccc-cccc-cccccccccccc')],
  array[null, null]::integer[], 'an unlimited household has no limit');
select is(private.monthly_limit('recipe_import'::text, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 0,
  'a free household (no feature) gets 0');
select is(private.monthly_limit('recipe_import'::text, 'ffffffff-ffff-ffff-ffff-ffffffffffff'), 0,
  'a household with no row gets 0');
-- The first month goes by the household, not the user: an old account in a new household doubles.
update auth.users set created_at = now() - interval '400 days' where id = '44444444-4444-4444-4444-444444444444';
select is(private.monthly_limit('recipe_import'::text, 'dddddddd-dddd-dddd-dddd-dddddddddddd'), 100,
  'an old account in a household 29 days old still gets the doubled limit');

-- private.oldest_household (where an old client's request counts) ---------------------------
select is(private.oldest_household('88888888-8888-8888-8888-888888888888'), 'abababab-abab-abab-abab-abababababab'::uuid,
  'oldest_household is the user''s household made first');
select is(private.oldest_household('66666666-6666-6666-6666-666666666666'), null::uuid,
  'a user in no household has none');

-- categorize: no monthly limit ---------------------------------------------------------
select pg_temp.use('categorize_usage', 'new_names', '11111111-1111-1111-1111-111111111111', 5000);
select is(public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 100), 'ok',
  'categorize: 5,100 names in a month pass on founding');
select is(public.check_categorize_limit('22222222-2222-2222-2222-222222222222', 300), 'ok',
  'categorize: a free household''s user is categorized too');
update private.categorize_usage set requests_this_minute = 60, minute_start = date_trunc('minute', now())
  where user_id = '11111111-1111-1111-1111-111111111111' and day = (now() at time zone 'utc')::date;
select is(public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 1), 'user_limit',
  'categorize: still held to 60 requests a minute');

-- suggest-recipe-tags: no monthly limit ---------------------------------------------------
select pg_temp.use('recipe_tags_usage', 'suggestions', '11111111-1111-1111-1111-111111111111', 1000);
select is(public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111'), 'ok',
  'recipe_tags: 1,001 suggestions in a month pass');
select is(public.check_recipe_tags_limit('22222222-2222-2222-2222-222222222222'), 'ok',
  'recipe_tags: a free household''s user gets suggestions');
update private.recipe_tags_usage set requests_this_minute = 20, minute_start = date_trunc('minute', now())
  where user_id = '11111111-1111-1111-1111-111111111111' and day = (now() at time zone 'utc')::date;
select is(public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111'), 'user_limit',
  'recipe_tags: still held to the per-minute limit');

-- match-recipe-steps: no monthly limit ------------------------------------------------------
select pg_temp.use('step_match_usage', 'matches', '11111111-1111-1111-1111-111111111111', 1000);
select is(public.check_step_match_limit('11111111-1111-1111-1111-111111111111'), 'ok',
  'step_ingredients: 1,001 matches in a month pass');
select is(public.check_step_match_limit('66666666-6666-6666-6666-666666666666'), 'ok',
  'step_ingredients: even a user in no household is matched');
update private.step_match_usage set requests_this_minute = 30, minute_start = date_trunc('minute', now())
  where user_id = '11111111-1111-1111-1111-111111111111' and day = (now() at time zone 'utc')::date;
select is(public.check_step_match_limit('11111111-1111-1111-1111-111111111111'), 'user_limit',
  'step_ingredients: still held to the per-minute limit');
select is((select count(*)::int from private.household_ai_usage), 0,
  'categorize, tags and step matching count nothing on a household');

-- Imports: the household's recipe_import (founding 50), shared by members and kinds --------------
select pg_temp.household_use('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'recipe_import', 48);
select is(private.monthly_usage('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'recipe_import'), 48,
  'monthly_usage sums the household''s month, not last month');
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'ok',
  'imports: Fay''s link import is household A''s 49th');
select is(public.check_recipe_photo_limit('88888888-8888-8888-8888-888888888888', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'ok',
  'imports: Gus''s photo import into A is its 50th');
select is(array[private.monthly_usage('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'recipe_import'),
                pg_temp.today('recipe_import_usage', 'imports', '11111111-1111-1111-1111-111111111111'),
                pg_temp.today('recipe_photo_import_usage', 'imports', '88888888-8888-8888-8888-888888888888')],
  array[50, 1, 1], 'imports: each is counted on the household and on the member''s own table');
select is(public.check_recipe_import_limit('88888888-8888-8888-8888-888888888888', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'monthly_limit',
  'imports: two members share one allowance, so Gus''s link import is refused at 51');
select is(public.check_recipe_photo_limit('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'monthly_limit',
  'imports: and link and photo share it, so Fay''s photo import is refused too');
select is(array[private.monthly_usage('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'recipe_import'),
                pg_temp.today('recipe_import_usage', 'imports', '88888888-8888-8888-8888-888888888888'),
                pg_temp.today('recipe_photo_import_usage', 'imports', '11111111-1111-1111-1111-111111111111')],
  array[50, 0, 0], 'imports: a refused request counts nothing, on the household or the user');
select is(public.check_recipe_import_limit('88888888-8888-8888-8888-888888888888', 'abababab-abab-abab-abab-abababababab'), 'ok',
  'imports: Gus''s own household B has its own allowance');
select is(array[private.monthly_usage('abababab-abab-abab-abab-abababababab', 'recipe_import'),
                private.monthly_usage('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'recipe_import')],
  array[1, 50], 'imports: a member''s use in household A doesn''t count in B, nor B''s in A');
select is(public.check_recipe_photo_limit('88888888-8888-8888-8888-888888888888'), 'ok',
  'imports: a request with no household (an old client) passes on Gus''s oldest, B');
select is(array[private.monthly_usage('abababab-abab-abab-abab-abababababab', 'recipe_import'),
                private.monthly_usage('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'recipe_import')],
  array[2, 50], 'imports: and counts against B');
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111'), 'monthly_limit',
  'imports: no household, and Fay''s oldest (her only one, A) is full');
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'abababab-abab-abab-abab-abababababab'), 'monthly_limit',
  'imports: a household the user isn''t in is refused');
select is(private.monthly_usage('abababab-abab-abab-abab-abababababab', 'recipe_import'), 2,
  'imports: and nothing is counted on it');
update public.plan_limits set monthly_limit = 51 where plan_id = 'founding' and feature = 'recipe_import';
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'ok',
  'imports: raising founding''s row raises the limit at once');
delete from public.plan_limits where plan_id = 'founding' and feature = 'recipe_import';
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'ok',
  'imports: deleting founding''s row lifts the limit at once');
select is(private.monthly_usage('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'recipe_import'), 52,
  'imports: usage is still counted with no limit');
insert into public.plan_limits values ('founding', 'recipe_import', 50);

select pg_temp.household_use('dddddddd-dddd-dddd-dddd-dddddddddddd', 'recipe_import', 99);
select is(public.check_recipe_import_limit('44444444-4444-4444-4444-444444444444', 'dddddddd-dddd-dddd-dddd-dddddddddddd'), 'ok',
  'imports: a household in its first month passes at 100');
select is(public.check_recipe_photo_limit('44444444-4444-4444-4444-444444444444', 'dddddddd-dddd-dddd-dddd-dddddddddddd'), 'monthly_limit',
  'imports: and is refused at 101');
select pg_temp.household_use('cccccccc-cccc-cccc-cccc-cccccccccccc', 'recipe_import', 1000);
select is(public.check_recipe_import_limit('33333333-3333-3333-3333-333333333333', 'cccccccc-cccc-cccc-cccc-cccccccccccc'), 'ok',
  'imports: unlimited passes');
update private.recipe_import_usage set requests_this_minute = 10, minute_start = date_trunc('minute', now())
  where user_id = '33333333-3333-3333-3333-333333333333' and day = (now() at time zone 'utc')::date;
select is(public.check_recipe_import_limit('33333333-3333-3333-3333-333333333333', 'cccccccc-cccc-cccc-cccc-cccccccccccc'), 'user_limit',
  'imports: unlimited is still held to the per-minute limit');
select is(array[public.check_recipe_photo_limit('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
                public.check_recipe_import_limit('66666666-6666-6666-6666-666666666666'),
                public.check_recipe_import_limit('77777777-7777-7777-7777-777777777777', 'ffffffff-ffff-ffff-ffff-ffffffffffff')],
  array['monthly_limit', 'monthly_limit', 'monthly_limit'],
  'imports: a free household, no household, or a household with no row: refused');

select pg_temp.household_use('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'recipe_import', 49);
select is(public.check_recipe_photo_limit('55555555-5555-5555-5555-555555555555', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'), 'ok',
  'photo import: founding passes at 50');
select is(public.check_recipe_photo_limit('55555555-5555-5555-5555-555555555555', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'), 'monthly_limit',
  'photo import: founding is refused at 51');
update private.recipe_photo_import_usage set imports_this_minute = 5, minute_start = date_trunc('minute', now())
  where user_id = '55555555-5555-5555-5555-555555555555' and day = (now() at time zone 'utc')::date;
select is(public.check_recipe_photo_limit('55555555-5555-5555-5555-555555555555', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'), 'user_limit',
  'photo import: the per-minute limit comes first');

-- AI photos: the recipe's household (founding 20) ------------------------------------------
-- Fay's household (A) has recipes R1–R3 and the deleted D; Uma's has R9; Gus's (B) has R7.
insert into public.recipes (id, household_id, name, deleted_at) values
  ('a4000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Blueberry bread', null),
  ('a4000000-0000-7000-8000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tacos', null),
  ('a4000000-0000-7000-8000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Soup', null),
  ('a4000000-0000-7000-8000-00000000000d', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Gone', now()),
  ('a4000000-0000-7000-8000-000000000009', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Stew', null),
  ('a4000000-0000-7000-8000-000000000007', 'abababab-abab-abab-abab-abababababab', 'Pie', null);

-- 19 reserved in A this month over three days (and 1,000 last month).
select pg_temp.household_use('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'recipe_photo_ai', 19);
select is(private.monthly_usage('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'recipe_photo_ai'), 19,
  'recipe_photo_ai: the month''s reservations, not last month''s');
select results_eq(
  $$ select * from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000001') $$,
  $$ values ('ok'::text, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid) $$,
  'recipe_photo_ai: the 20th reservation this month is fine');
select is(array[private.monthly_usage('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'recipe_photo_ai'),
                pg_temp.today('recipe_photo_ai_usage', 'photos', '11111111-1111-1111-1111-111111111111')],
  array[20, 1], 'recipe_photo_ai: and is counted at the reservation, on the household and the user');

create temp table before_ai as select * from private.recipe_photo_ai;
create temp table before_ai_usage as select * from private.recipe_photo_ai_usage;
create temp table before_household_usage as select * from private.household_ai_usage;
select results_eq(
  $$ select * from public.reserve_recipe_photo_ai('88888888-8888-8888-8888-888888888888', 'a4000000-0000-7000-8000-000000000002') $$,
  $$ values ('monthly_limit'::text, null::uuid) $$,
  'recipe_photo_ai: the 21st in A, by another member, is monthly_limit: members share the allowance');
select results_eq(
  $$ select * from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-00000000000d') $$,
  $$ values ('not_found'::text, null::uuid) $$,
  'recipe_photo_ai: not_found comes before monthly_limit');
select results_eq(
  $$ select * from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000001') $$,
  $$ values ('already_generated'::text, null::uuid) $$,
  'recipe_photo_ai: so does already_generated');
select ok(
  (select count(*) from (select * from private.recipe_photo_ai except select * from before_ai) d) = 0
  and (select count(*) from (select * from before_ai except select * from private.recipe_photo_ai) d) = 0
  and (select count(*) from (select * from private.recipe_photo_ai_usage except select * from before_ai_usage) d) = 0
  and (select count(*) from (select * from before_ai_usage except select * from private.recipe_photo_ai_usage) d) = 0
  and (select count(*) from (select * from private.household_ai_usage except select * from before_household_usage) d) = 0
  and (select count(*) from (select * from before_household_usage except select * from private.household_ai_usage) d) = 0,
  'recipe_photo_ai: not_found, already_generated and monthly_limit write nothing');
select results_eq(
  $$ select * from public.reserve_recipe_photo_ai('88888888-8888-8888-8888-888888888888', 'a4000000-0000-7000-8000-000000000007') $$,
  $$ values ('ok'::text, 'abababab-abab-abab-abab-abababababab'::uuid) $$,
  'recipe_photo_ai: Gus''s recipe in B counts against B''s allowance, not A''s');
select is(array[private.monthly_usage('abababab-abab-abab-abab-abababababab', 'recipe_photo_ai'),
                private.monthly_usage('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'recipe_photo_ai')],
  array[1, 20], 'recipe_photo_ai: counted on B only');

do $$ begin perform public.release_recipe_photo_ai('a4000000-0000-7000-8000-000000000001'); end $$;
select is(private.monthly_usage('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'recipe_photo_ai'), 20,
  'recipe_photo_ai: a released slot isn''t given back');

-- The month turns: this month's reservations become last month's.
update private.household_ai_usage
  set used = used + private.monthly_usage('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'recipe_photo_ai')
  where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and feature = 'recipe_photo_ai'
    and day = date_trunc('month', now() at time zone 'utc')::date - 1;
delete from private.household_ai_usage
  where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and feature = 'recipe_photo_ai'
    and day >= date_trunc('month', now() at time zone 'utc')::date;
select results_eq(
  $$ select * from public.reserve_recipe_photo_ai('88888888-8888-8888-8888-888888888888', 'a4000000-0000-7000-8000-000000000002') $$,
  $$ values ('ok'::text, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid) $$,
  'recipe_photo_ai: the next month starts again');

select pg_temp.household_use('cccccccc-cccc-cccc-cccc-cccccccccccc', 'recipe_photo_ai', 500);
select results_eq(
  $$ select status from public.reserve_recipe_photo_ai('33333333-3333-3333-3333-333333333333', 'a4000000-0000-7000-8000-000000000009') $$,
  $$ values ('ok'::text) $$,
  'recipe_photo_ai: unlimited has no monthly limit');
select is(private.monthly_usage('cccccccc-cccc-cccc-cccc-cccccccccccc', 'recipe_photo_ai'), 501,
  'recipe_photo_ai: but its use is still counted');
select results_eq(
  $$ select status from public.reserve_recipe_photo_ai('33333333-3333-3333-3333-333333333333', 'a4000000-0000-7000-8000-000000000009') $$,
  $$ values ('already_generated'::text) $$,
  'recipe_photo_ai: and still one AI photo per recipe');

-- Retention and deletion -------------------------------------------------------------------
select is((select command from cron.job where jobname = 'recipe-photo-ai-usage-retention'),
  $$delete from private.recipe_photo_ai_usage where day < (now() at time zone 'utc')::date - 40$$,
  'recipe_photo_ai_usage is kept 40 days');
select is((select command from cron.job where jobname = 'household-ai-usage-retention'),
  $$delete from private.household_ai_usage where day < (now() at time zone 'utc')::date - 40$$,
  'household_ai_usage is kept 40 days');
select is((select schedule from cron.job where jobname = 'household-ai-usage-retention'), '51 3 * * *',
  'and pruned daily');
insert into private.household_ai_usage (household_id, feature, day, used) values
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'recipe_photo_ai', (now() at time zone 'utc')::date - 41, 3),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'recipe_photo_ai', (now() at time zone 'utc')::date - 40, 4);
do $$ begin execute (select command from cron.job where jobname = 'household-ai-usage-retention'); end $$;
select is(
  (select array_agg(used order by day) from private.household_ai_usage
   where household_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' and feature = 'recipe_photo_ai'),
  array[4], 'the job deletes rows older than 40 days and keeps the row 40 days old');
delete from public.households where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
select is((select count(*)::int from private.household_ai_usage where household_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'), 0,
  'deleting a household deletes its usage');

-- Bad arguments ------------------------------------------------------------------------
select throws_ok($$ select public.check_recipe_import_limit(null, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$, '22023', null,
  'check_recipe_import_limit still needs a user');
select throws_ok($$ select public.check_recipe_photo_limit(null, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$, '22023', null,
  'check_recipe_photo_limit still needs a user');

select * from finish();
rollback;
