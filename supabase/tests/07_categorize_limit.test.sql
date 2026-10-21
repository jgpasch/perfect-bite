-- categorize-ingredients rate limits (spec 6.4). now() is fixed within the transaction, so every
-- call below lands in the same minute; the window reset is simulated by moving minute_start back.
-- There is no global cap (20261112120000_drop_global_caps.sql): only the per-user limits refuse,
-- per minute. Categorize has had no monthly limit since 20261129120000_household_plans.
begin;
create extension if not exists pgtap with schema extensions;
select plan(31);

insert into auth.users (id, email, aud, role, created_at) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated', now() - interval '60 days'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated', now() - interval '60 days'),
  ('33333333-3333-3333-3333-333333333333', 'kim@test.local', 'authenticated', 'authenticated', now() - interval '60 days'),
  ('44444444-4444-4444-4444-444444444444', 'lee@test.local', 'authenticated', 'authenticated', now() - interval '60 days');

create temp table results (n int, result text);

-- Per-minute limit ------------------------------------------------------------------
insert into results
  select n, public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 0)
  from generate_series(1, 60) n;
select is((select count(*)::int from results where result = 'ok'), 60, '60 requests in a minute pass');
select is(public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 0), 'user_limit',
  'the 61st request in a minute is refused, even with 0 new names');
select is(public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 3), 'user_limit',
  'the 62nd request (with new names) is refused too');
select is((select requests_this_minute from private.categorize_usage where user_id = '11111111-1111-1111-1111-111111111111'),
  60, 'refused requests do not count toward the minute');
select is(public.check_categorize_limit('22222222-2222-2222-2222-222222222222', 0), 'ok',
  'another user is not affected by the first user''s minute limit');

update private.categorize_usage set minute_start = minute_start - interval '1 minute'
  where user_id = '11111111-1111-1111-1111-111111111111';
select is(public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 2), 'ok',
  'the minute window resets');
select results_eq(
  $$ select requests_this_minute, minute_start, new_names from private.categorize_usage
     where user_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values (1, date_trunc('minute', now()), 2) $$,
  'a new window starts at 1 request at the current minute');

-- No monthly name limit ---------------------------------------------------------------
-- Categorize is for everyone (20261129120000_household_plans): no plan feature, no monthly limit.
-- now() is fixed, so these all land on one day: the daily safety limit (60_ai_safety_limits) is
-- lifted here.
update public.ai_safety_limits set per_day = null where key = 'categorize';
select is(public.check_categorize_limit('22222222-2222-2222-2222-222222222222', 250), 'ok', '250 new names pass');
select is(public.check_categorize_limit('22222222-2222-2222-2222-222222222222', 1), 'ok',
  'the 251st new name passes too: there is no monthly limit');
select is(public.check_categorize_limit('22222222-2222-2222-2222-222222222222', 0), 'ok',
  'a request with 0 new names passes');
select is(public.check_categorize_limit('33333333-3333-3333-3333-333333333333', 251), 'ok',
  '251 new names in one request pass');
select is(public.check_categorize_limit('33333333-3333-3333-3333-333333333333', 10000), 'ok',
  'a batch of 10000 names passes');
select is((select new_names from private.categorize_usage where user_id = '33333333-3333-3333-3333-333333333333'),
  10251, 'usage still counts every name');
select is(private.monthly_limit('33333333-3333-3333-3333-333333333333'::uuid, 'categorize'), null,
  'categorize has no monthly limit');

-- Refused requests change nothing ----------------------------------------------------
-- Only the minute limit refuses now: fill Sam's minute.
update private.categorize_usage set requests_this_minute = 60, minute_start = date_trunc('minute', now())
  where user_id = '22222222-2222-2222-2222-222222222222';
create temp table before_usage as select * from private.categorize_usage;
select is(public.check_categorize_limit('22222222-2222-2222-2222-222222222222', 5), 'user_limit', 'refused (minute limit)');
select set_eq($$ select * from private.categorize_usage $$, $$ select * from before_usage $$,
  'a refused request leaves the usage rows unchanged');

-- No global cap ----------------------------------------------------------------------
-- 10504 names so far across users; a fresh user's names still pass, whatever everyone used.
select is(public.check_categorize_limit('44444444-4444-4444-4444-444444444444', 250), 'ok',
  'a fresh user''s names pass, whatever others used');
select is((select sum(new_names)::int from private.categorize_usage), 10754, 'usage still counts each user''s names');
-- A household whose plan has no features (free) still categorizes.
insert into public.households (id, name) values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Lee''s household');
insert into public.household_members (household_id, user_id, role, position) values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', '44444444-4444-4444-4444-444444444444', 'owner', 1);
insert into public.household_plans (household_id, plan_id) values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'free');
select is(public.check_categorize_limit('44444444-4444-4444-4444-444444444444', 1), 'ok',
  'a user whose household is on free still categorizes');

-- Null user (the pg_cron sweep) -------------------------------------------------------
create temp table sweep as
  select public.check_categorize_limit(null, 0) as result from generate_series(1, 61);
select is((select count(*)::int from sweep where result = 'ok'), 61, 'a null user skips the per-minute limit');
select is(public.check_categorize_limit(null, 100000), 'ok', 'a null user has no name limit');
select is((select count(*)::int from private.categorize_usage), 4, 'a null user writes no usage row');

-- The old signature and table are gone -----------------------------------------------
select hasnt_function('public', 'check_categorize_limit', array['uuid', 'integer', 'integer'],
  'the three-argument check_categorize_limit (with p_daily_cap) is gone');
select hasnt_table('private', 'categorize_daily_total', 'categorize_daily_total is gone');
select ok(
  (select command from cron.job where jobname = 'categorize-usage-retention')
    = $$delete from private.categorize_usage where day < (now() at time zone 'utc')::date - 40$$,
  'the retention job keeps categorize_usage 40 days, and prunes nothing else');

-- Access ----------------------------------------------------------------------------
select throws_ok($$ select public.check_categorize_limit(null, -1) $$, '22023', null, 'negative names are rejected');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select ok(
  not has_function_privilege('authenticated', 'public.check_categorize_limit(uuid, integer)', 'execute')
  and not has_function_privilege('anon', 'public.check_categorize_limit(uuid, integer)', 'execute')
  and not has_function_privilege('public', 'public.check_categorize_limit(uuid, integer)', 'execute')
  and not has_table_privilege('authenticated', 'private.categorize_usage', 'select')
  and not has_table_privilege('anon', 'private.categorize_usage', 'select')
  and has_function_privilege('service_role', 'public.check_categorize_limit(uuid, integer)', 'execute'),
  'only service_role can call the function; clients can''t read the usage table');
select throws_ok($$ select public.check_categorize_limit('11111111-1111-1111-1111-111111111111', 0) $$,
  '42501', null, 'authenticated cannot call the function');
select throws_ok($$ select * from private.categorize_usage $$, '42501', null, 'authenticated cannot read categorize_usage');

set local role anon;
select throws_ok($$ select public.check_categorize_limit(null, 0) $$, '42501', null, 'anon cannot call the function');
select throws_ok($$ select * from private.categorize_usage $$, '42501', null, 'anon cannot read categorize_usage');

select * from finish();
rollback;
