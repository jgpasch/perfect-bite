-- match-recipe-steps rate limits (spec 6.8): per user 30 a minute and the plan's monthly
-- step_ingredients limit (plus: 100; 48_plan_limits covers each plan), no global cap, a refused
-- call uses no budget, the retention job, and only service_role can call it. now() is fixed within
-- the transaction, so every call lands in the same minute; the window reset is simulated by moving
-- minute_start back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(26);

-- Older than 30 days, so the default plan's (plus's) limits apply undoubled.
insert into auth.users (id, email, aud, role, created_at) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated', now() - interval '60 days'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated', now() - interval '60 days'),
  ('33333333-3333-3333-3333-333333333333', 'kim@test.local', 'authenticated', 'authenticated', now() - interval '60 days');

-- Per-minute limit ------------------------------------------------------------------
create temp table results (n int, result text);
insert into results
  select n, public.check_step_match_limit('11111111-1111-1111-1111-111111111111')
  from generate_series(1, 30) n;
select is((select count(*)::int from results where result = 'ok'), 30, '30 matches in a minute pass');
select is(public.check_step_match_limit('11111111-1111-1111-1111-111111111111'), 'user_limit',
  'the 31st match in a minute is refused');
select results_eq(
  $$ select requests_this_minute, matches from private.step_match_usage where user_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values (30, 30) $$, 'a refused match does not count');
select is(public.check_step_match_limit('22222222-2222-2222-2222-222222222222'), 'ok',
  'another user is not affected by the first user''s minute limit');

update private.step_match_usage set minute_start = minute_start - interval '1 minute'
  where user_id = '11111111-1111-1111-1111-111111111111';
select is(public.check_step_match_limit('11111111-1111-1111-1111-111111111111'), 'ok', 'the minute window resets');
select results_eq(
  $$ select requests_this_minute, minute_start, matches from private.step_match_usage
     where user_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values (1, date_trunc('minute', now()), 31) $$,
  'a new window starts at 1; the day keeps counting');

-- Monthly limit (plus: 100) -----------------------------------------------------------
-- 31 so far; run 69 more, a new minute window every 29, to reach exactly 100.
do $$
declare i int;
begin
  for i in 1..69 loop
    if i % 29 = 0 then
      update private.step_match_usage set minute_start = minute_start - interval '1 minute'
        where user_id = '11111111-1111-1111-1111-111111111111';
    end if;
    if public.check_step_match_limit('11111111-1111-1111-1111-111111111111') <> 'ok' then
      raise exception 'match % was refused', i;
    end if;
  end loop;
end $$;
select is((select matches from private.step_match_usage where user_id = '11111111-1111-1111-1111-111111111111'), 100,
  '100 matches a month pass');
update private.step_match_usage set minute_start = minute_start - interval '1 minute'
  where user_id = '11111111-1111-1111-1111-111111111111';
select is(public.check_step_match_limit('11111111-1111-1111-1111-111111111111'), 'monthly_limit',
  'the 101st match in a month is refused, even in a fresh minute');
select is((select matches from private.step_match_usage where user_id = '11111111-1111-1111-1111-111111111111'), 100,
  'the refused match is not counted');

-- No global cap (101 matches so far across users) --------------------------------------
select is(public.check_step_match_limit('33333333-3333-3333-3333-333333333333'), 'ok',
  'another user still gets matches, whatever others used');
select results_eq(
  $$ select requests_this_minute, matches from private.step_match_usage where user_id = '33333333-3333-3333-3333-333333333333' $$,
  $$ values (1, 1) $$, 'and it counts against their own limits');
select hasnt_function('public', 'check_step_match_limit', array['uuid', 'integer'],
  'the two-argument check_step_match_limit (with p_daily_cap) is gone');
select hasnt_table('private', 'step_match_daily_total', 'step_match_daily_total is gone');
select is((select command from cron.job where jobname = 'step-match-usage-retention'),
  $$delete from private.step_match_usage where day < (now() at time zone 'utc')::date - 40$$,
  'the retention job keeps step_match_usage 40 days, and prunes nothing else');

-- The other limits are separate -----------------------------------------------------------
select is(public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111'), 'ok',
  'a user out of step matches can still get tag suggestions');
select is((select count(*)::int from private.recipe_tags_usage where user_id = '33333333-3333-3333-3333-333333333333'), 0,
  'step matches don''t count against the tag limit');

-- Retention -----------------------------------------------------------------------------
insert into private.step_match_usage (user_id, day, minute_start) values
  ('22222222-2222-2222-2222-222222222222', (now() at time zone 'utc')::date - 41, now() - interval '41 days'),
  ('22222222-2222-2222-2222-222222222222', (now() at time zone 'utc')::date - 40, now() - interval '40 days');
select ok(exists (select 1 from cron.job where jobname = 'step-match-usage-retention'), 'usage retention job is scheduled');
do $$ begin execute (select command from cron.job where jobname = 'step-match-usage-retention'); end $$;
select is((select count(*)::int from private.step_match_usage where day < (now() at time zone 'utc')::date - 40), 0,
  'the retention job deletes usage rows older than 40 days');
select is((select count(*)::int from private.step_match_usage where day = (now() at time zone 'utc')::date - 40), 1,
  'and keeps the row 40 days old');
select is((select count(*)::int from private.step_match_usage), 4, 'and today''s');

-- Bad arguments and access ----------------------------------------------------------
select throws_ok($$ select public.check_step_match_limit(null) $$, '22023', null, 'a null user is rejected');

select ok(
  not has_function_privilege('authenticated', 'public.check_step_match_limit(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.check_step_match_limit(uuid)', 'execute')
  and not has_function_privilege('public', 'public.check_step_match_limit(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.check_step_match_limit(uuid)', 'execute'),
  'only service_role can call the limit function');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select public.check_step_match_limit('11111111-1111-1111-1111-111111111111') $$,
  '42501', null, 'authenticated cannot call the limit function');
select throws_ok($$ select * from private.step_match_usage $$, '42501', null, 'authenticated cannot read step_match_usage');

set local role anon;
select throws_ok($$ select public.check_step_match_limit('11111111-1111-1111-1111-111111111111') $$,
  '42501', null, 'anon cannot call the limit function');
select throws_ok($$ select * from private.step_match_usage $$, '42501', null, 'anon cannot read step_match_usage');

select * from finish();
rollback;
