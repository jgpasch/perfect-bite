-- Portal functions for plans (spec 4.12): admin_list_plans, admin_create_plan, admin_rename_plan,
-- admin_set_default_plan, admin_set_plan_feature, admin_set_plan_limit and admin_delete_plan.
begin;
create extension if not exists pgtap with schema extensions;
select plan(77);

-- Fixtures (as postgres) ------------------------------------------------------
-- boss is the admin. old (60 days, so no doubling) is on the default plan; mid is on basic.
insert into auth.users (id, email, aud, role, created_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'boss@plans.test', 'authenticated', 'authenticated', now() - interval '100 days'),
  ('11111111-1111-1111-1111-111111111111', 'old@plans.test', 'authenticated', 'authenticated', now() - interval '60 days'),
  ('22222222-2222-2222-2222-222222222222', 'mid@plans.test', 'authenticated', 'authenticated', now() - interval '60 days');
insert into private.admins (user_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
insert into public.user_plans (user_id, plan_id) values ('22222222-2222-2222-2222-222222222222', 'basic');

create temporary table expected (key text primary key, n integer);
insert into expected values
  ('unassigned', (select count(*) from auth.users u where not exists (select 1 from public.user_plans up where up.user_id = u.id))),
  ('basic', (select count(*) from public.user_plans where plan_id = 'basic')),
  ('audit', (select count(*) from admin.admin_actions));
grant select on expected to authenticated;

-- Privileges -------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.admin_list_plans()', 'execute')
  and not has_function_privilege('anon', 'public.admin_create_plan(text, text, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.admin_rename_plan(text, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.admin_set_default_plan(text, text)', 'execute')
  and not has_function_privilege('anon', 'public.admin_set_plan_feature(text, text, boolean, integer, text)', 'execute')
  and not has_function_privilege('anon', 'public.admin_set_plan_limit(text, text, integer, text)', 'execute')
  and not has_function_privilege('anon', 'public.admin_delete_plan(text, text)', 'execute'),
  'anon can''t execute the plan functions');
select ok(
  not has_function_privilege('service_role', 'public.admin_list_plans()', 'execute')
  and not has_function_privilege('service_role', 'public.admin_create_plan(text, text, text, text)', 'execute')
  and not has_function_privilege('service_role', 'public.admin_rename_plan(text, text, text)', 'execute')
  and not has_function_privilege('service_role', 'public.admin_set_default_plan(text, text)', 'execute')
  and not has_function_privilege('service_role', 'public.admin_set_plan_feature(text, text, boolean, integer, text)', 'execute')
  and not has_function_privilege('service_role', 'public.admin_set_plan_limit(text, text, integer, text)', 'execute')
  and not has_function_privilege('service_role', 'public.admin_delete_plan(text, text)', 'execute'),
  'service_role can''t execute the plan functions');
select ok(
  has_function_privilege('authenticated', 'public.admin_list_plans()', 'execute')
  and has_function_privilege('authenticated', 'public.admin_create_plan(text, text, text, text)', 'execute')
  and has_function_privilege('authenticated', 'public.admin_rename_plan(text, text, text)', 'execute')
  and has_function_privilege('authenticated', 'public.admin_set_default_plan(text, text)', 'execute')
  and has_function_privilege('authenticated', 'public.admin_set_plan_feature(text, text, boolean, integer, text)', 'execute')
  and has_function_privilege('authenticated', 'public.admin_set_plan_limit(text, text, integer, text)', 'execute')
  and has_function_privilege('authenticated', 'public.admin_delete_plan(text, text)', 'execute'),
  'authenticated can execute the plan functions');
select ok(
  not has_function_privilege('authenticated', 'private.plan_snapshot(text)', 'execute')
  and not has_function_privilege('authenticated', 'private.plan_user_count(text)', 'execute')
  and not has_function_privilege('authenticated', 'private.log_plan_action(text, text, jsonb, text, jsonb)', 'execute')
  and not has_function_privilege('service_role', 'private.plan_snapshot(text)', 'execute')
  and not has_function_privilege('service_role', 'private.log_plan_action(text, text, jsonb, text, jsonb)', 'execute'),
  'no client role can execute the helpers');

-- A signed-in non-admin ----------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select public.admin_list_plans() $$, '42501', 'not authorized', 'admin_list_plans refuses a non-admin');
select throws_ok($$ select public.admin_create_plan('gold', 'Gold', 'plus', 'me') $$, '42501', 'not authorized',
  'admin_create_plan refuses a non-admin');
select throws_ok($$ select public.admin_rename_plan('plus', 'Mine', 'me') $$, '42501', 'not authorized',
  'admin_rename_plan refuses a non-admin');
select throws_ok($$ select public.admin_set_default_plan('unlimited', 'me') $$, '42501', 'not authorized',
  'admin_set_default_plan refuses a non-admin');
select throws_ok($$ select public.admin_set_plan_feature('none', 'categorize', true, null, 'me') $$, '42501', 'not authorized',
  'admin_set_plan_feature refuses a non-admin');
select throws_ok($$ select public.admin_set_plan_limit('plus', 'recipe_import', 9999, 'me') $$, '42501', 'not authorized',
  'admin_set_plan_limit refuses a non-admin');
select throws_ok($$ select public.admin_delete_plan('none', 'me') $$, '42501', 'not authorized',
  'admin_delete_plan refuses a non-admin');
select set_config('request.jwt.claims', '', true);
select throws_ok($$ select public.admin_list_plans() $$, '42501', 'not authorized', 'admin_list_plans refuses no user');
reset role;
select results_eq(
  $$ select (select count(*) from public.plans)::int, (select count(*) from public.plan_features)::int,
            (select monthly_limit from public.plan_limits where plan_id = 'plus' and feature = 'recipe_import'),
            (select id from public.plans where is_default), (select name from public.plans where id = 'plus'),
            (select count(*) from admin.admin_actions)::int - (select n from expected where key = 'audit') $$,
  $$ values (4, 14, 40, 'plus', 'Plus', 0) $$,
  'the refused calls changed nothing and wrote no audit row');

-- The admin, through the grant ------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);

-- admin_list_plans ----------------------------------------------------------------
select is(
  (select array_agg(p ->> 'id') from jsonb_array_elements(public.admin_list_plans()) p),
  array['basic', 'none', 'plus', 'unlimited'], 'admin_list_plans lists every plan by id');
select is(
  (select p from jsonb_array_elements(public.admin_list_plans()) p where p ->> 'id' = 'plus'),
  jsonb_build_object(
    'id', 'plus', 'name', 'Plus', 'is_default', true,
    'users', (select n from expected where key = 'unassigned'),
    'features', '[{"feature": "categorize", "monthly_limit": 250},
                  {"feature": "recipe_import", "monthly_limit": 40},
                  {"feature": "recipe_import_photo", "monthly_limit": 20},
                  {"feature": "recipe_tags", "monthly_limit": 50},
                  {"feature": "step_ingredients", "monthly_limit": 100},
                  {"feature": "recipe_photo_ai", "monthly_limit": 15}]'::jsonb),
  'the default plan counts every unassigned user, and lists its features in the fixed order with limits');
select is(
  (select p from jsonb_array_elements(public.admin_list_plans()) p where p ->> 'id' = 'basic'),
  jsonb_build_object(
    'id', 'basic', 'name', 'Basic', 'is_default', false,
    'users', (select n from expected where key = 'basic'),
    'features', '[{"feature": "categorize", "monthly_limit": 250},
                  {"feature": "step_ingredients", "monthly_limit": 100}]'::jsonb),
  'another plan counts its assigned users');
select is(
  (select p -> 'features' from jsonb_array_elements(public.admin_list_plans()) p where p ->> 'id' = 'none'),
  '[]'::jsonb, 'a plan with no features has an empty list');
select is(
  (select p -> 'features' -> 0 from jsonb_array_elements(public.admin_list_plans()) p where p ->> 'id' = 'unlimited'),
  '{"feature": "categorize", "monthly_limit": null}'::jsonb, 'a null limit shows as null');

-- admin_create_plan -------------------------------------------------------------------
select is(
  public.admin_create_plan('gold', '  Gold  ', 'plus', 'trying a bigger plan') -> 'after' ->> 'name',
  'Gold', 'admin_create_plan makes the plan, trimming the name');
reset role;
select results_eq(
  $$ select feature from public.plan_features where plan_id = 'gold' order by feature $$,
  $$ select feature from public.plan_features where plan_id = 'plus' order by feature $$,
  'a copy has the source''s features');
select results_eq(
  $$ select feature, monthly_limit from public.plan_limits where plan_id = 'gold' order by feature $$,
  $$ select feature, monthly_limit from public.plan_limits where plan_id = 'plus' order by feature $$,
  'a copy has the source''s limits');
select is((select is_default from public.plans where id = 'gold'), false, 'a copy of the default plan isn''t the default');
select results_eq(
  $$ select action, target_plan_id, target_user_id, note, performed_by,
            details -> 'before', details -> 'after' ->> 'id', (details ->> 'users')::int
     from admin.admin_actions where action = 'create_plan' $$,
  $$ values ('create_plan', 'gold', null::uuid, 'trying a bigger plan', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
             'null'::jsonb, 'gold', 0) $$,
  'creating writes one audit row: the plan, the note, the admin, no before and 0 users');
set local role authenticated;

select is(public.admin_create_plan('blank_slate', 'Blank', null, 'empty') -> 'after' -> 'features', '[]'::jsonb,
  'with no source, a new plan has no features');
select is(public.admin_create_plan('lite', 'Lite', 'basic', 'from basic') -> 'after' -> 'features',
  '[{"feature": "categorize", "monthly_limit": 250}, {"feature": "step_ingredients", "monthly_limit": 100}]'::jsonb,
  'a copy of basic has basic''s features and limits');

select throws_ok($$ select public.admin_create_plan('Gold2', 'X', null, 'n') $$, '22023', 'invalid plan id',
  'an id with capitals is refused');
select throws_ok($$ select public.admin_create_plan('g', 'X', null, 'n') $$, '22023', 'invalid plan id',
  'a one-character id is refused');
select throws_ok($$ select public.admin_create_plan('2for1', 'X', null, 'n') $$, '22023', 'invalid plan id',
  'an id starting with a digit is refused');
select throws_ok($$ select public.admin_create_plan('a' || repeat('b', 31), 'X', null, 'n') $$, '22023', 'invalid plan id',
  'a 32-character id is refused');
select lives_ok($$ select public.admin_create_plan('a' || repeat('b', 30), 'Long', null, 'n') $$,
  'a 31-character id is fine');
select throws_ok($$ select public.admin_create_plan('plus', 'X', null, 'n') $$, '23505', 'plan exists',
  'a used id is refused');
select throws_ok($$ select public.admin_create_plan('silver', 'Silver', 'bronze', 'n') $$, 'P0002', 'plan not found',
  'an unknown source is refused');
select throws_ok($$ select public.admin_create_plan('silver', ' ', null, 'n') $$, '22023', 'name required',
  'a blank name is refused');
select throws_ok($$ select public.admin_create_plan('silver', 'Silver', 'plus') $$, '22023', 'note required',
  'a missing note is refused');
select throws_ok($$ select public.admin_create_plan('silver', 'Silver', 'plus', '  ') $$, '22023', 'note required',
  'a blank note is refused');

-- admin_rename_plan ----------------------------------------------------------------------
select is(
  (select jsonb_build_array(d -> 'before' ->> 'name', d -> 'after' ->> 'name', d -> 'after' ->> 'id')
   from public.admin_rename_plan('gold', 'Gold+', 'clearer') d),
  '["Gold", "Gold+", "gold"]'::jsonb, 'admin_rename_plan changes the name, not the id');
select throws_ok($$ select public.admin_rename_plan('bronze', 'B', 'n') $$, 'P0002', 'plan not found',
  'renaming an unknown plan is refused');
select throws_ok($$ select public.admin_rename_plan('gold', '', 'n') $$, '22023', 'name required',
  'renaming to a blank name is refused');

-- admin_set_plan_feature ---------------------------------------------------------------
select is(public.admin_set_plan_feature('lite', 'recipe_tags', true, 30, 'tags for lite') -> 'after' -> 'features',
  '[{"feature": "categorize", "monthly_limit": 250}, {"feature": "recipe_tags", "monthly_limit": 30},
    {"feature": "step_ingredients", "monthly_limit": 100}]'::jsonb,
  'enabling a feature adds it with its limit');
select is(public.admin_set_plan_feature('lite', 'recipe_photo_ai', true, null, 'photos, no limit')
            -> 'after' -> 'features' -> 3,
  '{"feature": "recipe_photo_ai", "monthly_limit": null}'::jsonb, 'enabling with a null limit means no limit');
reset role;
select is((select count(*)::int from public.plan_limits where plan_id = 'lite' and feature = 'recipe_photo_ai' and monthly_limit is null),
  1, 'enabling with no limit still writes an explicit plan_limits row');
set local role authenticated;
select is(public.admin_set_plan_feature('lite', 'recipe_tags', true, 12, 'again') -> 'after' -> 'features' -> 1,
  '{"feature": "recipe_tags", "monthly_limit": 12}'::jsonb, 'enabling a feature the plan has replaces its limit');
select is(public.admin_set_plan_feature('lite', 'recipe_tags', false, null, 'no more tags') -> 'after' -> 'features',
  '[{"feature": "categorize", "monthly_limit": 250}, {"feature": "step_ingredients", "monthly_limit": 100},
    {"feature": "recipe_photo_ai", "monthly_limit": null}]'::jsonb,
  'disabling a feature removes it');
reset role;
select is_empty($$ select 1 from public.plan_limits where plan_id = 'lite' and feature = 'recipe_tags' $$,
  'disabling a feature removes its limit row');
set local role authenticated;

select throws_ok($$ select public.admin_set_plan_feature('blank_slate', 'recipe_import', true, 5, 'import only') $$,
  '23514', 'recipe import needs categorize', 'enabling import on a plan without categorize brings the trigger''s message');
select throws_ok($$ select public.admin_set_plan_feature('gold', 'categorize', false, null, 'drop categorize') $$,
  '23514', 'recipe import needs categorize', 'disabling categorize on a plan with import brings the trigger''s message');
select throws_ok($$ select public.admin_set_plan_feature('lite', 'teleport', true, null, 'n') $$,
  '23514', null, 'an unknown feature is refused by the table''s check');
select throws_ok($$ select public.admin_set_plan_feature('lite', 'recipe_tags', true, -1, 'n') $$,
  '23514', null, 'a negative limit is refused');
select throws_ok($$ select public.admin_set_plan_feature('bronze', 'categorize', true, null, 'n') $$,
  'P0002', 'plan not found', 'an unknown plan is refused');
select throws_ok($$ select public.admin_set_plan_feature('lite', 'recipe_tags', true, 5) $$,
  '22023', 'note required', 'a missing note is refused');
-- Categorize first, then import, works one call at a time.
select lives_ok($$ select public.admin_set_plan_feature('blank_slate', 'categorize', true, 10, 'first') $$,
  'enabling categorize first is fine');
select is(public.admin_set_plan_feature('blank_slate', 'recipe_import', true, 5, 'then import') -> 'after' -> 'features',
  '[{"feature": "categorize", "monthly_limit": 10}, {"feature": "recipe_import", "monthly_limit": 5}]'::jsonb,
  'then import is fine');
reset role;
select results_eq(
  $$ select (select count(*) from public.plan_features where plan_id = 'gold' and feature = 'categorize')::int,
            (select count(*) from public.plan_features where plan_id = 'lite' and feature = 'recipe_tags')::int,
            (select count(*) from public.plan_limits where plan_id = 'lite' and feature = 'recipe_tags')::int $$,
  $$ values (1, 0, 0) $$,
  'the refused feature changes changed nothing');
set local role authenticated;

-- admin_set_plan_limit ------------------------------------------------------------------
select is(public.admin_set_plan_limit('plus', 'recipe_import', 7, 'tighter') -> 'after' -> 'features' -> 1,
  '{"feature": "recipe_import", "monthly_limit": 7}'::jsonb, 'admin_set_plan_limit changes the limit');
reset role;
select is(private.monthly_limit('11111111-1111-1111-1111-111111111111', 'recipe_import'), 7,
  'the new limit shows at once in private.monthly_limit');
set local role authenticated;
select lives_ok($$ select public.admin_set_plan_limit('plus', 'recipe_import', null, 'lift it') $$,
  'a null limit is fine');
reset role;
select is(private.monthly_limit('11111111-1111-1111-1111-111111111111', 'recipe_import'), null,
  'a null limit means no monthly limit at once');
delete from public.plan_limits where plan_id = 'lite' and feature = 'recipe_photo_ai';
set local role authenticated;
select is(public.admin_set_plan_limit('lite', 'recipe_photo_ai', 3, 'had no row') -> 'after' -> 'features' -> 2,
  '{"feature": "recipe_photo_ai", "monthly_limit": 3}'::jsonb, 'a feature with no limit row gets one');
select throws_ok($$ select public.admin_set_plan_limit('basic', 'recipe_import', 5, 'n') $$,
  'P0002', 'feature not in plan', 'a feature the plan doesn''t have is refused');
select throws_ok($$ select public.admin_set_plan_limit('plus', 'recipe_import', -1, 'n') $$,
  '23514', null, 'a negative limit is refused');
select throws_ok($$ select public.admin_set_plan_limit('bronze', 'categorize', 1, 'n') $$,
  'P0002', 'plan not found', 'an unknown plan is refused');
select throws_ok($$ select public.admin_set_plan_limit('plus', 'categorize', 1, null) $$,
  '22023', 'note required', 'a missing note is refused');

-- admin_set_default_plan ------------------------------------------------------------------
select is(
  (select jsonb_build_object('prev', d -> 'previous_default', 'before', d -> 'before' -> 'is_default',
                             'after', d -> 'after' -> 'is_default', 'users', d -> 'users')
   from public.admin_set_default_plan('gold', 'gold for everyone') d),
  jsonb_build_object('prev', 'plus', 'before', false, 'after', true,
                     'users', (select n from expected where key = 'unassigned')),
  'admin_set_default_plan returns the previous default and the users it now covers');
reset role;
select results_eq($$ select id from public.plans where is_default $$, $$ values ('gold') $$,
  'the new plan is the only default');
select ok(public.has_feature('11111111-1111-1111-1111-111111111111', 'recipe_import')
  and private.monthly_limit('11111111-1111-1111-1111-111111111111', 'recipe_import') = 40,
  'unassigned users get the new default''s features and limits at once');
set local role authenticated;
select is(public.admin_set_default_plan('gold', 'again') -> 'previous_default', '"gold"'::jsonb,
  'setting the default plan as default again is fine');
select throws_ok($$ select public.admin_set_default_plan('bronze', 'n') $$, 'P0002', 'plan not found',
  'an unknown plan is refused');
select throws_ok($$ select public.admin_set_default_plan('plus', '') $$, '22023', 'note required',
  'a blank note is refused');

-- admin_delete_plan ----------------------------------------------------------------------
select throws_ok($$ select public.admin_delete_plan('gold', 'n') $$, '23503', 'default plan',
  'the default plan can''t be deleted');
select throws_ok($$ select public.admin_delete_plan('basic', 'n') $$, '23503', 'plan in use',
  'a plan with users can''t be deleted');
select throws_ok($$ select public.admin_delete_plan('bronze', 'n') $$, 'P0002', 'plan not found',
  'an unknown plan is refused');
select throws_ok($$ select public.admin_delete_plan('lite', null) $$, '22023', 'note required',
  'a missing note is refused');
select is(
  (select jsonb_build_array(d -> 'before' ->> 'id', d -> 'after', d -> 'users') from public.admin_delete_plan('lite', 'not needed') d),
  '["lite", null, 0]'::jsonb, 'admin_delete_plan returns the plan''s last state');
reset role;
select results_eq(
  $$ select (select count(*) from public.plans where id = 'lite')::int,
            (select count(*) from public.plan_features where plan_id = 'lite')::int,
            (select count(*) from public.plan_limits where plan_id = 'lite')::int,
            (select count(*) from public.plans where id in ('gold', 'basic'))::int $$,
  $$ values (0, 0, 0, 2) $$,
  'deleting removes the plan with its features and limits, and the refusals kept theirs');

-- Audit rows ----------------------------------------------------------------------------
select results_eq(
  $$ select action, count(*)::int from admin.admin_actions
     where performed_by = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' group by action order by action $$,
  $$ values ('create_plan', 4), ('delete_plan', 1), ('rename_plan', 1), ('set_default_plan', 2),
            ('set_plan_feature', 6), ('set_plan_limit', 3) $$,
  'each success wrote one audit row, and each refusal none');
select is(
  (select count(*)::int from admin.admin_actions where performed_by = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
     and (target_plan_id is null or note is null or target_user_id is not null)),
  0, 'every plan audit row has the plan and the note, and no user');
select is(
  (select details -> 'before' ->> 'name' from admin.admin_actions where action = 'delete_plan'),
  'Lite', 'the deleted plan''s audit row keeps its last state');

select * from finish();
rollback;
