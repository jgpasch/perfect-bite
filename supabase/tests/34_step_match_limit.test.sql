-- match-recipe-steps rate limits (spec 6.8): per user 30 a minute and 300 a day, the global daily
-- cap, a refused call uses no budget, the retention job, and only service_role can call it.
-- now() is fixed within the transaction, so every call lands in the same minute; the window reset
-- is simulated by moving minute_start back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(28);

insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'kim@test.local', 'authenticated', 'authenticated');

-- Per-minute limit ------------------------------------------------------------------
create temp table results (n int, result text);
insert into results
  select n, public.check_step_match_limit('11111111-1111-1111-1111-111111111111', 5000)
  from generate_series(1, 30) n;
select is((select count(*)::int from results where result = 'ok'), 30, '30 matches in a minute pass');
select is(public.check_step_match_limit('11111111-1111-1111-1111-111111111111', 5000), 'user_limit',
  'the 31st match in a minute is refused');
select results_eq(
  $$ select requests_this_minute, matches from private.step_match_usage where user_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values (30, 30) $$, 'a refused match does not count');
select is(public.check_step_match_limit('22222222-2222-2222-2222-222222222222', 5000), 'ok',
  'another user is not affected by the first user''s minute limit');

update private.step_match_usage set minute_start = minute_start - interval '1 minute'
  where user_id = '11111111-1111-1111-1111-111111111111';
select is(public.check_step_match_limit('11111111-1111-1111-1111-111111111111', 5000), 'ok', 'the minute window resets');
select results_eq(
  $$ select requests_this_minute, minute_start, matches from private.step_match_usage
     where user_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values (1, date_trunc('minute', now()), 31) $$,
  'a new window starts at 1; the day keeps counting');

-- Per-user daily limit ----------------------------------------------------------------
-- 31 so far; run 269 more, a new minute window every 29, to reach exactly 300.
do $$
declare i int;
begin
  for i in 1..269 loop
    if i % 29 = 0 then
      update private.step_match_usage set minute_start = minute_start - interval '1 minute'
        where user_id = '11111111-1111-1111-1111-111111111111';
    end if;
    if public.check_step_match_limit('11111111-1111-1111-1111-111111111111', 5000) <> 'ok' then
      raise exception 'match % was refused', i;
    end if;
  end loop;
end $$;
select is((select matches from private.step_match_usage where user_id = '11111111-1111-1111-1111-111111111111'), 300,
  '300 matches a day pass');
update private.step_match_usage set minute_start = minute_start - interval '1 minute'
  where user_id = '11111111-1111-1111-1111-111111111111';
select is(public.check_step_match_limit('11111111-1111-1111-1111-111111111111', 5000), 'user_limit',
  'the 301st match in a day is refused, even in a fresh minute');
select is((select matches from private.step_match_usage where user_id = '11111111-1111-1111-1111-111111111111'), 300,
  'the refused match is not counted');

-- Global cap (the total is now 300 + 1 = 301) ------------------------------------------
select is((select matches from private.step_match_daily_total), 301, 'the global total counts every user''s matches');
select is(public.check_step_match_limit('33333333-3333-3333-3333-333333333333', 301), 'global_cap', 'the global cap refuses once reached');
select results_eq(
  $$ select requests_this_minute, matches from private.step_match_usage where user_id = '33333333-3333-3333-3333-333333333333' $$,
  $$ values (0, 0) $$, 'a request refused by the global cap uses none of the user''s budget');
select is((select matches from private.step_match_daily_total), 301, 'nor the global budget');
select is(public.check_step_match_limit('33333333-3333-3333-3333-333333333333', 302), 'ok', 'one under the cap passes');
select is(public.check_step_match_limit('22222222-2222-2222-2222-222222222222', 302), 'global_cap',
  'the cap refuses every user, even one well under their own limit');
select is(public.check_step_match_limit('22222222-2222-2222-2222-222222222222', 0), 'global_cap', 'a cap of 0 refuses everything');

-- The other limits are separate -----------------------------------------------------------
select is(public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111', 2000), 'ok',
  'a user out of step matches can still get tag suggestions');
select is((select count(*)::int from private.recipe_tags_usage where user_id = '33333333-3333-3333-3333-333333333333'), 0,
  'step matches don''t count against the tag limit');

-- Retention -----------------------------------------------------------------------------
insert into private.step_match_usage (user_id, day, minute_start)
  values ('22222222-2222-2222-2222-222222222222', (now() at time zone 'utc')::date - 2, now() - interval '2 days');
select ok(exists (select 1 from cron.job where jobname = 'step-match-usage-retention'), 'usage retention job is scheduled');
do $$ begin execute (select command from cron.job where jobname = 'step-match-usage-retention'); end $$;
select is((select count(*)::int from private.step_match_usage where day < (now() at time zone 'utc')::date), 0,
  'the retention job deletes old usage rows');
select is((select count(*)::int from private.step_match_usage), 3, 'and keeps today''s');

-- Bad arguments and access ----------------------------------------------------------
select throws_ok($$ select public.check_step_match_limit(null, 10) $$, '22023', null, 'a null user is rejected');
select throws_ok($$ select public.check_step_match_limit('22222222-2222-2222-2222-222222222222', -1) $$,
  '22023', null, 'a negative cap is rejected');

select ok(
  not has_function_privilege('authenticated', 'public.check_step_match_limit(uuid, integer)', 'execute')
  and not has_function_privilege('anon', 'public.check_step_match_limit(uuid, integer)', 'execute')
  and not has_function_privilege('public', 'public.check_step_match_limit(uuid, integer)', 'execute')
  and has_function_privilege('service_role', 'public.check_step_match_limit(uuid, integer)', 'execute'),
  'only service_role can call the limit function');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select public.check_step_match_limit('11111111-1111-1111-1111-111111111111', 5000) $$,
  '42501', null, 'authenticated cannot call the limit function');
select throws_ok($$ select * from private.step_match_usage $$, '42501', null, 'authenticated cannot read step_match_usage');

set local role anon;
select throws_ok($$ select public.check_step_match_limit('11111111-1111-1111-1111-111111111111', 5000) $$,
  '42501', null, 'anon cannot call the limit function');
select throws_ok($$ select * from private.step_match_daily_total $$, '42501', null, 'anon cannot read step_match_daily_total');

select * from finish();
rollback;
