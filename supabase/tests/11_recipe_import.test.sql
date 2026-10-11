-- import-recipe (spec 6.6): the recipe_imports cache is service role only with no user id, the
-- retention jobs are scheduled and delete only old rows, and the per-user and global import
-- limits. now() is fixed within the transaction, so every call lands in the same minute; the
-- window reset is simulated by moving minute_start back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(38);

insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'kim@test.local', 'authenticated', 'authenticated');

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
  select n, public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 2000)
  from generate_series(1, 10) n;
select is((select count(*)::int from results where result = 'ok'), 10, '10 imports in a minute pass');
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 2000), 'user_limit',
  'the 11th import in a minute is refused');
select results_eq(
  $$ select requests_this_minute, imports from private.recipe_import_usage where user_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values (10, 10) $$, 'a refused import does not count');
select is(public.check_recipe_import_limit('22222222-2222-2222-2222-222222222222', 2000), 'ok',
  'another user is not affected by the first user''s minute limit');

update private.recipe_import_usage set minute_start = minute_start - interval '1 minute'
  where user_id = '11111111-1111-1111-1111-111111111111';
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 2000), 'ok', 'the minute window resets');
select results_eq(
  $$ select requests_this_minute, minute_start, imports from private.recipe_import_usage
     where user_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values (1, date_trunc('minute', now()), 11) $$,
  'a new window starts at 1 import; the day keeps counting');

-- Per-user daily limit ----------------------------------------------------------------
-- 11 imports so far; run 39 more, a minute window at a time, to reach exactly 50.
do $$
declare i int;
begin
  for i in 1..39 loop
    update private.recipe_import_usage set minute_start = minute_start - interval '1 minute'
      where user_id = '11111111-1111-1111-1111-111111111111';
    if public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 2000) <> 'ok' then
      raise exception 'import % was refused', i;
    end if;
  end loop;
end $$;
select is((select imports from private.recipe_import_usage where user_id = '11111111-1111-1111-1111-111111111111'), 50,
  '50 imports a day pass');
update private.recipe_import_usage set minute_start = minute_start - interval '1 minute'
  where user_id = '11111111-1111-1111-1111-111111111111';
select is(public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 2000), 'user_limit',
  'the 51st import in a day is refused, even in a fresh minute');
select is((select imports from private.recipe_import_usage where user_id = '11111111-1111-1111-1111-111111111111'), 50,
  'the refused import is not counted');

-- Global cap (the total is now 50 + 1 = 51) ------------------------------------------
select is((select imports from private.recipe_import_daily_total), 51, 'the global total counts every user''s imports');
select is(public.check_recipe_import_limit('33333333-3333-3333-3333-333333333333', 51), 'global_cap', 'the global cap refuses once reached');
select results_eq(
  $$ select requests_this_minute, imports from private.recipe_import_usage where user_id = '33333333-3333-3333-3333-333333333333' $$,
  $$ values (0, 0) $$, 'a request refused by the global cap uses none of the user''s budget');
select is((select imports from private.recipe_import_daily_total), 51, 'nor the global budget');
select is(public.check_recipe_import_limit('33333333-3333-3333-3333-333333333333', 52), 'ok', 'one under the cap passes');
select is(public.check_recipe_import_limit('22222222-2222-2222-2222-222222222222', 52), 'global_cap',
  'the cap refuses every user, even one well under their own limit');
select is(public.check_recipe_import_limit('22222222-2222-2222-2222-222222222222', 0), 'global_cap', 'a cap of 0 refuses everything');

-- Bad arguments and access ----------------------------------------------------------
select throws_ok($$ select public.check_recipe_import_limit(null, 10) $$, '22023', null, 'a null user is rejected');
select throws_ok($$ select public.check_recipe_import_limit('22222222-2222-2222-2222-222222222222', -1) $$,
  '22023', null, 'a negative cap is rejected');

select ok(
  not has_function_privilege('authenticated', 'public.check_recipe_import_limit(uuid, integer)', 'execute')
  and not has_function_privilege('anon', 'public.check_recipe_import_limit(uuid, integer)', 'execute')
  and has_function_privilege('service_role', 'public.check_recipe_import_limit(uuid, integer)', 'execute'),
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
select throws_ok($$ select public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 2000) $$,
  '42501', null, 'authenticated cannot call the limit function');
select throws_ok($$ select * from private.recipe_import_usage $$, '42501', null, 'authenticated cannot read recipe_import_usage');

set local role anon;
select throws_ok($$ select * from public.recipe_imports $$, '42501', null, 'anon cannot read recipe_imports');
select throws_ok($$ select public.check_recipe_import_limit('11111111-1111-1111-1111-111111111111', 2000) $$,
  '42501', null, 'anon cannot call the limit function');
select throws_ok($$ select * from private.recipe_import_daily_total $$, '42501', null, 'anon cannot read recipe_import_daily_total');

select * from finish();
rollback;
