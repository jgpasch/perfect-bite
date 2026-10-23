-- Catalog and system categories (spec 5, 6.2). Aisle orders are in 65_household_aisle_order.
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

-- Fixtures (as postgres) ------------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated');

-- Sam's household has a custom aisle. Household overrides and custom aisles are covered in
-- 13_household_aisles.
insert into public.households (id, name) values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sam''s household');
insert into public.household_members (household_id, user_id, role, position) values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner', 1);
insert into public.categories (id, name, household_id) values
  ('cccccccc-0000-7000-8000-000000000002', 'Sam''s aisle', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

-- Seed ------------------------------------------------------------------------
select results_eq($$ select count(*)::int from public.categories where household_id is null $$,
  $$ values (20) $$, '20 system categories are seeded');
select results_eq($$ select slug, default_rank from public.categories where default_rank in (0, 19) order by default_rank $$,
  $$ values ('produce', 0), ('other', 19) $$, 'system categories keep the store-walk order');
select ok((select count(*) from public.ingredients where categorized_by = 'seed') > 400,
  'the ingredient seed is loaded');
select results_eq($$ select c.slug from public.ingredients i join public.categories c on c.id = i.default_category_id where i.normalized_name = 'banana' $$,
  $$ values ('produce') $$, 'seed ingredients point at their category');
select results_eq($$ select default_unit from public.ingredients where normalized_name in ('milk', 'egg') order by normalized_name $$,
  $$ values ('dozen'), ('gal') $$, 'seed ingredients carry their default unit');
select is((select count(*)::int from public.ingredients where categorized_by = 'seed' and default_unit is null), 0,
  'every seed ingredient has a default unit');

-- As Alex -----------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select results_eq($$ select count(*)::int from public.categories $$,
  $$ values (20) $$, 'Alex sees system categories but not Sam''s custom one');
select ok((select count(*) from public.ingredients) > 400, 'Alex can read the catalog');
select throws_ok($$ insert into public.ingredients (normalized_name, display_name) values ('caviar', 'caviar') $$,
  '42501', null, 'clients can''t write the catalog');
select throws_ok($$ select * from public.ingredient_households $$,
  '42501', null, 'ingredient_households is closed to clients');

select throws_ok($$ insert into public.categories (id, name, household_id) values ('cccccccc-0000-7000-8000-000000000003', 'Sneaky', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') $$,
  '42501', null, 'clients can''t insert categories directly (they go through apply_mutations)');
select throws_ok($$ insert into public.categories (id, slug, name) values ('cccccccc-0000-7000-8000-000000000004', 'fake', 'Fake') $$,
  '42501', null, 'clients can''t add a system category');
select throws_ok($$ update public.categories set name = 'Hacked' where id = '019a4c10-0000-7000-8000-00000000ca01' $$,
  '42501', null, 'clients can''t update categories directly');
select results_eq($$ select name from public.categories where id = '019a4c10-0000-7000-8000-00000000ca01' $$,
  $$ values ('Produce') $$, 'system categories can''t be renamed');

select is(to_regclass('public.user_category_order'), null, 'the per-user, cross-household aisle order is gone');
select is(to_regclass('public.user_category_overrides'), null, 'per-user overrides are gone');

-- Schema (as postgres) -------------------------------------------------------------
reset role;
select throws_ok($$ insert into public.categories (id, name) values ('cccccccc-0000-7000-8000-000000000005', 'Nobody''s') $$,
  '23514', null, 'a custom category needs a household');
select throws_ok($$ insert into public.categories (id, slug, name, household_id) values ('cccccccc-0000-7000-8000-000000000006', 'mine', 'Mine', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') $$,
  '23514', null, 'a category can''t be both system and custom');
select hasnt_column('public', 'categories', 'owner_user_id', 'categories no longer have an owner');

select * from finish();
rollback;
