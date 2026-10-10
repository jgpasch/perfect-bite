-- Household data and user settings (spec 5). Writes go through apply_mutations (08 covers its
-- merge rules); this file checks the tables, the ingredient trigger and RLS.
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

select is(public.apply_mutations($$ [{ "table": "lists", "id": "a1000000-0000-7000-8000-000000000001", "hlc": "1760000000000-0000-alex",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Groceries", "position": 1, "created_at": "2026-01-01T00:00:00Z" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Alex creates a list in their household');
select results_eq($$ select name, created_at, updated_at > created_at from public.lists $$,
  $$ values ('Groceries', '2026-01-01T00:00:00Z'::timestamptz, true) $$,
  'Alex sees only their own list; created_at is kept and updated_at is server-set');
select is(public.apply_mutations($$ [{ "table": "lists", "id": "a1000000-0000-7000-8000-000000000002", "hlc": "1760000000000-0001-alex",
    "fields": { "household_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "name": "Sneaky", "position": 2 } }] $$) -> 0 ->> 'code',
  '42501', 'Alex can''t create a list in Sam''s household');

-- A new ingredient goes into the catalog as pending.
select is(public.apply_mutations($$ [{ "table": "list_items", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000000-0002-alex",
    "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "dragon fruit", "display_name": "Dragon fruit" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Alex adds an item the catalog has never seen');
select results_eq($$ select status, household_count from public.ingredients where normalized_name = 'dragon fruit' $$,
  $$ values ('pending', 1) $$, 'the ingredient is added as pending, counted for one household');
select is(public.apply_mutations($$ [{ "table": "list_items", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000000-0003-alex",
    "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "banana", "display_name": "Bananas" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Alex adds a seeded ingredient');
select results_eq($$ select status from public.ingredients where normalized_name = 'banana' $$,
  $$ values ('categorized') $$, 'a seeded ingredient stays categorized');

select throws_ok($$ insert into public.list_items (id, list_id, household_id, ingredient_name, display_name) values ('a2000000-0000-7000-8000-000000000003', 'a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'egg', 'eggs') $$,
  '42501', null, 'list items can''t be inserted directly');
select is(public.apply_mutations($$ [{ "table": "list_items", "id": "a2000000-0000-7000-8000-000000000004", "hlc": "1760000000000-0004-alex",
    "fields": { "list_id": "b1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "egg", "display_name": "eggs" } }] $$) -> 0 ->> 'code',
  '23503', 'an item can''t point at another household''s list');

select is(public.apply_mutations($$ [{ "table": "list_item_contributions", "id": "a3000000-0000-7000-8000-000000000001", "hlc": "1760000000000-0005-alex",
    "fields": { "list_item_id": "a2000000-0000-7000-8000-000000000002", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "quantity": 6, "unit": null } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Alex adds a contribution');
select is(public.apply_mutations($$ [{ "table": "recipes", "id": "a4000000-0000-7000-8000-000000000001", "hlc": "1760000000000-0006-alex",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Smoothie" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Alex creates a recipe');
select is(public.apply_mutations($$ [{ "table": "recipe_ingredients", "id": "a5000000-0000-7000-8000-000000000001", "hlc": "1760000000000-0007-alex",
    "fields": { "recipe_id": "a4000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "banana", "display_name": "bananas", "quantity": 2, "unit": null, "position": 1 } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Alex adds a recipe ingredient');

select is(public.apply_mutations($$ [{ "table": "ingredient_usage", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "banana" }, "hlc": "1760000000000-0008-alex",
    "fields": { "display_name": "Bananas", "last_used_at": "2026-10-10T12:00:00Z" }, "counters": { "use_count": 1 } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Alex records ingredient usage');
select throws_ok($$ delete from public.ingredient_usage where ingredient_name = 'banana' $$,
  '42501', null, 'usage rows can''t be deleted directly');
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
