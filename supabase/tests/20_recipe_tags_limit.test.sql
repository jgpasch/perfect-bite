-- suggest-recipe-tags rate limits (spec 6.7): per user 20 a minute and no monthly limit (since
-- 20261129120000_household_plans), no global cap, a refused call uses no budget, the retention
-- job, and only service_role can call it. now() is fixed within the transaction, so every call
-- lands in the same minute; the window reset is simulated by moving minute_start back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

insert into auth.users (id, email, aud, role, created_at) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated', now() - interval '60 days'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated', now() - interval '60 days'),
  ('33333333-3333-3333-3333-333333333333', 'kim@test.local', 'authenticated', 'authenticated', now() - interval '60 days');

-- Per-minute limit ------------------------------------------------------------------
create temp table results (n int, result text);
insert into results
  select n, public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111')
  from generate_series(1, 20) n;
select is((select count(*)::int from results where result = 'ok'), 20, '20 suggestions in a minute pass');
select is(public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111'), 'user_limit',
  'the 21st suggestion in a minute is refused');
select results_eq(
  $$ select requests_this_minute, suggestions from private.recipe_tags_usage where user_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values (20, 20) $$, 'a refused suggestion does not count');
select is(public.check_recipe_tags_limit('22222222-2222-2222-2222-222222222222'), 'ok',
  'another user is not affected by the first user''s minute limit');

update private.recipe_tags_usage set minute_start = minute_start - interval '1 minute'
  where user_id = '11111111-1111-1111-1111-111111111111';
select is(public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111'), 'ok', 'the minute window resets');
select results_eq(
  $$ select requests_this_minute, minute_start, suggestions from private.recipe_tags_usage
     where user_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values (1, date_trunc('minute', now()), 21) $$,
  'a new window starts at 1; the day keeps counting');

-- No monthly limit --------------------------------------------------------------------
-- Suggest tags is for everyone (20261129120000_household_plans): no plan feature, no monthly
-- limit. 21 so far; run 29 more, a minute window every 19, to reach 50.
do $$
declare i int;
begin
  for i in 1..29 loop
    if i % 19 = 0 then
      update private.recipe_tags_usage set minute_start = minute_start - interval '1 minute'
        where user_id = '11111111-1111-1111-1111-111111111111';
    end if;
    if public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111') <> 'ok' then
      raise exception 'suggestion % was refused', i;
    end if;
  end loop;
end $$;
select is((select suggestions from private.recipe_tags_usage where user_id = '11111111-1111-1111-1111-111111111111'), 50,
  '50 suggestions a month pass');
update private.recipe_tags_usage set minute_start = minute_start - interval '1 minute'
  where user_id = '11111111-1111-1111-1111-111111111111';
select is(public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111'), 'ok',
  'the 51st suggestion in a month passes too: there is no monthly limit');
select is((select suggestions from private.recipe_tags_usage where user_id = '11111111-1111-1111-1111-111111111111'), 51,
  'and it is counted');

-- No global cap (52 suggestions so far across users) ----------------------------------
select is(public.check_recipe_tags_limit('33333333-3333-3333-3333-333333333333'), 'ok',
  'another user still gets suggestions, whatever others used');
select results_eq(
  $$ select requests_this_minute, suggestions from private.recipe_tags_usage where user_id = '33333333-3333-3333-3333-333333333333' $$,
  $$ values (1, 1) $$, 'and it counts against their own limits');
select hasnt_function('public', 'check_recipe_tags_limit', array['uuid', 'integer'],
  'the two-argument check_recipe_tags_limit (with p_daily_cap) is gone');
select hasnt_table('private', 'recipe_tags_daily_total', 'recipe_tags_daily_total is gone');
select is((select command from cron.job where jobname = 'recipe-tags-usage-retention'),
  $$delete from private.recipe_tags_usage where day < (now() at time zone 'utc')::date - 40$$,
  'the retention job keeps recipe_tags_usage 40 days, and prunes nothing else');

-- The import limits are separate ----------------------------------------------------------
-- Importing is a plan feature: Alex's household is on founding.
insert into public.households (id, name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1);
insert into public.household_plans (household_id, plan_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'founding');
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111'), 'ok',
  'a user with many tag suggestions can still import');

-- Retention -----------------------------------------------------------------------------
insert into private.recipe_tags_usage (user_id, day, minute_start) values
  ('22222222-2222-2222-2222-222222222222', (now() at time zone 'utc')::date - 41, now() - interval '41 days'),
  ('22222222-2222-2222-2222-222222222222', (now() at time zone 'utc')::date - 40, now() - interval '40 days');
select ok(exists (select 1 from cron.job where jobname = 'recipe-tags-usage-retention'), 'usage retention job is scheduled');
do $$ begin execute (select command from cron.job where jobname = 'recipe-tags-usage-retention'); end $$;
select is((select count(*)::int from private.recipe_tags_usage where day < (now() at time zone 'utc')::date - 40), 0,
  'the retention job deletes usage rows older than 40 days');
select is((select count(*)::int from private.recipe_tags_usage where day = (now() at time zone 'utc')::date - 40), 1,
  'and keeps the row 40 days old');
select is((select count(*)::int from private.recipe_tags_usage), 4, 'and today''s');

-- Bad arguments and access ----------------------------------------------------------
select throws_ok($$ select public.check_recipe_tags_limit(null) $$, '22023', null, 'a null user is rejected');

select ok(
  not has_function_privilege('authenticated', 'public.check_recipe_tags_limit(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.check_recipe_tags_limit(uuid)', 'execute')
  and not has_function_privilege('public', 'public.check_recipe_tags_limit(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.check_recipe_tags_limit(uuid)', 'execute'),
  'only service_role can call the limit function');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111') $$,
  '42501', null, 'authenticated cannot call the limit function');
select throws_ok($$ select * from private.recipe_tags_usage $$, '42501', null, 'authenticated cannot read recipe_tags_usage');

set local role anon;
select throws_ok($$ select public.check_recipe_tags_limit('11111111-1111-1111-1111-111111111111') $$,
  '42501', null, 'anon cannot call the limit function');
select throws_ok($$ select * from private.recipe_tags_usage $$, '42501', null, 'anon cannot read recipe_tags_usage');

select * from finish();
rollback;
