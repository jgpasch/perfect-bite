-- suggest-recipe-tags rate limits (spec 6.7): per user 20 a minute and 100 a day, the global
-- daily cap, a refused call uses no budget, the retention job, and only service_role can call it.
-- now() is fixed within the transaction, so every call lands in the same minute; the window reset
-- is simulated by moving minute_start back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'kim@test.local', 'authenticated', 'authenticated');

-- Per-minute limit ------------------------------------------------------------------
create temp table results (n int, result text);
insert into results
  select n, public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111', 2000)
  from generate_series(1, 20) n;
select is((select count(*)::int from results where result = 'ok'), 20, '20 suggestions in a minute pass');
select is(public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111', 2000), 'user_limit',
  'the 21st suggestion in a minute is refused');
select results_eq(
  $$ select requests_this_minute, suggestions from private.recipe_tags_usage where user_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values (20, 20) $$, 'a refused suggestion does not count');
select is(public.check_recipe_tags_limit('22222222-2222-2222-2222-222222222222', 2000), 'ok',
  'another user is not affected by the first user''s minute limit');

update private.recipe_tags_usage set minute_start = minute_start - interval '1 minute'
  where user_id = '11111111-1111-1111-1111-111111111111';
select is(public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111', 2000), 'ok', 'the minute window resets');
select results_eq(
  $$ select requests_this_minute, minute_start, suggestions from private.recipe_tags_usage
     where user_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values (1, date_trunc('minute', now()), 21) $$,
  'a new window starts at 1; the day keeps counting');

-- Per-user daily limit ----------------------------------------------------------------
-- 21 so far; run 79 more, a minute window every 20, to reach exactly 100.
do $$
declare i int;
begin
  for i in 1..79 loop
    if i % 19 = 0 then
      update private.recipe_tags_usage set minute_start = minute_start - interval '1 minute'
        where user_id = '11111111-1111-1111-1111-111111111111';
    end if;
    if public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111', 2000) <> 'ok' then
      raise exception 'suggestion % was refused', i;
    end if;
  end loop;
end $$;
select is((select suggestions from private.recipe_tags_usage where user_id = '11111111-1111-1111-1111-111111111111'), 100,
  '100 suggestions a day pass');
update private.recipe_tags_usage set minute_start = minute_start - interval '1 minute'
  where user_id = '11111111-1111-1111-1111-111111111111';
select is(public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111', 2000), 'user_limit',
  'the 101st suggestion in a day is refused, even in a fresh minute');
select is((select suggestions from private.recipe_tags_usage where user_id = '11111111-1111-1111-1111-111111111111'), 100,
  'the refused suggestion is not counted');

-- Global cap (the total is now 100 + 1 = 101) ------------------------------------------
select is((select suggestions from private.recipe_tags_daily_total), 101, 'the global total counts every user''s suggestions');
select is(public.check_recipe_tags_limit('33333333-3333-3333-3333-333333333333', 101), 'global_cap', 'the global cap refuses once reached');
select results_eq(
  $$ select requests_this_minute, suggestions from private.recipe_tags_usage where user_id = '33333333-3333-3333-3333-333333333333' $$,
  $$ values (0, 0) $$, 'a request refused by the global cap uses none of the user''s budget');
select is((select suggestions from private.recipe_tags_daily_total), 101, 'nor the global budget');
select is(public.check_recipe_tags_limit('33333333-3333-3333-3333-333333333333', 102), 'ok', 'one under the cap passes');
select is(public.check_recipe_tags_limit('22222222-2222-2222-2222-222222222222', 102), 'global_cap',
  'the cap refuses every user, even one well under their own limit');
select is(public.check_recipe_tags_limit('22222222-2222-2222-2222-222222222222', 0), 'global_cap', 'a cap of 0 refuses everything');

-- The import limits are separate ----------------------------------------------------------
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 2000), 'ok',
  'a user out of tag suggestions can still import');

-- Retention -----------------------------------------------------------------------------
insert into private.recipe_tags_usage (user_id, day, minute_start)
  values ('22222222-2222-2222-2222-222222222222', (now() at time zone 'utc')::date - 2, now() - interval '2 days');
select ok(exists (select 1 from cron.job where jobname = 'recipe-tags-usage-retention'), 'usage retention job is scheduled');
do $$ begin execute (select command from cron.job where jobname = 'recipe-tags-usage-retention'); end $$;
select is((select count(*)::int from private.recipe_tags_usage where day < (now() at time zone 'utc')::date), 0,
  'the retention job deletes old usage rows');
select is((select count(*)::int from private.recipe_tags_usage), 3, 'and keeps today''s');

-- Bad arguments and access ----------------------------------------------------------
select throws_ok($$ select public.check_recipe_tags_limit(null, 10) $$, '22023', null, 'a null user is rejected');
select throws_ok($$ select public.check_recipe_tags_limit('22222222-2222-2222-2222-222222222222', -1) $$,
  '22023', null, 'a negative cap is rejected');

select ok(
  not has_function_privilege('authenticated', 'public.check_recipe_tags_limit(uuid, integer)', 'execute')
  and not has_function_privilege('anon', 'public.check_recipe_tags_limit(uuid, integer)', 'execute')
  and not has_function_privilege('public', 'public.check_recipe_tags_limit(uuid, integer)', 'execute')
  and has_function_privilege('service_role', 'public.check_recipe_tags_limit(uuid, integer)', 'execute'),
  'only service_role can call the limit function');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111', 2000) $$,
  '42501', null, 'authenticated cannot call the limit function');
select throws_ok($$ select * from private.recipe_tags_usage $$, '42501', null, 'authenticated cannot read recipe_tags_usage');

set local role anon;
select throws_ok($$ select public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111', 2000) $$,
  '42501', null, 'anon cannot call the limit function');
select throws_ok($$ select * from private.recipe_tags_daily_total $$, '42501', null, 'anon cannot read recipe_tags_daily_total');

select * from finish();
rollback;
