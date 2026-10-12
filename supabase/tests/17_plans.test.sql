-- Plans and features (spec 4.12, 5): the seeded plans, has_feature, my_features, client access
-- and the user_plans row's rules.
begin;
create extension if not exists pgtap with schema extensions;
select plan(38);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex (unassigned), Sam (base) and Kim (plus) share one household; Lee is unassigned and in none.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'kim@test.local', 'authenticated', 'authenticated'),
  ('44444444-4444-4444-4444-444444444444', 'lee@test.local', 'authenticated', 'authenticated');

insert into public.households (id, name) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Shared');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222', 'member', 1),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333', 'member', 1);

insert into public.user_plans (user_id, plan_id) values
  ('22222222-2222-2222-2222-222222222222', 'base'),
  ('33333333-3333-3333-3333-333333333333', 'plus');

-- Seeded plans ------------------------------------------------------------------
select results_eq(
  $$ select id, name, is_default from public.plans order by id $$,
  $$ values ('base', 'Base', false), ('plus', 'Plus', false), ('standard', 'Standard', true) $$,
  'the seeded plans are base, standard (the default) and plus');
select results_eq(
  $$ select plan_id, feature from public.plan_features order by plan_id, feature $$,
  $$ values ('plus', 'categorize'), ('plus', 'recipe_import'), ('plus', 'recipe_import_photo'),
            ('standard', 'categorize') $$,
  'base has no features, standard has categorize and plus has all three');
select is_empty(
  $$ select p.id from public.plans p
     where exists (select 1 from public.plan_features f where f.plan_id = p.id and f.feature = 'recipe_import')
       and not exists (select 1 from public.plan_features f where f.plan_id = p.id and f.feature = 'categorize') $$,
  'every plan with recipe_import also has categorize');

-- has_feature -------------------------------------------------------------------
select ok(public.has_feature('11111111-1111-1111-1111-111111111111', 'categorize'),
  'an unassigned user gets the default plan''s categorize');
select ok(not public.has_feature('11111111-1111-1111-1111-111111111111', 'recipe_import'),
  'an unassigned user doesn''t get recipe_import');
select ok(not public.has_feature('11111111-1111-1111-1111-111111111111', 'recipe_import_photo'),
  'an unassigned user doesn''t get recipe_import_photo');
select ok(not public.has_feature('22222222-2222-2222-2222-222222222222', 'categorize'),
  'a base user doesn''t get categorize');
select ok(not public.has_feature('22222222-2222-2222-2222-222222222222', 'recipe_import'),
  'a base user doesn''t get recipe_import');
select ok(public.has_feature('33333333-3333-3333-3333-333333333333', 'categorize')
  and public.has_feature('33333333-3333-3333-3333-333333333333', 'recipe_import')
  and public.has_feature('33333333-3333-3333-3333-333333333333', 'recipe_import_photo'),
  'a plus user gets every feature');
select ok(not public.has_feature('33333333-3333-3333-3333-333333333333', 'teleport'),
  'an unknown feature is never granted');
select ok(not public.has_feature('99999999-9999-9999-9999-999999999999', 'recipe_import')
  and public.has_feature('99999999-9999-9999-9999-999999999999', 'categorize'),
  'an unknown user id resolves to the default plan');

-- Same household, different plans: the household argument doesn't change anything.
select is(
  array[
    public.has_feature('11111111-1111-1111-1111-111111111111', 'recipe_import', 'aaaaaaaa-0000-0000-0000-00000000000a'),
    public.has_feature('22222222-2222-2222-2222-222222222222', 'categorize', 'aaaaaaaa-0000-0000-0000-00000000000a'),
    public.has_feature('33333333-3333-3333-3333-333333333333', 'recipe_import', 'aaaaaaaa-0000-0000-0000-00000000000a')],
  array[false, false, true],
  'members of one household on different plans each get their own plan''s features');
select is(
  public.has_feature('22222222-2222-2222-2222-222222222222', 'categorize', 'aaaaaaaa-0000-0000-0000-00000000000a'),
  public.has_feature('22222222-2222-2222-2222-222222222222', 'categorize'),
  'a base member of a household with a plus member is still base');

-- my_features (as authenticated) ------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is(public.my_features(), array['categorize'], 'my_features for an unassigned user is the default plan''s');
select is(public.my_features('aaaaaaaa-0000-0000-0000-00000000000a'), array['categorize'],
  'my_features with a household gives the same answer');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is(public.my_features(), '{}'::text[], 'my_features for a base user is empty');
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is(public.my_features(), array['categorize', 'recipe_import', 'recipe_import_photo'],
  'my_features for a plus user is every feature, sorted');

-- Client access -----------------------------------------------------------------
select throws_ok($$ select * from public.plans $$, '42501', null, 'clients can''t read plans');
select throws_ok($$ select * from public.plan_features $$, '42501', null, 'clients can''t read plan_features');
select throws_ok($$ select * from public.user_plans $$, '42501', null, 'clients can''t read user_plans');
select throws_ok(
  $$ insert into public.user_plans (user_id, plan_id) values ('33333333-3333-3333-3333-333333333333', 'plus') $$,
  '42501', null, 'clients can''t assign themselves a plan');
select throws_ok($$ update public.user_plans set plan_id = 'plus' $$, '42501', null, 'clients can''t change a plan');
select throws_ok($$ insert into public.plan_features values ('base', 'categorize') $$, '42501', null,
  'clients can''t add features to a plan');
select throws_ok($$ insert into public.plans (id, name) values ('free', 'Free') $$, '42501', null,
  'clients can''t create plans');
select throws_ok($$ select public.has_feature('33333333-3333-3333-3333-333333333333', 'categorize') $$,
  '42501', null, 'clients can''t execute has_feature');
reset role;

select ok(
  has_function_privilege('service_role', 'public.has_feature(uuid, text, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.has_feature(uuid, text, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.has_feature(uuid, text, uuid)', 'execute')
  and not has_function_privilege('public', 'public.has_feature(uuid, text, uuid)', 'execute'),
  'only service_role can execute has_feature');
select ok(
  has_function_privilege('authenticated', 'public.my_features(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.my_features(uuid)', 'execute')
  and not has_function_privilege('public', 'public.my_features(uuid)', 'execute'),
  'only signed-in users can execute my_features');
select ok(
  not has_table_privilege('anon', 'public.user_plans', 'select')
  and not has_table_privilege('anon', 'public.plans', 'select')
  and not has_table_privilege('anon', 'public.plan_features', 'select'),
  'anon can''t read the plan tables');

-- user_plans rules ----------------------------------------------------------------
select throws_ok(
  $$ insert into public.user_plans (user_id, plan_id) values ('44444444-4444-4444-4444-444444444444', 'gold') $$,
  '23503', null, 'an unknown plan_id is rejected');
select throws_ok(
  $$ insert into public.plan_features values ('plus', 'teleport') $$,
  '23514', null, 'an unknown feature is rejected');
select throws_ok(
  $$ update public.plans set is_default = true where id = 'plus' $$,
  '23505', null, 'only one plan can be the default');

-- Editing a row stamps assigned_at (now() is fixed within the transaction).
insert into public.user_plans (user_id, plan_id, assigned_at)
  values ('44444444-4444-4444-4444-444444444444', 'base', '2026-01-01');
update public.user_plans set plan_id = 'plus' where user_id = '44444444-4444-4444-4444-444444444444';
select is((select assigned_at from public.user_plans where user_id = '44444444-4444-4444-4444-444444444444'),
  now(), 'changing a user''s plan sets assigned_at to now');
select ok(public.has_feature('44444444-4444-4444-4444-444444444444', 'recipe_import'),
  'the new plan takes effect at once');
delete from public.user_plans where user_id = '44444444-4444-4444-4444-444444444444';
select ok(not public.has_feature('44444444-4444-4444-4444-444444444444', 'recipe_import')
  and public.has_feature('44444444-4444-4444-4444-444444444444', 'categorize'),
  'deleting the row puts the user back on the default plan');

-- Deleting a user removes their row.
delete from auth.users where id = '33333333-3333-3333-3333-333333333333';
select is_empty($$ select 1 from public.user_plans where user_id = '33333333-3333-3333-3333-333333333333' $$,
  'deleting a user removes their user_plans row');

-- With no default plan, an unassigned user has no features (assigned users keep theirs).
update public.plans set is_default = false where id = 'standard';
select ok(not public.has_feature('11111111-1111-1111-1111-111111111111', 'categorize'),
  'with no default plan, an unassigned user has no features');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is(public.my_features(), '{}'::text[], 'with no default plan, my_features is empty for an unassigned user');
reset role;
insert into public.user_plans (user_id, plan_id) values ('11111111-1111-1111-1111-111111111111', 'standard');
select ok(public.has_feature('11111111-1111-1111-1111-111111111111', 'categorize'),
  'an assigned user keeps their plan with no default');

select * from finish();
rollback;
