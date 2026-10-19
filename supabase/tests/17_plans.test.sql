-- Plans and features (spec 4.12, 5): the seeded plans, has_feature, my_features, client access
-- and the user_plans row's rules.
begin;
create extension if not exists pgtap with schema extensions;
select plan(58);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex (unassigned), Sam (none) and Kim (unlimited) share one household; Lee is unassigned and in
-- none.
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
  ('22222222-2222-2222-2222-222222222222', 'none'),
  ('33333333-3333-3333-3333-333333333333', 'unlimited');

-- Seeded plans ------------------------------------------------------------------
select results_eq(
  $$ select id, name, is_default from public.plans order by id $$,
  $$ values ('basic', 'Basic', false), ('none', 'None', false), ('plus', 'Plus', true),
            ('unlimited', 'Unlimited', false) $$,
  'the seeded plans are none, basic, plus (the default) and unlimited');
select results_eq(
  $$ select plan_id, feature from public.plan_features order by plan_id, feature $$,
  $$ values ('basic', 'categorize'), ('basic', 'step_ingredients'),
            ('plus', 'categorize'), ('plus', 'recipe_import'), ('plus', 'recipe_import_photo'),
            ('plus', 'recipe_photo_ai'), ('plus', 'recipe_tags'), ('plus', 'step_ingredients'),
            ('unlimited', 'categorize'), ('unlimited', 'recipe_import'), ('unlimited', 'recipe_import_photo'),
            ('unlimited', 'recipe_photo_ai'), ('unlimited', 'recipe_tags'), ('unlimited', 'step_ingredients') $$,
  'none has no features, basic has categorize and step_ingredients, and plus and unlimited have all six');
select is((select count(*)::int from public.plans where is_default), 1, 'exactly one plan is the default');

-- Recipe import needs categorize: a deferred constraint trigger on plan_features ---------------
select results_eq(
  $$ select tgdeferrable, tginitdeferred from pg_trigger
     where tgrelid = 'public.plan_features'::regclass and tgname = 'plan_features_import_needs_categorize' $$,
  $$ values (true, true) $$,
  'the import rule is a deferrable, initially deferred constraint trigger');

set constraints public.plan_features_import_needs_categorize immediate;
select throws_ok($$ insert into public.plan_features values ('none', 'recipe_import') $$,
  '23514', 'recipe import needs categorize', 'adding recipe_import to a plan without categorize is refused');
select throws_ok($$ insert into public.plan_features values ('none', 'recipe_import_photo') $$,
  '23514', 'recipe import needs categorize', 'adding recipe_import_photo to a plan without categorize is refused');
select throws_ok($$ delete from public.plan_features where plan_id = 'plus' and feature = 'categorize' $$,
  '23514', 'recipe import needs categorize', 'deleting categorize from a plan with import is refused');
select throws_ok($$ update public.plan_features set plan_id = 'none' where plan_id = 'unlimited' and feature = 'categorize' $$,
  '23514', 'recipe import needs categorize', 'moving categorize off a plan with import is refused');
select lives_ok($$ delete from public.plan_features where plan_id = 'basic' and feature = 'categorize' $$,
  'deleting categorize from a plan without import is fine');
insert into public.plan_features values ('basic', 'categorize');

-- Deferred (the default), a plan can gain both in one transaction, in either order.
set constraints public.plan_features_import_needs_categorize deferred;
insert into public.plan_features values ('none', 'recipe_import');
insert into public.plan_features values ('none', 'categorize');
select lives_ok($$ set constraints public.plan_features_import_needs_categorize immediate $$,
  'adding recipe_import then categorize in one transaction is fine');
set constraints public.plan_features_import_needs_categorize deferred;
select lives_ok($$ delete from public.plan_features where plan_id = 'none' and feature = 'categorize' $$,
  'deferred, a plan can be left with import and no categorize for a while');
select throws_ok($$ set constraints public.plan_features_import_needs_categorize immediate $$,
  '23514', 'recipe import needs categorize', 'but not at the check (commit)');
delete from public.plan_features where plan_id = 'none';
select lives_ok($$ set constraints public.plan_features_import_needs_categorize immediate $$,
  'once fixed in the same transaction, the check passes');
set constraints public.plan_features_import_needs_categorize deferred;
select is_empty($$ select 1 from public.plan_features where plan_id = 'none' $$, 'none is back to no features');

-- has_feature -------------------------------------------------------------------
select ok(public.has_feature('11111111-1111-1111-1111-111111111111', 'categorize'),
  'an unassigned user gets the default plan''s categorize');
select ok(public.has_feature('11111111-1111-1111-1111-111111111111', 'recipe_import'),
  'an unassigned (plus) user gets recipe_import');
select ok(public.has_feature('11111111-1111-1111-1111-111111111111', 'recipe_import_photo'),
  'an unassigned (plus) user gets recipe_import_photo');
select ok(not public.has_feature('22222222-2222-2222-2222-222222222222', 'categorize'),
  'a none user doesn''t get categorize');
select ok(not public.has_feature('22222222-2222-2222-2222-222222222222', 'recipe_import'),
  'a none user doesn''t get recipe_import');
select ok(public.has_feature('33333333-3333-3333-3333-333333333333', 'categorize')
  and public.has_feature('33333333-3333-3333-3333-333333333333', 'recipe_import')
  and public.has_feature('33333333-3333-3333-3333-333333333333', 'recipe_import_photo')
  and public.has_feature('33333333-3333-3333-3333-333333333333', 'recipe_photo_ai')
  and public.has_feature('33333333-3333-3333-3333-333333333333', 'recipe_tags')
  and public.has_feature('33333333-3333-3333-3333-333333333333', 'step_ingredients'),
  'an unlimited user gets every feature');
select ok(not public.has_feature('22222222-2222-2222-2222-222222222222', 'recipe_tags'),
  'a none user doesn''t get recipe_tags');
select ok(public.has_feature('11111111-1111-1111-1111-111111111111', 'recipe_tags'),
  'an unassigned (plus) user gets recipe_tags');
insert into public.user_plans (user_id, plan_id) values ('44444444-4444-4444-4444-444444444444', 'basic');
select ok(not public.has_feature('44444444-4444-4444-4444-444444444444', 'recipe_tags')
  and not public.has_feature('44444444-4444-4444-4444-444444444444', 'recipe_import')
  and not public.has_feature('44444444-4444-4444-4444-444444444444', 'recipe_import_photo')
  and not public.has_feature('44444444-4444-4444-4444-444444444444', 'recipe_photo_ai'),
  'a user assigned basic doesn''t get recipe_tags, recipe_import, recipe_import_photo or recipe_photo_ai');
select ok(public.has_feature('44444444-4444-4444-4444-444444444444', 'step_ingredients')
  and public.has_feature('44444444-4444-4444-4444-444444444444', 'categorize'),
  'a user assigned basic gets categorize and step_ingredients');
insert into public.user_plans (user_id, plan_id) values ('44444444-4444-4444-4444-444444444444', 'plus')
  on conflict (user_id) do update set plan_id = 'plus';
select ok(public.has_feature('44444444-4444-4444-4444-444444444444', 'recipe_photo_ai'),
  'a user assigned plus gets recipe_photo_ai');
delete from public.user_plans where user_id = '44444444-4444-4444-4444-444444444444';
select ok(public.has_feature('11111111-1111-1111-1111-111111111111', 'step_ingredients'),
  'an unassigned (plus) user gets step_ingredients');
select ok(not public.has_feature('22222222-2222-2222-2222-222222222222', 'step_ingredients'),
  'a none user doesn''t get step_ingredients');
select ok(not public.has_feature('33333333-3333-3333-3333-333333333333', 'teleport'),
  'an unknown feature is never granted');
select ok(public.has_feature('99999999-9999-9999-9999-999999999999', 'recipe_import')
  and public.has_feature('99999999-9999-9999-9999-999999999999', 'categorize'),
  'an unknown user id resolves to the default plan');

-- Same household, different plans: the household argument doesn't change anything.
select is(
  array[
    public.has_feature('11111111-1111-1111-1111-111111111111', 'recipe_import', 'aaaaaaaa-0000-0000-0000-00000000000a'),
    public.has_feature('22222222-2222-2222-2222-222222222222', 'categorize', 'aaaaaaaa-0000-0000-0000-00000000000a'),
    public.has_feature('33333333-3333-3333-3333-333333333333', 'recipe_import', 'aaaaaaaa-0000-0000-0000-00000000000a')],
  array[true, false, true],
  'members of one household on different plans each get their own plan''s features');
select is(
  public.has_feature('22222222-2222-2222-2222-222222222222', 'categorize', 'aaaaaaaa-0000-0000-0000-00000000000a'),
  public.has_feature('22222222-2222-2222-2222-222222222222', 'categorize'),
  'a none member of a household with an unlimited member is still none');

-- my_features (as authenticated) ------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is(public.my_features(), array['categorize', 'recipe_import', 'recipe_import_photo', 'recipe_photo_ai', 'recipe_tags', 'step_ingredients'],
  'my_features for an unassigned user is the default plan''s, plus''s six');
select is(public.my_features('aaaaaaaa-0000-0000-0000-00000000000a'),
  array['categorize', 'recipe_import', 'recipe_import_photo', 'recipe_photo_ai', 'recipe_tags', 'step_ingredients'],
  'my_features with a household gives the same answer');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is(public.my_features(), '{}'::text[], 'my_features for a none user is empty');
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is(public.my_features(), array['categorize', 'recipe_import', 'recipe_import_photo', 'recipe_photo_ai', 'recipe_tags', 'step_ingredients'],
  'my_features for an unlimited user is every feature, sorted');

-- Client access -----------------------------------------------------------------
select throws_ok($$ select * from public.plans $$, '42501', null, 'clients can''t read plans');
select throws_ok($$ select * from public.plan_features $$, '42501', null, 'clients can''t read plan_features');
select throws_ok($$ select * from public.user_plans $$, '42501', null, 'clients can''t read user_plans');
select throws_ok(
  $$ insert into public.user_plans (user_id, plan_id) values ('33333333-3333-3333-3333-333333333333', 'plus') $$,
  '42501', null, 'clients can''t assign themselves a plan');
select throws_ok($$ update public.user_plans set plan_id = 'unlimited' $$, '42501', null, 'clients can''t change a plan');
select throws_ok($$ insert into public.plan_features values ('none', 'categorize') $$, '42501', null,
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
  $$ insert into public.user_plans (user_id, plan_id) values ('44444444-4444-4444-4444-444444444444', 'standard') $$,
  '23503', null, 'an unknown plan_id (standard, now gone) is rejected');
select throws_ok(
  $$ insert into public.plan_features values ('plus', 'teleport') $$,
  '23514', null, 'an unknown feature is rejected');
select lives_ok(
  $$ insert into public.plan_features values ('basic', 'recipe_tags') $$,
  'recipe_tags is a known feature');
delete from public.plan_features where plan_id = 'basic' and feature = 'recipe_tags';
select lives_ok(
  $$ insert into public.plan_features values ('none', 'step_ingredients') $$,
  'step_ingredients is a known feature');
delete from public.plan_features where plan_id = 'none' and feature = 'step_ingredients';
select throws_ok(
  $$ update public.plans set is_default = true where id = 'unlimited' $$,
  '23505', null, 'only one plan can be the default');

-- Editing a row stamps assigned_at (now() is fixed within the transaction).
insert into public.user_plans (user_id, plan_id, assigned_at)
  values ('44444444-4444-4444-4444-444444444444', 'none', '2026-01-01');
update public.user_plans set plan_id = 'unlimited' where user_id = '44444444-4444-4444-4444-444444444444';
select is((select assigned_at from public.user_plans where user_id = '44444444-4444-4444-4444-444444444444'),
  now(), 'changing a user''s plan sets assigned_at to now');
select ok(public.has_feature('44444444-4444-4444-4444-444444444444', 'recipe_import'),
  'the new plan takes effect at once');
update public.user_plans set plan_id = 'none' where user_id = '44444444-4444-4444-4444-444444444444';
delete from public.user_plans where user_id = '44444444-4444-4444-4444-444444444444';
select ok(public.has_feature('44444444-4444-4444-4444-444444444444', 'recipe_import')
  and public.has_feature('44444444-4444-4444-4444-444444444444', 'categorize'),
  'deleting the row puts the user back on the default plan');

-- Deleting a user removes their row.
delete from auth.users where id = '33333333-3333-3333-3333-333333333333';
select is_empty($$ select 1 from public.user_plans where user_id = '33333333-3333-3333-3333-333333333333' $$,
  'deleting a user removes their user_plans row');

-- With no default plan, an unassigned user has no features (assigned users keep theirs).
update public.plans set is_default = false where id = 'plus';
select ok(not public.has_feature('11111111-1111-1111-1111-111111111111', 'categorize'),
  'with no default plan, an unassigned user has no features');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is(public.my_features(), '{}'::text[], 'with no default plan, my_features is empty for an unassigned user');
reset role;
insert into public.user_plans (user_id, plan_id) values ('11111111-1111-1111-1111-111111111111', 'basic');
select ok(public.has_feature('11111111-1111-1111-1111-111111111111', 'categorize'),
  'an assigned user keeps their plan with no default');

select * from finish();
rollback;
