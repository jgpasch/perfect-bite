-- Safety limits in a table (spec 4.12 Safety limits, 5): public.ai_safety_limits and its seed,
-- private.safety_limit, each check's per-minute ('user_limit') and daily ('daily_limit') refusals
-- read from the table on every call and counting nothing, null skipping a check, link and photo
-- imports sharing the daily `recipe_import` count, daily before monthly, no monthly refusal for
-- categorize, tags and step matching, reserve_recipe_photo_ai's 'blocked' first, and the portal's
-- admin_list_safety_limits and admin_set_safety_limit. now() is fixed within the transaction, so
-- every call lands in the same minute and day; a new minute is simulated by moving minute_start
-- back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(67);

-- Fixtures (as postgres) ------------------------------------------------------
-- boss is an admin. Una's household is on unlimited (no monthly limit, so only the safety limits
-- refuse); Fay's is on founding (60 days old). Each has a recipe.
insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'boss@safety.test', 'authenticated', 'authenticated'),
  ('11111111-1111-1111-1111-111111111111', 'una@safety.test', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'fay@safety.test', 'authenticated', 'authenticated');
insert into private.admins (user_id) values ('aaaaaaaa-0000-4000-8000-000000000001');
insert into public.households (id, name, created_at) values
  ('c1000000-0000-4000-8000-000000000001', 'Una''s', now() - interval '60 days'),
  ('c2000000-0000-4000-8000-000000000002', 'Fay''s', now() - interval '60 days');
insert into public.household_members (household_id, user_id, role, position) values
  ('c1000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('c2000000-0000-4000-8000-000000000002', '22222222-2222-2222-2222-222222222222', 'owner', 1);
insert into public.household_plans (household_id, plan_id) values
  ('c1000000-0000-4000-8000-000000000001', 'unlimited'),
  ('c2000000-0000-4000-8000-000000000002', 'founding');
insert into public.recipes (id, household_id, name) values
  ('a6000000-0000-7000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'Soup'),
  ('a6000000-0000-7000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'Stew'),
  ('a6000000-0000-7000-8000-000000000003', 'c1000000-0000-4000-8000-000000000001', 'Pie'),
  ('a6000000-0000-7000-8000-000000000004', 'c2000000-0000-4000-8000-000000000002', 'Tart');

-- Starts a new minute for a user's usage row on a table, so the per-minute limit is out of play.
create function pg_temp.new_minute(p_table text, p_user uuid)
returns void
language plpgsql
as $$
begin
  execute format('update private.%I set minute_start = minute_start - interval ''1 minute'' where user_id = $1', p_table)
  using p_user;
end;
$$;

-- The table ------------------------------------------------------------------------
select set_eq(
  $$ select key, per_minute, per_day from public.ai_safety_limits $$,
  $$ values ('categorize', 60, 500), ('step_match', 30, 100), ('recipe_tags', 20, 50),
            ('recipe_import_link', 10, null::int), ('recipe_import_photo', 5, null),
            ('recipe_import', null, 100), ('recipe_photo_ai', null, 40), ('share_ingest', 30, null) $$,
  'ai_safety_limits holds exactly the seeded rows');
select col_is_pk('public', 'ai_safety_limits', array['key'], 'the key is the primary key');
select throws_ok($$ insert into public.ai_safety_limits values ('summarize', 1, 1) $$, '23514', null,
  'an unknown key is rejected');
select throws_ok($$ update public.ai_safety_limits set per_minute = -1 where key = 'categorize' $$, '23514', null,
  'a negative per_minute is rejected');
select throws_ok($$ update public.ai_safety_limits set per_day = -1 where key = 'categorize' $$, '23514', null,
  'a negative per_day is rejected');
select ok((select relrowsecurity from pg_class where oid = 'public.ai_safety_limits'::regclass), 'RLS is on');
select ok(
  not has_table_privilege('authenticated', 'public.ai_safety_limits', 'select')
  and not has_table_privilege('authenticated', 'public.ai_safety_limits', 'update')
  and not has_table_privilege('anon', 'public.ai_safety_limits', 'select'),
  'clients have no privileges on ai_safety_limits');
select ok(
  not has_function_privilege('authenticated', 'private.safety_limit(text)', 'execute')
  and not has_function_privilege('service_role', 'private.safety_limit(text)', 'execute'),
  'clients can''t call private.safety_limit');
select is((private.safety_limit('step_match')).per_day, 100, 'safety_limit reads a row');
select is((private.safety_limit('nonsense')).per_minute, null::int, 'an unknown key reads as no limit');

-- categorize ----------------------------------------------------------------------
update public.ai_safety_limits set per_minute = 2, per_day = 10 where key = 'categorize';
select is(array[public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 4),
                public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 4)],
  array['ok', 'ok'], 'categorize: two requests a minute pass when the row says 2');
create temp table before_usage as select * from private.categorize_usage;
select is(public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 0), 'user_limit',
  'categorize: the third is user_limit');
select set_eq($$ select * from private.categorize_usage $$, $$ select * from before_usage $$,
  'categorize: the refusal counts nothing');
update public.ai_safety_limits set per_minute = 3 where key = 'categorize';
select is(public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 0), 'ok',
  'categorize: raising per_minute applies on the next call');
select pg_temp.new_minute('categorize_usage', '11111111-1111-1111-1111-111111111111');
-- 8 names today; 10 a day.
select is(public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 3), 'daily_limit',
  'categorize: names past the day''s 10 are daily_limit');
select is((select array[requests_this_minute, new_names] from private.categorize_usage
           where user_id = '11111111-1111-1111-1111-111111111111'), array[3, 8],
  'categorize: the daily refusal counts nothing');
select is(public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 0), 'ok',
  'categorize: a request with no new names isn''t held to the daily names');
select is(public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 2), 'ok',
  'categorize: exactly 10 names a day pass');
update public.ai_safety_limits set per_day = 11 where key = 'categorize';
select is(public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 1), 'ok',
  'categorize: raising per_day applies on the next call');
update public.ai_safety_limits set per_minute = null, per_day = null where key = 'categorize';
select is(public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 5000), 'ok',
  'categorize: null per_minute and per_day skip both checks');

-- recipe_tags and step_match ---------------------------------------------------------
update public.ai_safety_limits set per_minute = 1, per_day = 2 where key = 'recipe_tags';
select is(array[public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111'),
                public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111')],
  array['ok', 'user_limit'], 'recipe_tags: per_minute 1 refuses the second call');
select pg_temp.new_minute('recipe_tags_usage', '11111111-1111-1111-1111-111111111111');
select is(public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111'), 'ok', 'recipe_tags: a new minute passes');
select pg_temp.new_minute('recipe_tags_usage', '11111111-1111-1111-1111-111111111111');
select is(public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111'), 'daily_limit',
  'recipe_tags: the third in a day is daily_limit');
select is((select suggestions from private.recipe_tags_usage where user_id = '11111111-1111-1111-1111-111111111111'), 2,
  'recipe_tags: the daily refusal counts nothing');
update public.ai_safety_limits set per_day = null where key = 'recipe_tags';
select is(public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111'), 'ok',
  'recipe_tags: a null per_day skips the daily check');

update public.ai_safety_limits set per_minute = 1, per_day = 2 where key = 'step_match';
select is(array[public.check_step_match_limit('11111111-1111-1111-1111-111111111111'),
                public.check_step_match_limit('11111111-1111-1111-1111-111111111111')],
  array['ok', 'user_limit'], 'step_match: per_minute 1 refuses the second call');
select pg_temp.new_minute('step_match_usage', '11111111-1111-1111-1111-111111111111');
select is(public.check_step_match_limit('11111111-1111-1111-1111-111111111111'), 'ok', 'step_match: a new minute passes');
select pg_temp.new_minute('step_match_usage', '11111111-1111-1111-1111-111111111111');
select is(public.check_step_match_limit('11111111-1111-1111-1111-111111111111'), 'daily_limit',
  'step_match: the third in a day is daily_limit');
select is((select matches from private.step_match_usage where user_id = '11111111-1111-1111-1111-111111111111'), 2,
  'step_match: the daily refusal counts nothing');
update public.ai_safety_limits set per_minute = null where key = 'step_match';
update private.step_match_usage set requests_this_minute = 1000, minute_start = date_trunc('minute', now())
  where user_id = '11111111-1111-1111-1111-111111111111';
update public.ai_safety_limits set per_day = 3 where key = 'step_match';
select is(public.check_step_match_limit('11111111-1111-1111-1111-111111111111'), 'ok',
  'step_match: a null per_minute skips the minute check, and a raised per_day applies at once');

-- No monthly refusal for categorize, tags and step matching ----------------------------
-- Fay is on founding; a huge month (yesterday) doesn't refuse today.
insert into private.categorize_usage (user_id, day, minute_start, new_names) values
  ('22222222-2222-2222-2222-222222222222', (now() at time zone 'utc')::date - 1, now() - interval '1 day', 100000);
insert into private.recipe_tags_usage (user_id, day, minute_start, suggestions) values
  ('22222222-2222-2222-2222-222222222222', (now() at time zone 'utc')::date - 1, now() - interval '1 day', 100000);
insert into private.step_match_usage (user_id, day, minute_start, matches) values
  ('22222222-2222-2222-2222-222222222222', (now() at time zone 'utc')::date - 1, now() - interval '1 day', 100000);
update public.ai_safety_limits set per_minute = 60, per_day = 500 where key = 'categorize';
update public.ai_safety_limits set per_minute = 20, per_day = 50 where key = 'recipe_tags';
update public.ai_safety_limits set per_minute = 30, per_day = 100 where key = 'step_match';
select is(array[public.check_categorize_limit('22222222-2222-2222-2222-222222222222', 10),
                public.check_recipe_tags_limit('22222222-2222-2222-2222-222222222222'),
                public.check_step_match_limit('22222222-2222-2222-2222-222222222222')],
  array['ok', 'ok', 'ok'], 'categorize, tags and step matching have no monthly refusal');

-- Imports: link and photo ---------------------------------------------------------------
update public.ai_safety_limits set per_minute = 2 where key = 'recipe_import_link';
update public.ai_safety_limits set per_minute = 1 where key = 'recipe_import_photo';
update public.ai_safety_limits set per_day = 4 where key = 'recipe_import';
select is(array[public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'c1000000-0000-4000-8000-000000000001'),
                public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'c1000000-0000-4000-8000-000000000001'),
                public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'c1000000-0000-4000-8000-000000000001')],
  array['ok', 'ok', 'user_limit'], 'link import: recipe_import_link''s per_minute 2 refuses the third');
select is(array[public.check_recipe_photo_limit('11111111-1111-1111-1111-111111111111', 'c1000000-0000-4000-8000-000000000001'),
                public.check_recipe_photo_limit('11111111-1111-1111-1111-111111111111', 'c1000000-0000-4000-8000-000000000001')],
  array['ok', 'user_limit'], 'photo import: recipe_import_photo''s per_minute 1 refuses the second');
update public.ai_safety_limits set per_minute = 2 where key = 'recipe_import_photo';
select is(public.check_recipe_photo_limit('11111111-1111-1111-1111-111111111111', 'c1000000-0000-4000-8000-000000000001'), 'ok',
  'photo import: raising per_minute applies on the next call');
-- 2 link and 2 photo imports today: recipe_import's 4 a day is reached by both kinds together.
select pg_temp.new_minute('recipe_import_usage', '11111111-1111-1111-1111-111111111111');
select pg_temp.new_minute('recipe_photo_import_usage', '11111111-1111-1111-1111-111111111111');
create temp table before_imports as
  select 'link' as kind, requests_this_minute, minute_start, imports from private.recipe_import_usage
  union all select 'photo', imports_this_minute, minute_start, imports from private.recipe_photo_import_usage;
select is(array[public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'c1000000-0000-4000-8000-000000000001'),
                public.check_recipe_photo_limit('11111111-1111-1111-1111-111111111111', 'c1000000-0000-4000-8000-000000000001')],
  array['daily_limit', 'daily_limit'], 'imports: link and photo share recipe_import''s daily count');
select set_eq(
  $$ select 'link' as kind, requests_this_minute, minute_start, imports from private.recipe_import_usage
     union all select 'photo', imports_this_minute, minute_start, imports from private.recipe_photo_import_usage $$,
  $$ select * from before_imports $$,
  'imports: the daily refusals count nothing');
update public.ai_safety_limits set per_day = 5 where key = 'recipe_import';
select is(array[public.check_recipe_photo_limit('11111111-1111-1111-1111-111111111111', 'c1000000-0000-4000-8000-000000000001'),
                public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'c1000000-0000-4000-8000-000000000001')],
  array['ok', 'daily_limit'], 'imports: raising recipe_import''s per_day lets one more through, of either kind');
update public.ai_safety_limits set per_day = 4 where key = 'recipe_import_link';
update public.ai_safety_limits set per_day = null where key = 'recipe_import';
select pg_temp.new_minute('recipe_import_usage', '11111111-1111-1111-1111-111111111111');
select is(array[public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'c1000000-0000-4000-8000-000000000001'),
                public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'c1000000-0000-4000-8000-000000000001')],
  array['ok', 'ok'], 'imports: a null recipe_import per_day skips the shared daily check');
select pg_temp.new_minute('recipe_import_usage', '11111111-1111-1111-1111-111111111111');
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'c1000000-0000-4000-8000-000000000001'), 'daily_limit',
  'imports: recipe_import_link''s own per_day, when set, refuses link imports');
select is((select imports from private.recipe_import_usage where user_id = '11111111-1111-1111-1111-111111111111'), 4,
  'imports: and counts nothing');
-- recipe_import's per_minute, when set, counts both kinds in the minute.
update public.ai_safety_limits set per_day = null where key = 'recipe_import_link';
update public.ai_safety_limits set per_minute = 1 where key = 'recipe_import';
select pg_temp.new_minute('recipe_import_usage', '11111111-1111-1111-1111-111111111111');
select pg_temp.new_minute('recipe_photo_import_usage', '11111111-1111-1111-1111-111111111111');
select is(array[public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'c1000000-0000-4000-8000-000000000001'),
                public.check_recipe_photo_limit('11111111-1111-1111-1111-111111111111', 'c1000000-0000-4000-8000-000000000001')],
  array['ok', 'user_limit'], 'imports: recipe_import''s per_minute counts link and photo together');
update public.ai_safety_limits set per_minute = null where key = 'recipe_import';
update public.ai_safety_limits set per_minute = null where key in ('recipe_import_link', 'recipe_import_photo');
update private.recipe_import_usage set requests_this_minute = 1000 where user_id = '11111111-1111-1111-1111-111111111111';
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'c1000000-0000-4000-8000-000000000001'), 'ok',
  'imports: null per_minute everywhere skips the minute checks');

-- Daily before monthly: Fay's 60 imports today use up founding's 50 a month and the day's 3.
update public.ai_safety_limits set per_minute = 10 where key = 'recipe_import_link';
update public.ai_safety_limits set per_day = 3 where key = 'recipe_import';
insert into private.recipe_import_usage (user_id, day, minute_start, imports) values
  ('22222222-2222-2222-2222-222222222222', (now() at time zone 'utc')::date, now() - interval '1 hour', 60);
insert into private.household_ai_usage (household_id, feature, day, used) values
  ('c2000000-0000-4000-8000-000000000002', 'recipe_import', (now() at time zone 'utc')::date, 60);
select is(public.check_recipe_import_limit('22222222-2222-2222-2222-222222222222', 'c2000000-0000-4000-8000-000000000002'), 'daily_limit',
  'imports: daily_limit comes before monthly_limit');
update public.ai_safety_limits set per_day = null where key = 'recipe_import';
select is(public.check_recipe_import_limit('22222222-2222-2222-2222-222222222222', 'c2000000-0000-4000-8000-000000000002'), 'monthly_limit',
  'imports: with the day lifted, the month refuses');
select is((select array[(select imports from private.recipe_import_usage
                         where user_id = '22222222-2222-2222-2222-222222222222'),
                        private.monthly_usage('c2000000-0000-4000-8000-000000000002', 'recipe_import')]),
  array[60, 60], 'imports: neither refusal counts');

-- AI photos -----------------------------------------------------------------------------
update public.ai_safety_limits set per_minute = null, per_day = 1 where key = 'recipe_photo_ai';
select results_eq(
  $$ select * from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a6000000-0000-7000-8000-000000000001') $$,
  $$ values ('ok'::text, 'c1000000-0000-4000-8000-000000000001'::uuid) $$,
  'recipe_photo_ai: the first photo of the day is reserved');
create temp table before_ai as select * from private.recipe_photo_ai;
create temp table before_ai_usage as select * from private.recipe_photo_ai_usage;
select results_eq(
  $$ select * from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a6000000-0000-7000-8000-000000000002') $$,
  $$ values ('daily_limit'::text, null::uuid) $$,
  'recipe_photo_ai: past per_day 1 is daily_limit, even on unlimited');
select ok(
  (select count(*) from (select * from private.recipe_photo_ai except select * from before_ai) d) = 0
  and (select count(*) from (select * from private.recipe_photo_ai_usage except select * from before_ai_usage) d) = 0
  and (select count(*) from (select * from before_ai_usage except select * from private.recipe_photo_ai_usage) d) = 0,
  'recipe_photo_ai: daily_limit writes nothing');
select results_eq(
  $$ select status from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a6000000-0000-7000-8000-000000000001') $$,
  $$ values ('already_generated'::text) $$,
  'recipe_photo_ai: already_generated comes before the safety limits');
update public.ai_safety_limits set per_minute = 1, per_day = 5 where key = 'recipe_photo_ai';
select results_eq(
  $$ select status from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a6000000-0000-7000-8000-000000000002') $$,
  $$ values ('user_limit'::text) $$,
  'recipe_photo_ai: per_minute 1 refuses a second photo in the minute');
update public.ai_safety_limits set per_minute = null where key = 'recipe_photo_ai';
select results_eq(
  $$ select status from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a6000000-0000-7000-8000-000000000002') $$,
  $$ values ('ok'::text) $$,
  'recipe_photo_ai: a null per_minute skips it, and the raised per_day applies at once');
select is((select array[photos, requests_this_minute] from private.recipe_photo_ai_usage
           where user_id = '11111111-1111-1111-1111-111111111111'), array[2, 2],
  'recipe_photo_ai: reservations count the day and the minute');
update public.ai_safety_limits set per_day = 0 where key = 'recipe_photo_ai';
insert into private.ai_photo_blocks (user_id, refusals) values ('11111111-1111-1111-1111-111111111111', 3);
select results_eq(
  $$ select status from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a6000000-0000-7000-8000-000000000003') $$,
  $$ values ('blocked'::text) $$,
  'recipe_photo_ai: blocked comes before any limit check');
update public.ai_safety_limits set per_day = null where key = 'recipe_photo_ai';
delete from private.ai_photo_blocks;
select results_eq(
  $$ select status from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a6000000-0000-7000-8000-000000000003') $$,
  $$ values ('ok'::text) $$,
  'recipe_photo_ai: a null per_day skips the daily check');

-- The portal ------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.admin_list_safety_limits()', 'execute')
  and not has_function_privilege('anon', 'public.admin_set_safety_limit(text, integer, integer, text)', 'execute')
  and not has_function_privilege('service_role', 'public.admin_list_safety_limits()', 'execute')
  and not has_function_privilege('service_role', 'public.admin_set_safety_limit(text, integer, integer, text)', 'execute')
  and has_function_privilege('authenticated', 'public.admin_list_safety_limits()', 'execute')
  and has_function_privilege('authenticated', 'public.admin_set_safety_limit(text, integer, integer, text)', 'execute'),
  'only authenticated can execute the safety limit functions');

update public.ai_safety_limits set per_minute = 60, per_day = 500 where key = 'categorize';
update public.ai_safety_limits set per_minute = 30, per_day = 100 where key = 'step_match';
update public.ai_safety_limits set per_minute = 20, per_day = 50 where key = 'recipe_tags';
update public.ai_safety_limits set per_minute = 10, per_day = null where key = 'recipe_import_link';
update public.ai_safety_limits set per_minute = 5, per_day = null where key = 'recipe_import_photo';
update public.ai_safety_limits set per_minute = null, per_day = 100 where key = 'recipe_import';
update public.ai_safety_limits set per_minute = null, per_day = 40 where key = 'recipe_photo_ai';
create temp table audit_before as select count(*) as n from admin.admin_actions;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select public.admin_list_safety_limits() $$, '42501', 'not authorized',
  'a non-admin can''t list the safety limits');
select throws_ok($$ select public.admin_set_safety_limit('categorize', 1, 1, 'why') $$, '42501', 'not authorized',
  'a non-admin can''t set a safety limit');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(public.admin_list_safety_limits(),
  '[{"key": "categorize", "per_minute": 60, "per_day": 500},
    {"key": "step_match", "per_minute": 30, "per_day": 100},
    {"key": "recipe_tags", "per_minute": 20, "per_day": 50},
    {"key": "recipe_import_link", "per_minute": 10, "per_day": null},
    {"key": "recipe_import_photo", "per_minute": 5, "per_day": null},
    {"key": "recipe_import", "per_minute": null, "per_day": 100},
    {"key": "recipe_photo_ai", "per_minute": null, "per_day": 40},
    {"key": "share_ingest", "per_minute": 30, "per_day": null}]'::jsonb,
  'admin_list_safety_limits lists every key in order');
select throws_ok($$ select public.admin_set_safety_limit('categorize', 1, 1, '  ') $$, '22023', 'note required',
  'a blank note is refused');
select throws_ok($$ select public.admin_set_safety_limit('categorize', 1, 1, null) $$, '22023', 'note required',
  'a null note is refused');
select throws_ok($$ select public.admin_set_safety_limit('summarize', 1, 1, 'why') $$, 'P0002', 'unknown key',
  'an unknown key is refused');
select throws_ok($$ select public.admin_set_safety_limit('categorize', -1, 1, 'why') $$, '23514', null,
  'a negative number is refused');
select is(public.admin_set_safety_limit('recipe_import', 3, null, 'Scripted account seen'),
  '{"before": {"key": "recipe_import", "per_minute": null, "per_day": 100},
    "after": {"key": "recipe_import", "per_minute": 3, "per_day": null}}'::jsonb,
  'admin_set_safety_limit returns before and after');
reset role;

select is((select count(*) from admin.admin_actions), (select n + 1 from audit_before),
  'only the accepted call wrote an audit row');
select is((select array[per_minute, per_day] from public.ai_safety_limits where key = 'recipe_import'), array[3, null]::int[],
  'the row is changed');
select is((select per_minute from public.ai_safety_limits where key = 'categorize'), 60,
  'the refused calls changed nothing');
select results_eq(
  $$ select action, note, performed_by, details from admin.admin_actions where action = 'set_safety_limit' $$,
  $$ values ('set_safety_limit'::text, 'Scripted account seen'::text, 'aaaaaaaa-0000-4000-8000-000000000001'::text,
       '{"before": {"key": "recipe_import", "per_minute": null, "per_day": 100},
         "after": {"key": "recipe_import", "per_minute": 3, "per_day": null}}'::jsonb) $$,
  'the change is audited as set_safety_limit with the admin, the note and before and after');

select * from finish();
rollback;
