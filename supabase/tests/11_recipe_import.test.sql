-- import-recipe (spec 6.6): the recipe_imports cache is service role only with no user id, the
-- retention jobs are scheduled and delete only old rows, and the per-user import limits: per minute
-- and the household plan's monthly one (no global cap; 48_plan_limits covers each plan). now() is
-- fixed within the transaction, so every call lands in the same minute; the window reset is
-- simulated by moving minute_start back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(38);

insert into auth.users (id, email, aud, role, created_at) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated', now() - interval '60 days'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated', now() - interval '60 days'),
  ('33333333-3333-3333-3333-333333333333', 'kim@test.local', 'authenticated', 'authenticated', now() - interval '60 days'),
  ('44444444-4444-4444-4444-444444444444', 'lee@test.local', 'authenticated', 'authenticated', now() - interval '60 days');

-- Each of Alex, Sam and Kim has a household on founding, made over 30 days ago, so founding's 50
-- imports a month apply undoubled. Lee is in no household.
insert into public.households (id, name, created_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household', now() - interval '60 days'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sam''s household', now() - interval '60 days'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Kim''s household', now() - interval '60 days');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner', 1),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '33333333-3333-3333-3333-333333333333', 'owner', 1);
insert into public.household_plans (household_id, plan_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'founding'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'founding'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'founding');

-- recipe_imports ---------------------------------------------------------------------
select has_pk('public', 'recipe_imports', 'recipe_imports has a primary key');
select col_is_pk('public', 'recipe_imports', array['url_key', 'prompt_version'], 'the key is (url_key, prompt_version)');
select hasnt_column('public', 'recipe_imports', 'user_id', 'recipe_imports has no user_id');
select is((select relrowsecurity from pg_class where oid = 'public.recipe_imports'::regclass), true, 'RLS is enabled');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'recipe_imports'), 0, 'no client policies');

insert into public.recipe_imports (url_key, prompt_version, result, is_recipe, created_at) values
  ('https://example.com/old', 'extract-recipe.v1', '{}', true, now() - interval '31 days'),
  ('https://example.com/new', 'extract-recipe.v1', '{}', false, now() - interval '29 days');
select throws_ok($$ insert into public.recipe_imports (url_key, prompt_version, result, is_recipe)
                   values ('https://example.com/new', 'extract-recipe.v1', '{}', true) $$,
  '23505', null, 'one row per URL and prompt version');
select lives_ok($$ insert into public.recipe_imports (url_key, prompt_version, result, is_recipe)
                   values ('https://example.com/new', 'extract-recipe.v2', '{}', true) $$,
  'another prompt version gets its own row');

select ok(exists (select 1 from cron.job where jobname = 'recipe-imports-retention'), 'cache retention job is scheduled');
select ok(exists (select 1 from cron.job where jobname = 'recipe-import-usage-retention'), 'usage retention job is scheduled');
select is((select schedule from cron.job where jobname = 'recipe-imports-retention'), '29 3 * * *', 'the cache job runs daily');
do $$ begin execute (select command from cron.job where jobname = 'recipe-imports-retention'); end $$;
select set_eq($$ select url_key, prompt_version from public.recipe_imports $$,
  $$ values ('https://example.com/new', 'extract-recipe.v1'), ('https://example.com/new', 'extract-recipe.v2') $$,
  'the retention job deletes only rows older than 30 days');

-- Per-minute limit ------------------------------------------------------------------
create temp table results (n int, result text);
insert into results
  select n, public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  from generate_series(1, 10) n;
select is((select count(*)::int from results where result = 'ok'), 10, '10 imports in a minute pass');
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'user_limit',
  'the 11th import in a minute is refused');
select results_eq(
  $$ select requests_this_minute, imports from private.recipe_import_usage where user_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values (10, 10) $$, 'a refused import does not count');
select is(public.check_recipe_import_limit('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 'ok',
  'another user is not affected by the first user''s minute limit');

update private.recipe_import_usage set minute_start = minute_start - interval '1 minute'
  where user_id = '11111111-1111-1111-1111-111111111111';
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'ok', 'the minute window resets');
select results_eq(
  $$ select requests_this_minute, minute_start, imports from private.recipe_import_usage
     where user_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values (1, date_trunc('minute', now()), 11) $$,
  'a new window starts at 1 import; the day keeps counting');

-- Monthly limit (founding: 50) ---------------------------------------------------------
-- 11 imports so far; run 39 more, a minute window at a time, to reach exactly 50.
do $$
declare i int;
begin
  for i in 1..39 loop
    update private.recipe_import_usage set minute_start = minute_start - interval '1 minute'
      where user_id = '11111111-1111-1111-1111-111111111111';
    if public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') <> 'ok' then
      raise exception 'import % was refused', i;
    end if;
  end loop;
end $$;
select is((select imports from private.recipe_import_usage where user_id = '11111111-1111-1111-1111-111111111111'), 50,
  '50 imports a month pass');
update private.recipe_import_usage set minute_start = minute_start - interval '1 minute'
  where user_id = '11111111-1111-1111-1111-111111111111';
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'monthly_limit',
  'the 51st import in a month is refused, even in a fresh minute');
select is((select imports from private.recipe_import_usage where user_id = '11111111-1111-1111-1111-111111111111'), 50,
  'the refused import is not counted');
select is(private.monthly_usage('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'recipe_import'), 50,
  'each import counted on Alex''s household, the refused one not');
select is(public.check_recipe_import_limit('44444444-4444-4444-4444-444444444444', 'cccccccc-cccc-cccc-cccc-cccccccccccc'), 'monthly_limit',
  'a user in no household (so no plan) is refused in a household they aren''t in');

-- No global cap (51 imports so far across users) --------------------------------------
select is(public.check_recipe_import_limit('33333333-3333-3333-3333-333333333333', 'cccccccc-cccc-cccc-cccc-cccccccccccc'), 'ok',
  'another user still imports, whatever others used');
select results_eq(
  $$ select requests_this_minute, imports from private.recipe_import_usage where user_id = '33333333-3333-3333-3333-333333333333' $$,
  $$ values (1, 1) $$, 'and it counts against their own limits');
select hasnt_function('public', 'check_recipe_import_limit', array['uuid', 'integer'],
  'the two-argument check_recipe_import_limit (with p_daily_cap) is gone');
select hasnt_table('private', 'recipe_import_daily_total', 'recipe_import_daily_total is gone');
select is((select command from cron.job where jobname = 'recipe-import-usage-retention'),
  $$delete from private.recipe_import_usage where day < (now() at time zone 'utc')::date - 40$$,
  'the usage retention job keeps recipe_import_usage 40 days, and prunes nothing else');

-- Bad arguments and access ----------------------------------------------------------
select throws_ok($$ select public.check_recipe_import_limit(null) $$, '22023', null, 'a null user is rejected');
select throws_ok($$ select public.check_recipe_import_limit('33333333-3333-3333-3333-333333333333') $$,
  '22023', 'household required', 'no household is rejected: an import names the household it''s saved to');

select ok(
  not has_function_privilege('authenticated', 'public.check_recipe_import_limit(uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.check_recipe_import_limit(uuid, uuid)', 'execute')
  and not has_function_privilege('public', 'public.check_recipe_import_limit(uuid, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.check_recipe_import_limit(uuid, uuid)', 'execute'),
  'only service_role can call the limit function');
select ok(
  not has_table_privilege('authenticated', 'public.recipe_imports', 'select')
  and not has_table_privilege('anon', 'public.recipe_imports', 'select')
  and not has_table_privilege('authenticated', 'public.recipe_imports', 'insert')
  and not has_table_privilege('anon', 'public.recipe_imports', 'insert')
  and has_table_privilege('service_role', 'public.recipe_imports', 'select')
  and has_table_privilege('service_role', 'public.recipe_imports', 'insert'),
  'only service_role can read and write recipe_imports');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select * from public.recipe_imports $$, '42501', null, 'authenticated cannot read recipe_imports');
select throws_ok($$ insert into public.recipe_imports (url_key, prompt_version, result, is_recipe)
                   values ('https://evil.example/x', 'extract-recipe.v1', '{}', true) $$,
  '42501', null, 'authenticated cannot write recipe_imports');
select throws_ok($$ select public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
  '42501', null, 'authenticated cannot call the limit function');
select throws_ok($$ select * from private.recipe_import_usage $$, '42501', null, 'authenticated cannot read recipe_import_usage');

set local role anon;
select throws_ok($$ select * from public.recipe_imports $$, '42501', null, 'anon cannot read recipe_imports');
select throws_ok($$ select public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
  '42501', null, 'anon cannot call the limit function');
select throws_ok($$ select * from private.recipe_import_usage $$, '42501', null, 'anon cannot read recipe_import_usage');

select * from finish();
rollback;
