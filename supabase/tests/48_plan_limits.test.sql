-- Monthly limits per plan (spec 4.12, 5, 6.1, 6.6–6.11): public.plan_limits and its seed,
-- private.monthly_limit per household (the plan, the first-month doubling by household age) and its
-- per-user transition wrapper, private.monthly_usage, each limit function's 'monthly_limit' answer,
-- and the AI photo monthly limit. Categorize, tags and step matching have no monthly limit.
-- now() is fixed within the transaction, so a month's usage is seeded straight into the usage
-- tables: spread over the month's first three days (any of them may be today or later, which still
-- counts) plus a big day last month that mustn't count.
begin;
create extension if not exists pgtap with schema extensions;
select plan(67);

-- Fixtures (as postgres) ------------------------------------------------------
-- Each user owns one household: Fay a founding one 60 days old, Uma an unlimited one, Rex a free
-- one, Yan a founding one 29 days old, Oli a founding one 31 days old. Ned is in no household;
-- Nia's household has no household_plans row.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'fay@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'rex@test.local', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'uma@test.local', 'authenticated', 'authenticated'),
  ('44444444-4444-4444-4444-444444444444', 'yan@test.local', 'authenticated', 'authenticated'),
  ('55555555-5555-5555-5555-555555555555', 'oli@test.local', 'authenticated', 'authenticated'),
  ('66666666-6666-6666-6666-666666666666', 'ned@test.local', 'authenticated', 'authenticated'),
  ('77777777-7777-7777-7777-777777777777', 'nia@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name, created_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Fay''s', now() - interval '60 days'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Rex''s', now() - interval '60 days'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Uma''s', now() - interval '60 days'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Yan''s', now() - interval '29 days'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Oli''s', now() - interval '31 days'),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Nia''s', now() - interval '60 days');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner', 1),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '33333333-3333-3333-3333-333333333333', 'owner', 1),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', '44444444-4444-4444-4444-444444444444', 'owner', 1),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '55555555-5555-5555-5555-555555555555', 'owner', 1),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', '77777777-7777-7777-7777-777777777777', 'owner', 1);
insert into public.household_plans (household_id, plan_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'founding'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'free'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'unlimited'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'founding'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'founding');

-- Seeds p_total of a usage column for a user this month (split over three days), and 1,000 on the
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
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select * from public.plan_limits $$, '42501', null, 'authenticated can''t read plan_limits');
select throws_ok($$ select private.monthly_limit('11111111-1111-1111-1111-111111111111'::uuid, 'recipe_import') $$, '42501', null,
  'authenticated can''t call the per-user monthly_limit');
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

-- The per-user wrapper (the check functions, until usage is per household) ---------------------
select is(private.monthly_limit('11111111-1111-1111-1111-111111111111'::uuid, 'recipe_import'), 50,
  'no household: the user''s founding household''s limit');
select is(private.monthly_limit('11111111-1111-1111-1111-111111111111'::uuid, 'recipe_import', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 50,
  'their own household: its limit');
select is(private.monthly_limit('11111111-1111-1111-1111-111111111111'::uuid, 'recipe_import', 'cccccccc-cccc-cccc-cccc-cccccccccccc'), 0,
  'a household they''re not in: 0');
select is(private.monthly_limit('11111111-1111-1111-1111-111111111111'::uuid, 'recipe_import_photo'), 50,
  'photo import reads recipe_import''s limit');
select is(array[private.monthly_limit('11111111-1111-1111-1111-111111111111'::uuid, 'categorize'),
                private.monthly_limit('11111111-1111-1111-1111-111111111111'::uuid, 'recipe_tags'),
                private.monthly_limit('11111111-1111-1111-1111-111111111111'::uuid, 'step_ingredients')],
  array[null, null, null]::integer[], 'categorize, tags and step matching have no monthly limit');
select is(array[private.monthly_limit('22222222-2222-2222-2222-222222222222'::uuid, 'recipe_import'),
                private.monthly_limit('66666666-6666-6666-6666-666666666666'::uuid, 'recipe_import'),
                private.monthly_limit('77777777-7777-7777-7777-777777777777'::uuid, 'recipe_import')],
  array[0, 0, 0], 'a free household, no household, or a household with no row: 0');
insert into public.household_members (household_id, user_id, role, position) values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', '11111111-1111-1111-1111-111111111111', 'member', 2);
select is(private.monthly_limit('11111111-1111-1111-1111-111111111111'::uuid, 'recipe_import'), 100,
  'no household, in two: the higher limit');
insert into public.household_members (household_id, user_id, role, position) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'member', 3);
select is(private.monthly_limit('11111111-1111-1111-1111-111111111111'::uuid, 'recipe_import'), null::int,
  'no household, one of them unlimited: no limit');
delete from public.household_members where user_id = '11111111-1111-1111-1111-111111111111'
  and household_id <> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

-- categorize: no monthly limit -------------------------------------------------------
select pg_temp.use('categorize_usage', 'new_names', '11111111-1111-1111-1111-111111111111', 5000);
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'categorize'), 5000,
  'categorize: the month''s usage sums its days, not last month''s');
select is(public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 100), 'ok',
  'categorize: 5,100 names in a month pass on founding');
select is(public.check_categorize_limit('22222222-2222-2222-2222-222222222222', 300), 'ok',
  'categorize: a free household''s user is categorized too');
update private.categorize_usage set requests_this_minute = 60, minute_start = date_trunc('minute', now())
  where user_id = '11111111-1111-1111-1111-111111111111' and day = (now() at time zone 'utc')::date;
select is(public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 1), 'user_limit',
  'categorize: still held to 60 requests a minute');

-- import-recipe (founding 50) ------------------------------------------------------------
select pg_temp.use('recipe_import_usage', 'imports', '11111111-1111-1111-1111-111111111111', 49);
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'recipe_import'), 49,
  'recipe_import: last month''s usage doesn''t count');
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111'), 'ok', 'recipe_import: founding passes at 50');
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111'), 'monthly_limit',
  'recipe_import: founding is refused at 51');
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'recipe_import'), 50,
  'recipe_import: the refused call isn''t counted');
select pg_temp.use('recipe_import_usage', 'imports', '44444444-4444-4444-4444-444444444444', 99);
select is(public.check_recipe_import_limit('44444444-4444-4444-4444-444444444444'), 'ok',
  'recipe_import: a household in its first month passes at 100');
select is(public.check_recipe_import_limit('44444444-4444-4444-4444-444444444444'), 'monthly_limit',
  'recipe_import: and is refused at 101');
select pg_temp.use('recipe_import_usage', 'imports', '33333333-3333-3333-3333-333333333333', 1000);
select is(public.check_recipe_import_limit('33333333-3333-3333-3333-333333333333'), 'ok', 'recipe_import: unlimited passes');
update private.recipe_import_usage set requests_this_minute = 10, minute_start = date_trunc('minute', now())
  where user_id = '33333333-3333-3333-3333-333333333333' and day = (now() at time zone 'utc')::date;
select is(public.check_recipe_import_limit('33333333-3333-3333-3333-333333333333'), 'user_limit',
  'recipe_import: unlimited is still held to the per-minute limit');
update public.plan_limits set monthly_limit = 51 where plan_id = 'founding' and feature = 'recipe_import';
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111'), 'ok',
  'recipe_import: raising founding''s row raises the limit at once');
delete from public.plan_limits where plan_id = 'founding' and feature = 'recipe_import';
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111'), 'ok',
  'recipe_import: deleting founding''s row lifts the limit at once');
insert into public.plan_limits values ('founding', 'recipe_import', 50);

-- suggest-recipe-tags: no monthly limit ---------------------------------------------------
select pg_temp.use('recipe_tags_usage', 'suggestions', '11111111-1111-1111-1111-111111111111', 1000);
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'recipe_tags'), 1000,
  'recipe_tags: last month''s usage doesn''t count');
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
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'step_ingredients'), 1000,
  'step_ingredients: last month''s usage doesn''t count');
select is(public.check_step_match_limit('11111111-1111-1111-1111-111111111111'), 'ok',
  'step_ingredients: 1,001 matches in a month pass');
select is(public.check_step_match_limit('66666666-6666-6666-6666-666666666666'), 'ok',
  'step_ingredients: even a user in no household is matched');
update private.step_match_usage set requests_this_minute = 30, minute_start = date_trunc('minute', now())
  where user_id = '11111111-1111-1111-1111-111111111111' and day = (now() at time zone 'utc')::date;
select is(public.check_step_match_limit('11111111-1111-1111-1111-111111111111'), 'user_limit',
  'step_ingredients: still held to the per-minute limit');

-- import-recipe-photo (recipe_import's limit, founding 50) ------------------------------------
select pg_temp.use('recipe_photo_import_usage', 'imports', '55555555-5555-5555-5555-555555555555', 49);
select is(private.monthly_usage('55555555-5555-5555-5555-555555555555', 'recipe_import_photo'), 49,
  'recipe_import_photo: last month''s usage doesn''t count');
select is(public.check_recipe_photo_limit('55555555-5555-5555-5555-555555555555'), 'ok',
  'recipe_import_photo: founding passes at 50 (recipe_import''s limit)');
select is(public.check_recipe_photo_limit('55555555-5555-5555-5555-555555555555'), 'monthly_limit',
  'recipe_import_photo: founding is refused at 51');
select is(public.check_recipe_photo_limit('22222222-2222-2222-2222-222222222222'), 'monthly_limit',
  'recipe_import_photo: a free household''s user gets none');
update private.recipe_photo_import_usage set imports_this_minute = 5, minute_start = date_trunc('minute', now())
  where user_id = '55555555-5555-5555-5555-555555555555' and day = (now() at time zone 'utc')::date;
select is(public.check_recipe_photo_limit('55555555-5555-5555-5555-555555555555'), 'user_limit',
  'recipe_import_photo: the per-minute limit comes first');

-- AI photos (founding 20) -------------------------------------------------------------
-- Fay's household has recipes R1–R3 and the deleted D; Uma's has R9.
insert into public.recipes (id, household_id, name, deleted_at) values
  ('a4000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Blueberry bread', null),
  ('a4000000-0000-7000-8000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tacos', null),
  ('a4000000-0000-7000-8000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Soup', null),
  ('a4000000-0000-7000-8000-00000000000d', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Gone', now()),
  ('a4000000-0000-7000-8000-000000000009', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Stew', null);

-- 19 reserved this month over three days (and 1,000 last month).
insert into private.recipe_photo_ai_usage (user_id, day, photos) values
  ('11111111-1111-1111-1111-111111111111', date_trunc('month', now() at time zone 'utc')::date, 7),
  ('11111111-1111-1111-1111-111111111111', date_trunc('month', now() at time zone 'utc')::date + 1, 6),
  ('11111111-1111-1111-1111-111111111111', date_trunc('month', now() at time zone 'utc')::date + 2, 6),
  ('11111111-1111-1111-1111-111111111111', date_trunc('month', now() at time zone 'utc')::date - 1, 1000);
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'recipe_photo_ai'), 19,
  'recipe_photo_ai: the month''s reservations, not last month''s');
select results_eq(
  $$ select * from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000001') $$,
  $$ values ('ok'::text, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid) $$,
  'recipe_photo_ai: the 20th reservation this month is fine');
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'recipe_photo_ai'), 20,
  'recipe_photo_ai: and is counted at the reservation');

create temp table before_ai as select * from private.recipe_photo_ai;
create temp table before_ai_usage as select * from private.recipe_photo_ai_usage;
select results_eq(
  $$ select * from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000002') $$,
  $$ values ('monthly_limit'::text, null::uuid) $$,
  'recipe_photo_ai: the 21st reservation in a month is monthly_limit for an older founding household');
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
  and (select count(*) from (select * from before_ai_usage except select * from private.recipe_photo_ai_usage) d) = 0,
  'recipe_photo_ai: not_found, already_generated and monthly_limit write nothing');

do $$ begin perform public.release_recipe_photo_ai('a4000000-0000-7000-8000-000000000001'); end $$;
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'recipe_photo_ai'), 20,
  'recipe_photo_ai: a released slot isn''t given back');

-- The month turns: this month's reservations become last month's.
update private.recipe_photo_ai_usage
  set photos = photos + private.monthly_usage('11111111-1111-1111-1111-111111111111', 'recipe_photo_ai')
  where user_id = '11111111-1111-1111-1111-111111111111' and day = date_trunc('month', now() at time zone 'utc')::date - 1;
delete from private.recipe_photo_ai_usage
  where user_id = '11111111-1111-1111-1111-111111111111' and day >= date_trunc('month', now() at time zone 'utc')::date;
select results_eq(
  $$ select * from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000002') $$,
  $$ values ('ok'::text, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid) $$,
  'recipe_photo_ai: the next month starts again');

insert into private.recipe_photo_ai_usage (user_id, day, photos)
  values ('33333333-3333-3333-3333-333333333333', date_trunc('month', now() at time zone 'utc')::date, 500);
select results_eq(
  $$ select status from public.reserve_recipe_photo_ai('33333333-3333-3333-3333-333333333333', 'a4000000-0000-7000-8000-000000000009') $$,
  $$ values ('ok'::text) $$,
  'recipe_photo_ai: unlimited has no monthly limit');
select results_eq(
  $$ select status from public.reserve_recipe_photo_ai('33333333-3333-3333-3333-333333333333', 'a4000000-0000-7000-8000-000000000009') $$,
  $$ values ('already_generated'::text) $$,
  'recipe_photo_ai: but still one AI photo per recipe');

-- Retention ---------------------------------------------------------------------------
select is((select command from cron.job where jobname = 'recipe-photo-ai-usage-retention'),
  $$delete from private.recipe_photo_ai_usage where day < (now() at time zone 'utc')::date - 40$$,
  'recipe_photo_ai_usage is kept 40 days');

select * from finish();
rollback;
