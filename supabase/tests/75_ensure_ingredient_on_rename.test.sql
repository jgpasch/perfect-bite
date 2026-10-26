-- Renaming to an unseen ingredient (spec 5): an update through apply_mutations that points a list
-- item or recipe ingredient at a name the catalog hasn't seen adds it as pending, as an insert does.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex owns household A, which has one list and one recipe.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1);
insert into public.lists (id, household_id, name, position) values
  ('a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Groceries', 1);
insert into public.recipes (id, household_id, name) values
  ('a4000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Ribs');

-- As Alex -----------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select is(public.apply_mutations($$ [{ "table": "list_items", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000000-0000-alex",
    "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "smoke saice", "display_name": "smoke saice" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Alex adds an item with a typo');
select is(public.apply_mutations($$ [{ "table": "list_items", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000000-0001-alex",
    "fields": { "ingredient_name": "smoke sauce", "display_name": "smoke sauce" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Alex renames it to a name the catalog has never seen');
select results_eq($$ select i.status, i.household_count from public.list_items li join public.ingredients i on i.normalized_name = li.ingredient_name $$,
  $$ values ('pending', 1) $$, 'the item has the new name, added as pending and counted for the household');

select is(public.apply_mutations($$ [{ "table": "recipe_ingredients", "id": "a5000000-0000-7000-8000-000000000001", "hlc": "1760000000000-0002-alex",
    "fields": { "recipe_id": "a4000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "banana", "display_name": "bananas", "quantity": 2, "unit": null, "position": 1 } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Alex adds a recipe ingredient');
select is(public.apply_mutations($$ [{ "table": "recipe_ingredients", "id": "a5000000-0000-7000-8000-000000000001", "hlc": "1760000000000-0003-alex",
    "fields": { "ingredient_name": "dragon fruit", "display_name": "dragon fruit" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Alex renames it to a name the catalog has never seen');
select results_eq($$ select i.status from public.recipe_ingredients ri join public.ingredients i on i.normalized_name = ri.ingredient_name $$,
  $$ values ('pending') $$, 'the recipe ingredient has the new name, added as pending');

reset role;

select * from finish();
rollback;
