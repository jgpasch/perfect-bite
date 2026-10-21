-- import-recipe-photo rate limits (spec 6.10): per user 5 a minute and the household plan's
-- monthly recipe_import limit (founding: 50, doubled in a household's first month; counted on the
-- photo table and on the household, whose allowance link imports share; 48_plan_limits covers
-- each plan and household), no
-- global cap, a refused call uses no budget, separate from the link-import and page-photo limits,
-- the retention job, and only service_role can call it. now() is fixed within the transaction, so
-- every call lands in the same minute; the window reset is simulated by moving minute_start back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(29);

insert into auth.users (id, email, aud, role, created_at) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated', now() - interval '60 days'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated', now() - interval '60 days'),
  ('33333333-3333-3333-3333-333333333333', 'kim@test.local', 'authenticated', 'authenticated', now() - interval '60 days'),
  ('44444444-4444-4444-4444-444444444444', 'lee@test.local', 'authenticated', 'authenticated', now() - interval '60 days');

-- Alex, Sam and Kim each have a household on founding made over 30 days ago, so founding's 50
-- apply undoubled. Lee's household is on free (no features).
insert into public.households (id, name, created_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household', now() - interval '60 days'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sam''s household', now() - interval '60 days'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Kim''s household', now() - interval '60 days'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Lee''s household', now() - interval '60 days');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner', 1),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '33333333-3333-3333-3333-333333333333', 'owner', 1),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', '44444444-4444-4444-4444-444444444444', 'owner', 1);
insert into public.household_plans (household_id, plan_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'founding'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'founding'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'founding'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'free');

-- Per-minute limit ------------------------------------------------------------------
create temp table results (n int, result text);
insert into results
  select n, public.check_recipe_photo_limit('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  from generate_series(1, 5) n;
select is((select count(*)::int from results where result = 'ok'), 5, '5 imports in a minute pass');
select is(public.check_recipe_photo_limit('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'user_limit',
  'the 6th import in a minute is refused');
select results_eq(
  $$ select imports_this_minute, imports from private.recipe_photo_import_usage where user_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values (5, 5) $$, 'a refused import does not count');
select is(public.check_recipe_photo_limit('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 'ok',
  'another user is not affected by the first user''s minute limit');

update private.recipe_photo_import_usage set minute_start = minute_start - interval '1 minute'
  where user_id = '11111111-1111-1111-1111-111111111111';
select is(public.check_recipe_photo_limit('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'ok', 'the minute window resets');
select results_eq(
  $$ select imports_this_minute, minute_start, imports from private.recipe_photo_import_usage
     where user_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values (1, date_trunc('minute', now()), 6) $$,
  'a new window starts at 1; the day keeps counting');

-- Monthly limit (founding's recipe_import: 50) ------------------------------------------
-- 6 so far; run 44 more, a new minute window every 4, to reach exactly 50.
do $$
declare i int;
begin
  for i in 1..44 loop
    if i % 4 = 0 then
      update private.recipe_photo_import_usage set minute_start = minute_start - interval '1 minute'
        where user_id = '11111111-1111-1111-1111-111111111111';
    end if;
    if public.check_recipe_photo_limit('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') <> 'ok' then
      raise exception 'import % was refused', i;
    end if;
  end loop;
end $$;
select is((select imports from private.recipe_photo_import_usage where user_id = '11111111-1111-1111-1111-111111111111'), 50,
  '50 imports a month pass');
update private.recipe_photo_import_usage set minute_start = minute_start - interval '1 minute'
  where user_id = '11111111-1111-1111-1111-111111111111';
select is(public.check_recipe_photo_limit('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'monthly_limit',
  'the 51st import in a month is refused, even in a fresh minute');
select is((select imports from private.recipe_photo_import_usage where user_id = '11111111-1111-1111-1111-111111111111'), 50,
  'the refused import is not counted');
select is(private.monthly_usage('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'recipe_import'), 50,
  'each photo import counted on Alex''s household''s recipe_import, the refused one not');
select is(public.check_recipe_photo_limit('44444444-4444-4444-4444-444444444444', 'dddddddd-dddd-dddd-dddd-dddddddddddd'), 'monthly_limit',
  'a user whose household is on free (no recipe_import) is refused');

-- In a household's first month the limit doubles: 100.
update public.households set created_at = now() - interval '10 days' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
select is(public.check_recipe_photo_limit('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'ok',
  'in the household''s first month the 51st passes (doubled to 100)');

-- No global cap (52 imports so far across users) ---------------------------------------
select is(public.check_recipe_photo_limit('33333333-3333-3333-3333-333333333333', 'cccccccc-cccc-cccc-cccc-cccccccccccc'), 'ok',
  'another user still imports photos, whatever others used');
select results_eq(
  $$ select imports_this_minute, imports from private.recipe_photo_import_usage where user_id = '33333333-3333-3333-3333-333333333333' $$,
  $$ values (1, 1) $$, 'and it counts against their own limits');
select hasnt_function('public', 'check_recipe_photo_limit', array['uuid', 'integer'],
  'the two-argument check_recipe_photo_limit (with p_daily_cap) is gone');
select hasnt_table('private', 'recipe_photo_import_daily_total', 'recipe_photo_import_daily_total is gone');
select is((select command from cron.job where jobname = 'recipe-photo-import-usage-retention'),
  $$delete from private.recipe_photo_import_usage where day < (now() at time zone 'utc')::date - 40$$,
  'the retention job keeps recipe_photo_import_usage 40 days, and prunes nothing else');

-- The other limits -----------------------------------------------------------------------
-- Link imports share the household's allowance (48_plan_limits): 51 of the doubled 100 used.
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'ok',
  'a link import passes under the shared, doubled allowance');
select is(public.check_recipe_photos_limit('11111111-1111-1111-1111-111111111111'), 'ok',
  'and still list a page''s photos');

-- Retention -----------------------------------------------------------------------------
insert into private.recipe_photo_import_usage (user_id, day, minute_start) values
  ('22222222-2222-2222-2222-222222222222', (now() at time zone 'utc')::date - 41, now() - interval '41 days'),
  ('22222222-2222-2222-2222-222222222222', (now() at time zone 'utc')::date - 40, now() - interval '40 days');
select ok(exists (select 1 from cron.job where jobname = 'recipe-photo-import-usage-retention'), 'usage retention job is scheduled');
do $$ begin execute (select command from cron.job where jobname = 'recipe-photo-import-usage-retention'); end $$;
select is((select count(*)::int from private.recipe_photo_import_usage where day < (now() at time zone 'utc')::date - 40), 0,
  'the retention job deletes usage rows older than 40 days');
select is((select count(*)::int from private.recipe_photo_import_usage where day = (now() at time zone 'utc')::date - 40), 1,
  'and keeps the row 40 days old');
-- Today's: Alex's, Sam's, Kim's and Lee's (a refused call still makes the day's row).
select is((select count(*)::int from private.recipe_photo_import_usage), 5, 'and today''s');

-- Bad arguments and access ----------------------------------------------------------
select throws_ok($$ select public.check_recipe_photo_limit(null) $$, '22023', null, 'a null user is rejected');
select throws_ok($$ select public.check_recipe_photo_limit('33333333-3333-3333-3333-333333333333') $$,
  '22023', 'household required', 'no household is rejected: a photo import names the household it''s saved to');

select ok(
  not has_function_privilege('authenticated', 'public.check_recipe_photo_limit(uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.check_recipe_photo_limit(uuid, uuid)', 'execute')
  and not has_function_privilege('public', 'public.check_recipe_photo_limit(uuid, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.check_recipe_photo_limit(uuid, uuid)', 'execute'),
  'only service_role can call the limit function');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select public.check_recipe_photo_limit('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
  '42501', null, 'authenticated cannot call the limit function');
select throws_ok($$ select * from private.recipe_photo_import_usage $$, '42501', null, 'authenticated cannot read recipe_photo_import_usage');

set local role anon;
select throws_ok($$ select * from private.recipe_photo_import_usage $$, '42501', null, 'anon cannot read recipe_photo_import_usage');

select * from finish();
rollback;
