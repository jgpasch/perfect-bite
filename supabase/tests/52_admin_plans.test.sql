-- Portal functions for plans (spec 4.12): admin_list_plans, admin_create_plan, admin_rename_plan,
-- admin_set_default_plan, admin_set_plan_feature, admin_set_plan_limit and admin_delete_plan.
begin;
create extension if not exists pgtap with schema extensions;
select plan(79);

-- Fixtures (as postgres) ------------------------------------------------------
-- Founding is the default here, as on hosted (supabase/seed.sql makes unlimited the default locally).
update public.plans set is_default = false where is_default;
update public.plans set is_default = true where id = 'founding';

-- boss is the admin. old's household (60 days old, so no doubling) is on founding; mid's on free.
-- A plan counts its households (household_plans rows), not users: users don't add to the
-- default's count.
insert into auth.users (id, email, aud, role, created_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'boss@plans.test', 'authenticated', 'authenticated', now() - interval '100 days'),
  ('11111111-1111-1111-1111-111111111111', 'old@plans.test', 'authenticated', 'authenticated', now() - interval '60 days'),
  ('22222222-2222-2222-2222-222222222222', 'mid@plans.test', 'authenticated', 'authenticated', now() - interval '60 days');
insert into private.admins (user_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
insert into public.households (id, name, created_at) values
  ('d1000000-0000-0000-0000-000000000001', 'Old''s', now() - interval '60 days'),
  ('d2000000-0000-0000-0000-000000000002', 'Mid''s', now() - interval '60 days');
insert into public.household_members (household_id, user_id, role, position) values
  ('d1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('d2000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'owner', 1);
insert into public.household_plans (household_id, plan_id) values
  ('d1000000-0000-0000-0000-000000000001', 'founding'),
  ('d2000000-0000-0000-0000-000000000002', 'free');

create temporary table expected (key text primary key, n integer);
insert into expected values
  ('founding', (select count(*) from public.household_plans where plan_id = 'founding')),
  ('free', (select count(*) from public.household_plans where plan_id = 'free')),
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
  and not has_function_privilege('authenticated', 'private.plan_household_count(text)', 'execute')
  and not has_function_privilege('service_role', 'private.plan_household_count(text)', 'execute')
  and not has_function_privilege('authenticated', 'private.log_plan_action(text, text, jsonb, text, jsonb)', 'execute')
  and not has_function_privilege('service_role', 'private.plan_snapshot(text)', 'execute')
  and not has_function_privilege('service_role', 'private.log_plan_action(text, text, jsonb, text, jsonb)', 'execute'),
  'no client role can execute the helpers');

-- A signed-in non-admin ----------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select public.admin_list_plans() $$, '42501', 'not authorized', 'admin_list_plans refuses a non-admin');
select throws_ok($$ select public.admin_create_plan('gold', 'Gold', 'founding', 'me') $$, '42501', 'not authorized',
  'admin_create_plan refuses a non-admin');
select throws_ok($$ select public.admin_rename_plan('founding', 'Mine', 'me') $$, '42501', 'not authorized',
  'admin_rename_plan refuses a non-admin');
select throws_ok($$ select public.admin_set_default_plan('unlimited', 'me') $$, '42501', 'not authorized',
  'admin_set_default_plan refuses a non-admin');
select throws_ok($$ select public.admin_set_plan_feature('free', 'recipe_import', true, null, 'me') $$, '42501', 'not authorized',
  'admin_set_plan_feature refuses a non-admin');
select throws_ok($$ select public.admin_set_plan_limit('founding', 'recipe_import', 9999, 'me') $$, '42501', 'not authorized',
  'admin_set_plan_limit refuses a non-admin');
select throws_ok($$ select public.admin_delete_plan('free', 'me') $$, '42501', 'not authorized',
  'admin_delete_plan refuses a non-admin');
select set_config('request.jwt.claims', '', true);
select throws_ok($$ select public.admin_list_plans() $$, '42501', 'not authorized', 'admin_list_plans refuses no user');
reset role;
select results_eq(
  $$ select (select count(*) from public.plans)::int, (select count(*) from public.plan_features)::int,
            (select monthly_limit from public.plan_limits where plan_id = 'founding' and feature = 'recipe_import'),
            (select id from public.plans where is_default), (select name from public.plans where id = 'founding'),
            (select count(*) from admin.admin_actions)::int - (select n from expected where key = 'audit') $$,
  $$ values (3, 4, 50, 'founding', 'Founding', 0) $$,
  'the refused calls changed nothing and wrote no audit row');

-- The admin, through the grant ------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);

-- admin_list_plans ----------------------------------------------------------------
select is(
  (select array_agg(p ->> 'id') from jsonb_array_elements(public.admin_list_plans()) p),
  array['founding', 'free', 'unlimited'], 'admin_list_plans lists every plan by id');
select is(
  (select p from jsonb_array_elements(public.admin_list_plans()) p where p ->> 'id' = 'founding'),
  jsonb_build_object(
    'id', 'founding', 'name', 'Founding', 'is_default', true,
    'households', (select n from expected where key = 'founding'),
    'features', '[{"feature": "recipe_import", "monthly_limit": 50},
                  {"feature": "recipe_photo_ai", "monthly_limit": 20}]'::jsonb),
  'the default plan counts only its household_plans rows, and lists its features in the fixed order with limits');
select is(
  (select p - 'features' from jsonb_array_elements(public.admin_list_plans()) p where p ->> 'id' = 'free'),
  jsonb_build_object(
    'id', 'free', 'name', 'Free', 'is_default', false,
    'households', (select n from expected where key = 'free')),
  'another plan counts its households');
select ok((select n from expected where key = 'founding') >= 1 and (select n from expected where key = 'free') >= 1,
  'the counts include the fixtures'' households');
select is(
  (select p -> 'features' from jsonb_array_elements(public.admin_list_plans()) p where p ->> 'id' = 'free'),
  '[]'::jsonb, 'a plan with no features has an empty list');
select is(
  (select p -> 'features' -> 0 from jsonb_array_elements(public.admin_list_plans()) p where p ->> 'id' = 'unlimited'),
  '{"feature": "recipe_import", "monthly_limit": null}'::jsonb, 'a null limit shows as null');

-- admin_create_plan -------------------------------------------------------------------
select is(
  public.admin_create_plan('gold', '  Gold  ', 'founding', 'trying a bigger plan') -> 'after' ->> 'name',
  'Gold', 'admin_create_plan makes the plan, trimming the name');
reset role;
select results_eq(
  $$ select feature from public.plan_features where plan_id = 'gold' order by feature $$,
  $$ select feature from public.plan_features where plan_id = 'founding' order by feature $$,
  'a copy has the source''s features');
select results_eq(
  $$ select feature, monthly_limit from public.plan_limits where plan_id = 'gold' order by feature $$,
  $$ select feature, monthly_limit from public.plan_limits where plan_id = 'founding' order by feature $$,
  'a copy has the source''s limits');
select is((select is_default from public.plans where id = 'gold'), false, 'a copy of the default plan isn''t the default');
select results_eq(
  $$ select action, target_plan_id, target_user_id, note, performed_by,
            details -> 'before', details -> 'after' ->> 'id', (details ->> 'households')::int
     from admin.admin_actions where action = 'create_plan' $$,
  $$ values ('create_plan', 'gold', null::uuid, 'trying a bigger plan', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
             'null'::jsonb, 'gold', 0) $$,
  'creating writes one audit row: the plan, the note, the admin, no before and 0 households');
set local role authenticated;

select is(public.admin_create_plan('blank_slate', 'Blank', null, 'empty') -> 'after' -> 'features', '[]'::jsonb,
  'with no source, a new plan has no features');
select is(public.admin_create_plan('lite', 'Lite', 'unlimited', 'from unlimited') -> 'after' -> 'features',
  '[{"feature": "recipe_import", "monthly_limit": null}, {"feature": "recipe_photo_ai", "monthly_limit": null}]'::jsonb,
  'a copy of unlimited has unlimited''s features and (null) limits');

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
select throws_ok($$ select public.admin_create_plan('founding', 'X', null, 'n') $$, '23505', 'plan exists',
  'a used id is refused');
select throws_ok($$ select public.admin_create_plan('silver', 'Silver', 'bronze', 'n') $$, 'P0002', 'plan not found',
  'an unknown source is refused');
select throws_ok($$ select public.admin_create_plan('silver', ' ', null, 'n') $$, '22023', 'name required',
  'a blank name is refused');
select throws_ok($$ select public.admin_create_plan('silver', 'Silver', 'founding') $$, '22023', 'note required',
  'a missing note is refused');
select throws_ok($$ select public.admin_create_plan('silver', 'Silver', 'founding', '  ') $$, '22023', 'note required',
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
-- lite starts as a copy of unlimited; clear it to start from no features.
reset role;
delete from public.plan_limits where plan_id = 'lite';
delete from public.plan_features where plan_id = 'lite';
set local role authenticated;
select is(public.admin_set_plan_feature('lite', 'recipe_import', true, 30, 'imports for lite') -> 'after' -> 'features',
  '[{"feature": "recipe_import", "monthly_limit": 30}]'::jsonb,
  'enabling a feature adds it with its limit');
select is(public.admin_set_plan_feature('lite', 'recipe_photo_ai', true, null, 'photos, no limit')
            -> 'after' -> 'features' -> 1,
  '{"feature": "recipe_photo_ai", "monthly_limit": null}'::jsonb, 'enabling with a null limit means no limit');
reset role;
select is((select count(*)::int from public.plan_limits where plan_id = 'lite' and feature = 'recipe_photo_ai' and monthly_limit is null),
  1, 'enabling with no limit still writes an explicit plan_limits row');
set local role authenticated;
select is(public.admin_set_plan_feature('lite', 'recipe_import', true, 12, 'again') -> 'after' -> 'features' -> 0,
  '{"feature": "recipe_import", "monthly_limit": 12}'::jsonb, 'enabling a feature the plan has replaces its limit');
select is(public.admin_set_plan_feature('lite', 'recipe_import', false, null, 'no more imports') -> 'after' -> 'features',
  '[{"feature": "recipe_photo_ai", "monthly_limit": null}]'::jsonb,
  'disabling a feature removes it');
reset role;
select is_empty($$ select 1 from public.plan_limits where plan_id = 'lite' and feature = 'recipe_import' $$,
  'disabling a feature removes its limit row');
set local role authenticated;

-- The import rule is gone: recipe_import needs nothing else, and categorize isn't a feature any more.
select is(public.admin_set_plan_feature('blank_slate', 'recipe_import', true, 5, 'import only') -> 'after' -> 'features',
  '[{"feature": "recipe_import", "monthly_limit": 5}]'::jsonb,
  'a plan can have recipe import without categorize (the import rule is gone)');
select throws_ok($$ select public.admin_set_plan_feature('gold', 'categorize', true, null, 'add categorize') $$,
  '23514', null, 'categorize is no longer a feature: the table''s check refuses it');
select throws_ok($$ select public.admin_set_plan_feature('lite', 'teleport', true, null, 'n') $$,
  '23514', null, 'an unknown feature is refused by the table''s check');
select throws_ok($$ select public.admin_set_plan_feature('lite', 'recipe_photo_ai', true, -1, 'n') $$,
  '23514', null, 'a negative limit is refused');
select throws_ok($$ select public.admin_set_plan_feature('bronze', 'recipe_import', true, null, 'n') $$,
  'P0002', 'plan not found', 'an unknown plan is refused');
select throws_ok($$ select public.admin_set_plan_feature('lite', 'recipe_import', true, 5) $$,
  '22023', 'note required', 'a missing note is refused');
-- Photo AI added and import taken away, one call at a time, with nothing tying them together.
select lives_ok($$ select public.admin_set_plan_feature('blank_slate', 'recipe_photo_ai', true, 2, 'add photos') $$,
  'enabling photo AI alongside import is fine');
select is(public.admin_set_plan_feature('blank_slate', 'recipe_import', false, null, 'drop import') -> 'after' -> 'features',
  '[{"feature": "recipe_photo_ai", "monthly_limit": 2}]'::jsonb,
  'then disabling import on its own is fine');
reset role;
select results_eq(
  $$ select (select count(*) from public.plan_features where plan_id = 'gold')::int,
            (select count(*) from public.plan_features where plan_id = 'lite')::int,
            (select count(*) from public.plan_limits where plan_id = 'lite' and feature = 'recipe_photo_ai' and monthly_limit is null)::int $$,
  $$ values (2, 1, 1) $$,
  'the refused feature changes changed nothing');
set local role authenticated;

-- admin_set_plan_limit ------------------------------------------------------------------
select is(public.admin_set_plan_limit('founding', 'recipe_import', 7, 'tighter') -> 'after' -> 'features' -> 0,
  '{"feature": "recipe_import", "monthly_limit": 7}'::jsonb, 'admin_set_plan_limit changes the limit');
reset role;
select is(private.monthly_limit('recipe_import', 'd1000000-0000-0000-0000-000000000001'), 7,
  'the new limit shows at once in private.monthly_limit for a household on the plan');
set local role authenticated;
select lives_ok($$ select public.admin_set_plan_limit('founding', 'recipe_import', null, 'lift it') $$,
  'a null limit is fine');
reset role;
select is(private.monthly_limit('recipe_import', 'd1000000-0000-0000-0000-000000000001'), null,
  'a null limit means no monthly limit at once');
delete from public.plan_limits where plan_id = 'lite' and feature = 'recipe_photo_ai';
set local role authenticated;
select is(public.admin_set_plan_limit('lite', 'recipe_photo_ai', 3, 'had no row') -> 'after' -> 'features' -> 0,
  '{"feature": "recipe_photo_ai", "monthly_limit": 3}'::jsonb, 'a feature with no limit row gets one');
select throws_ok($$ select public.admin_set_plan_limit('free', 'recipe_import', 5, 'n') $$,
  'P0002', 'feature not in plan', 'a feature the plan doesn''t have is refused');
select throws_ok($$ select public.admin_set_plan_limit('founding', 'recipe_import', -1, 'n') $$,
  '23514', null, 'a negative limit is refused');
select throws_ok($$ select public.admin_set_plan_limit('bronze', 'recipe_import', 1, 'n') $$,
  'P0002', 'plan not found', 'an unknown plan is refused');
select throws_ok($$ select public.admin_set_plan_limit('founding', 'recipe_photo_ai', 1, null) $$,
  '22023', 'note required', 'a missing note is refused');

-- admin_set_default_plan ------------------------------------------------------------------
select is(
  (select jsonb_build_object('prev', d -> 'previous_default', 'before', d -> 'before' -> 'is_default',
                             'after', d -> 'after' -> 'is_default', 'households', d -> 'households',
                             'keys', (select array_agg(k order by k) from jsonb_object_keys(d) k))
   from public.admin_set_default_plan('gold', 'gold for new households') d),
  jsonb_build_object('prev', 'founding', 'before', false, 'after', true, 'households', 0,
                     'keys', array['after', 'before', 'households', 'previous_default']),
  'admin_set_default_plan returns the previous default and the plan''s households: none, since no household moves');
reset role;
select is(
  (select array[(select n from expected where key = 'founding'), private.plan_household_count('founding'),
                private.plan_household_count('gold')]),
  array[(select n from expected where key = 'founding'), (select n from expected where key = 'founding'), 0],
  'founding keeps every household it had, and gold has none');
set local role authenticated;
reset role;
select results_eq($$ select id from public.plans where is_default $$, $$ values ('gold') $$,
  'the new plan is the only default');
-- Plans are per household: the default is only what new households start on, so changing it
-- moves no one. old's household keeps founding (recipe_import with no limit, lifted above), not
-- gold's 50.
select ok((select plan_id from public.household_plans where household_id = 'd1000000-0000-0000-0000-000000000001') = 'founding'
  and public.has_feature('11111111-1111-1111-1111-111111111111', 'recipe_import', 'd1000000-0000-0000-0000-000000000001')
  and private.monthly_limit('recipe_import', 'd1000000-0000-0000-0000-000000000001') is null,
  'changing the default moves no household: its plan, features and limits stay');
set local role authenticated;
select is(public.admin_set_default_plan('gold', 'again') -> 'previous_default', '"gold"'::jsonb,
  'setting the default plan as default again is fine');
select throws_ok($$ select public.admin_set_default_plan('bronze', 'n') $$, 'P0002', 'plan not found',
  'an unknown plan is refused');
select throws_ok($$ select public.admin_set_default_plan('founding', '') $$, '22023', 'note required',
  'a blank note is refused');

-- admin_delete_plan ----------------------------------------------------------------------
select throws_ok($$ select public.admin_delete_plan('gold', 'n') $$, '23503', 'default plan',
  'the default plan can''t be deleted');
select throws_ok($$ select public.admin_delete_plan('free', 'n') $$, '23503', 'plan in use',
  'a plan with households can''t be deleted');
select throws_ok($$ select public.admin_delete_plan('bronze', 'n') $$, 'P0002', 'plan not found',
  'an unknown plan is refused');
select throws_ok($$ select public.admin_delete_plan('lite', null) $$, '22023', 'note required',
  'a missing note is refused');
select is(
  (select jsonb_build_array(d -> 'before' ->> 'id', d -> 'after', d -> 'households') from public.admin_delete_plan('lite', 'not needed') d),
  '["lite", null, 0]'::jsonb, 'admin_delete_plan returns the plan''s last state');
reset role;
select results_eq(
  $$ select (select count(*) from public.plans where id = 'lite')::int,
            (select count(*) from public.plan_features where plan_id = 'lite')::int,
            (select count(*) from public.plan_limits where plan_id = 'lite')::int,
            (select count(*) from public.plans where id in ('gold', 'free'))::int $$,
  $$ values (0, 0, 0, 2) $$,
  'deleting removes the plan with its features and limits, and the refusals kept theirs');

-- Audit rows ----------------------------------------------------------------------------
select results_eq(
  $$ select action, count(*)::int from admin.admin_actions
     where performed_by = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' group by action order by action $$,
  $$ values ('create_plan', 4), ('delete_plan', 1), ('rename_plan', 1), ('set_default_plan', 2),
            ('set_plan_feature', 7), ('set_plan_limit', 3) $$,
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
