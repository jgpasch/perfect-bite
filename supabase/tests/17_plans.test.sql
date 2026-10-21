-- Plans and features (spec 4.12, 5): the seeded plans, the two feature keys, household_plans,
-- has_feature (a null household is false), my_household_features, client access, and the per-user
-- pieces (user_plans, my_features, initial_household_plan) dropped.
begin;
create extension if not exists pgtap with schema extensions;
select plan(49);

-- Fixtures (as postgres) ------------------------------------------------------
-- Shared (founding): Alex owner, Sam and Kim members. Kim also owns Cabin (unlimited). Lee owns
-- Attic (free) and is in Loft (no household_plans row). Max is in no household.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'kim@test.local', 'authenticated', 'authenticated'),
  ('44444444-4444-4444-4444-444444444444', 'lee@test.local', 'authenticated', 'authenticated'),
  ('55555555-5555-5555-5555-555555555555', 'max@test.local', 'authenticated', 'authenticated');

insert into public.households (id, name) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Shared'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', 'Cabin'),
  ('aaaaaaaa-0000-0000-0000-00000000000c', 'Attic'),
  ('aaaaaaaa-0000-0000-0000-00000000000d', 'Loft');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222', 'member', 1),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333', 'member', 1),
  ('aaaaaaaa-0000-0000-0000-00000000000b', '33333333-3333-3333-3333-333333333333', 'owner', 2),
  ('aaaaaaaa-0000-0000-0000-00000000000c', '44444444-4444-4444-4444-444444444444', 'owner', 1),
  ('aaaaaaaa-0000-0000-0000-00000000000d', '44444444-4444-4444-4444-444444444444', 'member', 2);
insert into public.household_plans (household_id, plan_id) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'founding'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', 'unlimited'),
  ('aaaaaaaa-0000-0000-0000-00000000000c', 'free');

-- Seeded plans ------------------------------------------------------------------
select results_eq(
  $$ select id, name from public.plans order by id $$,
  $$ values ('founding', 'Founding'), ('free', 'Free'), ('unlimited', 'Unlimited') $$,
  'the plans are founding, free and unlimited; plus, none and basic are gone');
select is((select count(*)::int from public.plans where is_default), 1, 'exactly one plan is the default');
select results_eq(
  $$ select plan_id, feature from public.plan_features order by plan_id, feature $$,
  $$ values ('founding', 'recipe_import'), ('founding', 'recipe_photo_ai'),
            ('unlimited', 'recipe_import'), ('unlimited', 'recipe_photo_ai') $$,
  'founding and unlimited have both features; free has none');
select results_eq(
  $$ select plan_id, feature, monthly_limit from public.plan_limits order by plan_id, feature $$,
  $$ values ('founding', 'recipe_import', 50), ('founding', 'recipe_photo_ai', 20),
            ('unlimited', 'recipe_import', null::integer), ('unlimited', 'recipe_photo_ai', null::integer) $$,
  'founding allows 50 imports and 20 AI photos a month; unlimited has no limits');
select hasnt_table('public', 'user_plans', 'user_plans is dropped: a plan belongs to a household');

-- The two feature keys ------------------------------------------------------------
select is(private.feature_keys(), array['recipe_import', 'recipe_photo_ai'], 'feature_keys is the two keys');
select throws_ok($$ insert into public.plan_features values ('unlimited', 'categorize') $$,
  '23514', null, 'categorize is no longer a feature');
select throws_ok($$ insert into public.plan_features values ('unlimited', 'recipe_import_photo') $$,
  '23514', null, 'recipe_import_photo is no longer a feature');
select throws_ok($$ insert into public.plan_features values ('unlimited', 'recipe_tags') $$,
  '23514', null, 'recipe_tags is no longer a feature');
select throws_ok($$ insert into public.plan_features values ('unlimited', 'step_ingredients') $$,
  '23514', null, 'step_ingredients is no longer a feature');
select throws_ok($$ insert into public.plan_limits values ('founding', 'categorize', 250) $$,
  '23514', null, 'plan_limits refuses an old key too');

-- The import rule is gone: a plan can have recipe_import with nothing else.
select is_empty(
  $$ select 1 from pg_trigger where tgrelid = 'public.plan_features'::regclass
     and tgname = 'plan_features_import_needs_categorize' $$,
  'the import-needs-categorize trigger is dropped');
select lives_ok($$ insert into public.plan_features values ('free', 'recipe_import') $$,
  'a plan gains recipe_import on its own');
delete from public.plan_features where plan_id = 'free';

-- has_feature -------------------------------------------------------------------
select ok(public.has_feature('11111111-1111-1111-1111-111111111111', 'recipe_import', 'aaaaaaaa-0000-0000-0000-00000000000a'),
  'the owner of a founding household gets recipe_import there');
select ok(public.has_feature('22222222-2222-2222-2222-222222222222', 'recipe_photo_ai', 'aaaaaaaa-0000-0000-0000-00000000000a'),
  'a member (not owner) gets the household''s features too');
select ok(not public.has_feature('44444444-4444-4444-4444-444444444444', 'recipe_import', 'aaaaaaaa-0000-0000-0000-00000000000c'),
  'a free household has no recipe_import');
select ok(not public.has_feature('44444444-4444-4444-4444-444444444444', 'recipe_import', 'aaaaaaaa-0000-0000-0000-00000000000d'),
  'a household with no row has no features');
select ok(not public.has_feature('44444444-4444-4444-4444-444444444444', 'recipe_import', 'aaaaaaaa-0000-0000-0000-00000000000a'),
  'a non-member gets nothing from a founding household');
select ok(not public.has_feature('11111111-1111-1111-1111-111111111111', 'recipe_import', 'ffffffff-0000-0000-0000-00000000000f'),
  'an unknown household gives nothing');
select ok(not public.has_feature('11111111-1111-1111-1111-111111111111', 'categorize', 'aaaaaaaa-0000-0000-0000-00000000000a'),
  'an old key is never granted');
select ok(public.has_feature('33333333-3333-3333-3333-333333333333', 'recipe_import', 'aaaaaaaa-0000-0000-0000-00000000000b'),
  'Kim gets recipe_import in their unlimited Cabin');

-- A null household is false: every request names the household it acts in.
select ok(not public.has_feature('33333333-3333-3333-3333-333333333333', 'recipe_photo_ai'),
  'a null household: false, though both of Kim''s households have the feature');
select ok(not public.has_feature('33333333-3333-3333-3333-333333333333', 'recipe_import', null),
  'a null household passed explicitly: false');
select ok(not public.has_feature('55555555-5555-5555-5555-555555555555', 'recipe_import'),
  'a null household: a user in no household gets nothing');
update public.household_plans set plan_id = 'founding' where household_id = 'aaaaaaaa-0000-0000-0000-00000000000c';
select ok(public.has_feature('44444444-4444-4444-4444-444444444444', 'recipe_import', 'aaaaaaaa-0000-0000-0000-00000000000c')
  and not public.has_feature('44444444-4444-4444-4444-444444444444', 'recipe_import'),
  'moving Lee''s Attic to founding gives recipe_import in Attic, still not with no household');

-- The row decides at once, and editing it stamps assigned_at (now() is fixed in the transaction).
update public.household_plans set plan_id = 'free', assigned_at = '2026-01-01'
  where household_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
select ok(not public.has_feature('11111111-1111-1111-1111-111111111111', 'recipe_import', 'aaaaaaaa-0000-0000-0000-00000000000a'),
  'moving a household to free takes its features away at once');
select is((select assigned_at from public.household_plans where household_id = 'aaaaaaaa-0000-0000-0000-00000000000a'),
  now(), 'changing a household''s plan sets assigned_at to now');
update public.household_plans set plan_id = 'founding' where household_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
update public.household_plans set plan_id = 'free' where household_id = 'aaaaaaaa-0000-0000-0000-00000000000c';

-- Changing the default plan moves no household with a row, and gives nothing to one without.
update public.plans set is_default = false where is_default;
update public.plans set is_default = true where id = 'free';
select ok(public.has_feature('11111111-1111-1111-1111-111111111111', 'recipe_import', 'aaaaaaaa-0000-0000-0000-00000000000a'),
  'a new default (free) leaves a founding household on founding');
update public.plans set is_default = false where is_default;
update public.plans set is_default = true where id = 'unlimited';
select ok(not public.has_feature('44444444-4444-4444-4444-444444444444', 'recipe_import', 'aaaaaaaa-0000-0000-0000-00000000000d'),
  'a household with no row has no features, whatever the default');

-- my_household_features (as authenticated) ------------------------------------------
-- A plan with only AI photos.
insert into public.plans (id, name) values ('photos', 'Photos');
insert into public.plan_features values ('photos', 'recipe_photo_ai');
insert into public.household_plans (household_id, plan_id) values ('aaaaaaaa-0000-0000-0000-00000000000d', 'photos');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is(public.my_household_features(),
  '{"households": {"aaaaaaaa-0000-0000-0000-00000000000a": ["recipe_import", "recipe_photo_ai"],
                   "aaaaaaaa-0000-0000-0000-00000000000b": ["recipe_import", "recipe_photo_ai"]}}'::jsonb,
  'my_household_features gives each of Kim''s households its features, sorted');

select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
select is(public.my_household_features(),
  '{"households": {"aaaaaaaa-0000-0000-0000-00000000000c": [],
                   "aaaaaaaa-0000-0000-0000-00000000000d": ["recipe_photo_ai"]}}'::jsonb,
  'my_household_features lists a free household with no features');

select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}', true);
select is(public.my_household_features(), '{"households": {}}'::jsonb,
  'my_household_features for a user in no household is empty');
reset role;
select ok(to_regprocedure('public.my_features(uuid)') is null,
  'my_features (old builds'' per-user answer in the old keys) is dropped');
set local role authenticated;

-- Client access -----------------------------------------------------------------
select throws_ok($$ select * from public.household_plans $$, '42501', null, 'clients can''t read household_plans');
select throws_ok(
  $$ insert into public.household_plans (household_id, plan_id) values ('aaaaaaaa-0000-0000-0000-00000000000d', 'unlimited') $$,
  '42501', null, 'clients can''t give a household a plan');
select throws_ok($$ update public.household_plans set plan_id = 'unlimited' $$, '42501', null,
  'clients can''t change a household''s plan');
select throws_ok($$ select * from public.plans $$, '42501', null, 'clients can''t read plans');
select throws_ok($$ select * from public.plan_features $$, '42501', null, 'clients can''t read plan_features');
select throws_ok($$ select public.has_feature('33333333-3333-3333-3333-333333333333', 'recipe_import') $$,
  '42501', null, 'clients can''t execute has_feature');
reset role;

select ok(
  has_function_privilege('service_role', 'public.has_feature(uuid, text, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.has_feature(uuid, text, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.has_feature(uuid, text, uuid)', 'execute'),
  'only service_role can execute has_feature');
select ok(
  has_function_privilege('authenticated', 'public.my_household_features()', 'execute')
  and not has_function_privilege('anon', 'public.my_household_features()', 'execute')
  and not has_function_privilege('public', 'public.my_household_features()', 'execute'),
  'only signed-in users can execute my_household_features');
select ok(
  not has_table_privilege('anon', 'public.household_plans', 'select')
  and not has_table_privilege('authenticated', 'public.household_plans', 'select')
  and not has_table_privilege('anon', 'public.plans', 'select'),
  'anon and authenticated can''t read the plan tables');
select is((select relrowsecurity from pg_class where oid = 'public.household_plans'::regclass), true,
  'household_plans has RLS on');
select ok(
  not has_function_privilege('authenticated', 'private.household_has_feature(uuid, text)', 'execute')
  and not has_function_privilege('service_role', 'private.household_has_feature(uuid, text)', 'execute'),
  'the private resolution helpers aren''t executable by clients');

-- household_plans rules -----------------------------------------------------------
select throws_ok(
  $$ insert into public.household_plans (household_id, plan_id) values ('aaaaaaaa-0000-0000-0000-00000000000d', 'unlimited') $$,
  '23505', null, 'one row per household');
select throws_ok(
  $$ update public.household_plans set plan_id = 'plus' where household_id = 'aaaaaaaa-0000-0000-0000-00000000000d' $$,
  '23503', null, 'an unknown plan id (plus, now gone) is rejected');
select throws_ok($$ delete from public.plans where id = 'photos' $$,
  '23503', null, 'a plan a household is on can''t be deleted');
delete from public.households where id = 'aaaaaaaa-0000-0000-0000-00000000000d';
select is_empty($$ select 1 from public.household_plans where household_id = 'aaaaaaaa-0000-0000-0000-00000000000d' $$,
  'deleting a household deletes its row');

-- The per-user plan pieces are gone ---------------------------------------------------
select ok(to_regprocedure('private.initial_household_plan(uuid)') is null,
  'initial_household_plan (the migration''s rule over user_plans) is dropped');

select * from finish();
rollback;
