-- Household data and user settings (spec 5).
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex owns household A; Sam owns household S, which has one list.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated');

insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sam''s household');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner', 1);
insert into public.lists (id, household_id, name, position) values
  ('b1000000-0000-7000-8000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sam''s groceries', 1);

-- As Alex -----------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select lives_ok($$ insert into public.lists (id, household_id, name, position, created_at) values ('a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Groceries', 1, '2026-01-01T00:00:00Z') $$,
  'Alex creates a list in their household');
select results_eq($$ select name, created_at, updated_at > created_at from public.lists $$,
  $$ values ('Groceries', '2026-01-01T00:00:00Z'::timestamptz, true) $$,
  'Alex sees only their own list; created_at is kept and updated_at is server-set');
select throws_ok($$ insert into public.lists (id, household_id, name, position) values ('a1000000-0000-7000-8000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sneaky', 2) $$,
  '42501', null, 'Alex can''t create a list in Sam''s household');

-- A new ingredient goes into the catalog as pending.
select lives_ok($$ insert into public.list_items (id, list_id, household_id, ingredient_name, display_name) values ('a2000000-0000-7000-8000-000000000001', 'a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dragon fruit', 'Dragon fruit') $$,
  'Alex adds an item the catalog has never seen');
select results_eq($$ select status, household_count from public.ingredients where normalized_name = 'dragon fruit' $$,
  $$ values ('pending', 1) $$, 'the ingredient is added as pending, counted for one household');
select lives_ok($$ insert into public.list_items (id, list_id, household_id, ingredient_name, display_name) values ('a2000000-0000-7000-8000-000000000002', 'a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'banana', 'Bananas') $$,
  'Alex adds a seeded ingredient');
select results_eq($$ select status from public.ingredients where normalized_name = 'banana' $$,
  $$ values ('categorized') $$, 'a seeded ingredient stays categorized');

select throws_ok($$ insert into public.list_items (id, list_id, household_id, ingredient_name, display_name) values ('a2000000-0000-7000-8000-000000000003', 'a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'banana', 'bananas') $$,
  '23505', null, 'a second open item for the same ingredient is rejected');
select throws_ok($$ insert into public.list_items (id, list_id, household_id, ingredient_name, display_name) values ('a2000000-0000-7000-8000-000000000004', 'b1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'egg', 'eggs') $$,
  '23503', null, 'an item can''t point at another household''s list');

select lives_ok($$ insert into public.list_item_contributions (id, list_item_id, household_id, quantity, unit) values ('a3000000-0000-7000-8000-000000000001', 'a2000000-0000-7000-8000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 6, null) $$,
  'Alex adds a contribution');
select lives_ok($$ insert into public.recipes (id, household_id, name) values ('a4000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Smoothie') $$,
  'Alex creates a recipe');
select lives_ok($$ insert into public.recipe_ingredients (id, recipe_id, household_id, ingredient_name, display_name, quantity, unit, position) values ('a5000000-0000-7000-8000-000000000001', 'a4000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'banana', 'bananas', 2, null, 1) $$,
  'Alex adds a recipe ingredient');

select lives_ok($$ insert into public.ingredient_usage (household_id, ingredient_name, display_name, use_count, last_used_at) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'banana', 'Bananas', 1, now()) $$,
  'Alex records ingredient usage');
select lives_ok($$ delete from public.ingredient_usage where ingredient_name = 'banana' $$,
  'usage rows can be deleted');
select throws_ok($$ delete from public.list_items $$,
  '42501', null, 'list items are soft-deleted only');

select lives_ok($$ insert into public.user_settings (user_id, default_list_id) values ('11111111-1111-1111-1111-111111111111', 'a1000000-0000-7000-8000-000000000001') $$,
  'Alex sets a default list');

-- As Sam ------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);

select results_eq($$ select (select count(*)::int from public.lists), (select count(*)::int from public.list_items), (select count(*)::int from public.recipes), (select count(*)::int from public.user_settings) $$,
  $$ values (1, 0, 0, 0) $$, 'Sam sees none of Alex''s household data or settings');

select * from finish();
rollback;
