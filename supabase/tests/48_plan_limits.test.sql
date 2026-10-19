-- Monthly limits per plan (spec 4.12, 5, 6.1, 6.6–6.11): public.plan_limits and its seed,
-- private.monthly_limit (the plan, the first-month doubling), private.monthly_usage, each limit
-- function's 'monthly_limit' answer on plus, basic and unlimited, and the AI photo monthly limit.
-- now() is fixed within the transaction, so a month's usage is seeded straight into the usage
-- tables: spread over the month's first three days (any of them may be today or later, which still
-- counts) plus a big day last month that mustn't count.
begin;
create extension if not exists pgtap with schema extensions;
select plan(67);

-- Fixtures (as postgres) ------------------------------------------------------
-- plus has no user_plans row (the default). Ages are set by hand: a null created_at isn't young.
insert into auth.users (id, email, aud, role, created_at) values
  ('11111111-1111-1111-1111-111111111111', 'plus@test.local', 'authenticated', 'authenticated', now() - interval '60 days'),
  ('22222222-2222-2222-2222-222222222222', 'basic@test.local', 'authenticated', 'authenticated', now() - interval '60 days'),
  ('33333333-3333-3333-3333-333333333333', 'unlimited@test.local', 'authenticated', 'authenticated', now() - interval '60 days'),
  ('44444444-4444-4444-4444-444444444444', 'young@test.local', 'authenticated', 'authenticated', now() - interval '29 days'),
  ('55555555-5555-5555-5555-555555555555', 'older@test.local', 'authenticated', 'authenticated', now() - interval '31 days'),
  ('66666666-6666-6666-6666-666666666666', 'none@test.local', 'authenticated', 'authenticated', now() - interval '60 days');
insert into public.user_plans (user_id, plan_id) values
  ('22222222-2222-2222-2222-222222222222', 'basic'),
  ('33333333-3333-3333-3333-333333333333', 'unlimited'),
  ('66666666-6666-6666-6666-666666666666', 'none');

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
  $$ values
       ('plus', 'categorize', 250), ('plus', 'step_ingredients', 100), ('plus', 'recipe_import', 40),
       ('plus', 'recipe_import_photo', 20), ('plus', 'recipe_tags', 50), ('plus', 'recipe_photo_ai', 15),
       ('basic', 'categorize', 250), ('basic', 'step_ingredients', 100),
       ('unlimited', 'categorize', null::int), ('unlimited', 'step_ingredients', null), ('unlimited', 'recipe_import', null),
       ('unlimited', 'recipe_import_photo', null), ('unlimited', 'recipe_tags', null), ('unlimited', 'recipe_photo_ai', null) $$,
  'plan_limits holds exactly the seeded rows (none has none)');
select col_is_pk('public', 'plan_limits', array['plan_id', 'feature'], 'the key is (plan_id, feature)');
select throws_ok($$ insert into public.plan_limits values ('basic', 'recipe_tags', -1) $$, '23514', null,
  'a negative limit is rejected');
select throws_ok($$ insert into public.plan_limits values ('basic', 'photo_search', 5) $$, '23514', null,
  'an unknown feature is rejected');
select throws_ok($$ insert into public.plan_limits values ('gold', 'recipe_tags', 5) $$, '23503', null,
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
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select * from public.plan_limits $$, '42501', null, 'authenticated can''t read plan_limits');
select throws_ok($$ select private.monthly_limit('11111111-1111-1111-1111-111111111111', 'categorize') $$, '42501', null,
  'authenticated can''t call monthly_limit');
reset role;

-- private.monthly_limit ------------------------------------------------------------
create temp table features (feature text);
insert into features values ('categorize'), ('step_ingredients'), ('recipe_import'), ('recipe_import_photo'), ('recipe_tags'), ('recipe_photo_ai');

select set_eq(
  $$ select feature, private.monthly_limit('11111111-1111-1111-1111-111111111111', feature) from features $$,
  $$ values ('categorize', 250), ('step_ingredients', 100), ('recipe_import', 40), ('recipe_import_photo', 20),
            ('recipe_tags', 50), ('recipe_photo_ai', 15) $$,
  'a user with no user_plans row gets plus''s limits');
select set_eq(
  $$ select feature, private.monthly_limit('22222222-2222-2222-2222-222222222222', feature) from features $$,
  $$ values ('categorize', 250), ('step_ingredients', 100), ('recipe_import', null::int), ('recipe_import_photo', null),
            ('recipe_tags', null), ('recipe_photo_ai', null) $$,
  'a basic user gets basic''s, and null for a feature with no row');
select is((select count(*)::int from features where private.monthly_limit('33333333-3333-3333-3333-333333333333', feature) is null),
  6, 'an unlimited user gets null for every feature');
select is(private.monthly_limit('66666666-6666-6666-6666-666666666666', 'categorize'), null::int, 'none has no rows, so null');
select set_eq(
  $$ select feature, private.monthly_limit('44444444-4444-4444-4444-444444444444', feature) from features $$,
  $$ values ('categorize', 500), ('step_ingredients', 200), ('recipe_import', 80), ('recipe_import_photo', 40),
            ('recipe_tags', 100), ('recipe_photo_ai', 30) $$,
  'an account 29 days old gets twice its plan''s limits');
select is(private.monthly_limit('55555555-5555-5555-5555-555555555555', 'recipe_import'), 40,
  'an account 31 days old doesn''t');
select is(private.monthly_limit('11111111-1111-1111-1111-111111111111', 'categorize', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 250,
  'the household is accepted and ignored, as in has_feature');

-- categorize (plus 250, basic 250; names) --------------------------------------------
select pg_temp.use('categorize_usage', 'new_names', '11111111-1111-1111-1111-111111111111', 249);
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'categorize'), 249,
  'categorize: the month''s usage sums its days, not last month''s');
select is(public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 1), 'ok', 'categorize: plus passes at 250');
create temp table before_usage as select * from private.categorize_usage;
select is(public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 1), 'monthly_limit',
  'categorize: plus is refused at 251');
select set_eq($$ select * from private.categorize_usage $$, $$ select * from before_usage $$,
  'categorize: a refused request writes nothing');
select pg_temp.use('categorize_usage', 'new_names', '22222222-2222-2222-2222-222222222222', 250);
select is(public.check_categorize_limit('22222222-2222-2222-2222-222222222222', 1), 'monthly_limit',
  'categorize: basic is refused past 250');
select pg_temp.use('categorize_usage', 'new_names', '33333333-3333-3333-3333-333333333333', 5000);
select is(public.check_categorize_limit('33333333-3333-3333-3333-333333333333', 100), 'ok',
  'categorize: unlimited passes any month''s total');
update private.categorize_usage set requests_this_minute = 60, minute_start = date_trunc('minute', now())
  where user_id = '33333333-3333-3333-3333-333333333333' and day = (now() at time zone 'utc')::date;
select is(public.check_categorize_limit('33333333-3333-3333-3333-333333333333', 1), 'user_limit',
  'categorize: unlimited is still held to 60 requests a minute');
update public.plan_limits set monthly_limit = 260 where plan_id = 'plus' and feature = 'categorize';
select is(public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 10), 'ok',
  'categorize: raising plus''s row raises the limit at once');

-- import-recipe (plus 40) ------------------------------------------------------------
select pg_temp.use('recipe_import_usage', 'imports', '11111111-1111-1111-1111-111111111111', 39);
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'recipe_import'), 39,
  'recipe_import: last month''s usage doesn''t count');
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111'), 'ok', 'recipe_import: plus passes at 40');
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111'), 'monthly_limit',
  'recipe_import: plus is refused at 41');
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'recipe_import'), 40,
  'recipe_import: the refused call isn''t counted');
select pg_temp.use('recipe_import_usage', 'imports', '33333333-3333-3333-3333-333333333333', 1000);
select is(public.check_recipe_import_limit('33333333-3333-3333-3333-333333333333'), 'ok', 'recipe_import: unlimited passes');
update private.recipe_import_usage set requests_this_minute = 10, minute_start = date_trunc('minute', now())
  where user_id = '33333333-3333-3333-3333-333333333333' and day = (now() at time zone 'utc')::date;
select is(public.check_recipe_import_limit('33333333-3333-3333-3333-333333333333'), 'user_limit',
  'recipe_import: unlimited is still held to the per-minute limit');
delete from public.plan_limits where plan_id = 'plus' and feature = 'recipe_import';
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111'), 'ok',
  'recipe_import: deleting plus''s row lifts the limit at once');

-- suggest-recipe-tags (plus 50) --------------------------------------------------------
select pg_temp.use('recipe_tags_usage', 'suggestions', '11111111-1111-1111-1111-111111111111', 49);
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'recipe_tags'), 49,
  'recipe_tags: last month''s usage doesn''t count');
select is(public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111'), 'ok', 'recipe_tags: plus passes at 50');
select is(public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111'), 'monthly_limit',
  'recipe_tags: plus is refused at 51');
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'recipe_tags'), 50,
  'recipe_tags: the refused call isn''t counted');
select pg_temp.use('recipe_tags_usage', 'suggestions', '33333333-3333-3333-3333-333333333333', 1000);
select is(public.check_recipe_tags_limit('33333333-3333-3333-3333-333333333333'), 'ok', 'recipe_tags: unlimited passes');
update private.recipe_tags_usage set requests_this_minute = 20, minute_start = date_trunc('minute', now())
  where user_id = '33333333-3333-3333-3333-333333333333' and day = (now() at time zone 'utc')::date;
select is(public.check_recipe_tags_limit('33333333-3333-3333-3333-333333333333'), 'user_limit',
  'recipe_tags: unlimited is still held to the per-minute limit');
update public.plan_limits set monthly_limit = 51 where plan_id = 'plus' and feature = 'recipe_tags';
select is(public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111'), 'ok',
  'recipe_tags: raising plus''s row raises the limit at once');

-- match-recipe-steps (step_ingredients: plus 100, basic 100) -----------------------------
select pg_temp.use('step_match_usage', 'matches', '11111111-1111-1111-1111-111111111111', 99);
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'step_ingredients'), 99,
  'step_ingredients: last month''s usage doesn''t count');
select is(public.check_step_match_limit('11111111-1111-1111-1111-111111111111'), 'ok', 'step_ingredients: plus passes at 100');
select is(public.check_step_match_limit('11111111-1111-1111-1111-111111111111'), 'monthly_limit',
  'step_ingredients: plus is refused at 101');
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'step_ingredients'), 100,
  'step_ingredients: the refused call isn''t counted');
select pg_temp.use('step_match_usage', 'matches', '22222222-2222-2222-2222-222222222222', 99);
select is(public.check_step_match_limit('22222222-2222-2222-2222-222222222222'), 'ok', 'step_ingredients: basic passes at 100');
select is(public.check_step_match_limit('22222222-2222-2222-2222-222222222222'), 'monthly_limit',
  'step_ingredients: basic is refused at 101');
select pg_temp.use('step_match_usage', 'matches', '33333333-3333-3333-3333-333333333333', 1000);
select is(public.check_step_match_limit('33333333-3333-3333-3333-333333333333'), 'ok', 'step_ingredients: unlimited passes');
update private.step_match_usage set requests_this_minute = 30, minute_start = date_trunc('minute', now())
  where user_id = '33333333-3333-3333-3333-333333333333' and day = (now() at time zone 'utc')::date;
select is(public.check_step_match_limit('33333333-3333-3333-3333-333333333333'), 'user_limit',
  'step_ingredients: unlimited is still held to the per-minute limit');
update public.plan_limits set monthly_limit = 101 where plan_id = 'basic' and feature = 'step_ingredients';
select is(public.check_step_match_limit('22222222-2222-2222-2222-222222222222'), 'ok',
  'step_ingredients: raising basic''s row raises the limit at once');

-- import-recipe-photo (plus 20) ----------------------------------------------------------
select pg_temp.use('recipe_photo_import_usage', 'imports', '11111111-1111-1111-1111-111111111111', 19);
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'recipe_import_photo'), 19,
  'recipe_import_photo: last month''s usage doesn''t count');
select is(public.check_recipe_photo_limit('11111111-1111-1111-1111-111111111111'), 'ok', 'recipe_import_photo: plus passes at 20');
select is(public.check_recipe_photo_limit('11111111-1111-1111-1111-111111111111'), 'monthly_limit',
  'recipe_import_photo: plus is refused at 21');
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'recipe_import_photo'), 20,
  'recipe_import_photo: the refused call isn''t counted');
select pg_temp.use('recipe_photo_import_usage', 'imports', '33333333-3333-3333-3333-333333333333', 1000);
select is(public.check_recipe_photo_limit('33333333-3333-3333-3333-333333333333'), 'ok', 'recipe_import_photo: unlimited passes');
update private.recipe_photo_import_usage set imports_this_minute = 5, minute_start = date_trunc('minute', now())
  where user_id = '33333333-3333-3333-3333-333333333333' and day = (now() at time zone 'utc')::date;
select is(public.check_recipe_photo_limit('33333333-3333-3333-3333-333333333333'), 'user_limit',
  'recipe_import_photo: unlimited is still held to the per-minute limit');
update public.plan_limits set monthly_limit = 21 where plan_id = 'plus' and feature = 'recipe_import_photo';
select is(public.check_recipe_photo_limit('11111111-1111-1111-1111-111111111111'), 'ok',
  'recipe_import_photo: raising plus''s row raises the limit at once');

-- AI photos (plus 15) -----------------------------------------------------------------
-- Plus owns household A with recipes R1–R3 and the deleted D; unlimited owns household U with R9.
insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Plus''s household'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Unlimited''s household');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '33333333-3333-3333-3333-333333333333', 'owner', 1);
insert into public.recipes (id, household_id, name, deleted_at) values
  ('a4000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Blueberry bread', null),
  ('a4000000-0000-7000-8000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tacos', null),
  ('a4000000-0000-7000-8000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Soup', null),
  ('a4000000-0000-7000-8000-00000000000d', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Gone', now()),
  ('a4000000-0000-7000-8000-000000000009', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Stew', null);

-- 14 reserved this month over three days (and 1,000 last month).
insert into private.recipe_photo_ai_usage (user_id, day, photos) values
  ('11111111-1111-1111-1111-111111111111', date_trunc('month', now() at time zone 'utc')::date, 6),
  ('11111111-1111-1111-1111-111111111111', date_trunc('month', now() at time zone 'utc')::date + 1, 4),
  ('11111111-1111-1111-1111-111111111111', date_trunc('month', now() at time zone 'utc')::date + 2, 4),
  ('11111111-1111-1111-1111-111111111111', date_trunc('month', now() at time zone 'utc')::date - 1, 1000);
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'recipe_photo_ai'), 14,
  'recipe_photo_ai: the month''s reservations, not last month''s');
select results_eq(
  $$ select * from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000001') $$,
  $$ values ('ok'::text, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid) $$,
  'recipe_photo_ai: the 15th reservation this month is fine');
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'recipe_photo_ai'), 15,
  'recipe_photo_ai: and is counted at the reservation');

create temp table before_ai as select * from private.recipe_photo_ai;
create temp table before_ai_usage as select * from private.recipe_photo_ai_usage;
select results_eq(
  $$ select * from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000002') $$,
  $$ values ('monthly_limit'::text, null::uuid) $$,
  'recipe_photo_ai: the 16th reservation in a month is monthly_limit for an older plus account');
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
select is(private.monthly_usage('11111111-1111-1111-1111-111111111111', 'recipe_photo_ai'), 15,
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
