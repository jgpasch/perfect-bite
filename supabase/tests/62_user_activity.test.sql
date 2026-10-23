-- User activity logging (spec 4.12 User activity, 5, 6.5): the private.log_user_activity() triggers,
-- the household functions' one entry each, account deletion and retention.
begin;
create extension if not exists pgtap with schema extensions;
select plan(89);

-- Fixtures (as postgres, no user, so nothing is logged) ------------------------------------------
-- Alex owns Home; Sam and Pat are members. Dana has no household yet; Eve is invited later.
insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated', '{}'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated', '{"given_name": "Sam", "family_name": "Lee"}'),
  ('33333333-3333-3333-3333-333333333333', 'pat@test.local', 'authenticated', 'authenticated', '{}'),
  ('44444444-4444-4444-4444-444444444444', 'dana@test.local', 'authenticated', 'authenticated', '{}'),
  ('55555555-5555-5555-5555-555555555555', 'eve@test.local', 'authenticated', 'authenticated', '{}');
insert into public.households (id, name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Home');
insert into public.household_members (household_id, user_id, role, position, joined_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1, now() - interval '3 days'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'member', 1, now() - interval '2 days'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'member', 1, now() - interval '1 day');
insert into public.ingredients (normalized_name, display_name) values
  ('lime', 'Lime'), ('tomato', 'Tomato'), ('onion', 'Onion'), ('pasta', 'Pasta'), ('cheese', 'Cheese')
on conflict do nothing;
insert into public.user_settings (user_id) values ('11111111-1111-1111-1111-111111111111')
on conflict do nothing;
insert into public.notification_settings (user_id) values ('11111111-1111-1111-1111-111111111111')
on conflict do nothing;
delete from private.user_activity;

-- Helpers ------------------------------------------------------------------------------------------
create temp sequence hlc_seq;

-- One mutation through apply_mutations, with a newer hlc each time; returns its result.
create function pg_temp.push(p_table text, p_id text, p_fields jsonb) returns jsonb language sql as $$
  select public.apply_mutations(jsonb_build_array(jsonb_build_object(
    'table', p_table, 'id', p_id, 'fields', p_fields,
    'hlc', '1770000' || lpad(nextval('hlc_seq')::text, 6, '0') || '-0000-test'))) -> 0
$$;
create function pg_temp.push_key(p_table text, p_key jsonb, p_fields jsonb) returns jsonb language sql as $$
  select public.apply_mutations(jsonb_build_array(jsonb_build_object(
    'table', p_table, 'key', p_key, 'fields', p_fields,
    'hlc', '1770000' || lpad(nextval('hlc_seq')::text, 6, '0') || '-0000-test'))) -> 0
$$;
-- Takes the entries logged so far (oldest first) and clears them.
create function pg_temp.taken() returns jsonb language sql as $$
  with t as (delete from private.user_activity returning *)
  select coalesce(jsonb_agg(jsonb_build_object('area', area, 'action', action, 'entity', entity_id, 'data', data) order by id), '[]')
  from t
$$;
create function pg_temp.as_user(p_id text, p_email text default null) returns void language sql as $$
  select set_config('request.jwt.claims',
    jsonb_build_object('sub', p_id, 'role', 'authenticated', 'email', p_email)::text, true);
$$;

-- Privileges -------------------------------------------------------------------------------------
select ok(not has_table_privilege('authenticated', 'private.user_activity', 'select'),
  'authenticated has no select on user_activity');
select ok(not has_table_privilege('anon', 'private.user_activity', 'select'),
  'anon has no select on user_activity');
select ok(not has_function_privilege('authenticated', 'private.log_user_activity()', 'execute'),
  'authenticated can''t execute the trigger function');
select ok(not has_function_privilege('authenticated', 'private.activity_list_items(public.list_items, public.list_items)', 'execute'),
  'authenticated can''t execute a table''s function');
select ok(not has_function_privilege('anon', 'private.set_activity_action(text, uuid, text, jsonb)', 'execute'),
  'anon can''t set an action');
set local role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok($$ select count(*) from private.user_activity $$, '42501', null,
  'a signed-in client can''t read user_activity');
reset role;
select is((select count(*)::int from pg_trigger where tgname like '%_log_user_activity'), 18,
  'the trigger is on 18 tables');
select ok(not exists (select 1 from pg_trigger where tgname like '%_log_user_activity'
  and tgrelid in ('public.ingredient_usage'::regclass, 'public.ingredient_unit_usage'::regclass)),
  'not on the usage counters');

-- No auth.uid() ------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
insert into public.lists (id, household_id, name, position) values
  ('a1000000-0000-7000-8000-000000000009', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Dashboard list', 9);
update public.lists set name = 'Dashboard list 2' where id = 'a1000000-0000-7000-8000-000000000009';
select is(pg_temp.taken(), '[]'::jsonb, 'a write with no auth.uid() logs nothing');

-- Lists, through apply_mutations (as Alex) ---------------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');

select pg_temp.push('lists', 'a1000000-0000-7000-8000-000000000001',
  '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Groceries", "position": 1}');
select results_eq(
  $$ select user_id, household_id, area, action, entity_id, data from private.user_activity $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'lists', 'list.created',
     'a1000000-0000-7000-8000-000000000001', '{"household": "Home", "list": "Groceries"}'::jsonb) $$,
  'list.created, as the caller, with the household and its name');
select is((select txid from private.user_activity), txid_current(), 'the entry has the transaction''s txid');
select pg_temp.taken();

select pg_temp.push('lists', 'a1000000-0000-7000-8000-000000000001', '{"name": "Weekly"}');
select is(pg_temp.taken(), $$[{"area": "lists", "action": "list.renamed", "entity": "a1000000-0000-7000-8000-000000000001",
  "data": {"household": "Home", "list": "Weekly", "from": "Groceries"}}]$$::jsonb, 'list.renamed');

select pg_temp.push('lists', 'a1000000-0000-7000-8000-000000000001', '{"emoji": "🥦", "color": "green"}');
select is(pg_temp.taken(), $$[{"area": "lists", "action": "list.edited", "entity": "a1000000-0000-7000-8000-000000000001",
  "data": {"household": "Home", "list": "Weekly", "fields": ["color", "emoji"]}}]$$::jsonb, 'list.edited names the fields');

select pg_temp.push('lists', 'a1000000-0000-7000-8000-000000000001', '{"position": 5}');
select is(pg_temp.taken(), $$[{"area": "lists", "action": "list.reordered", "entity": "a1000000-0000-7000-8000-000000000001",
  "data": {"household": "Home", "list": "Weekly"}}]$$::jsonb, 'list.reordered');

select pg_temp.push('lists', 'a1000000-0000-7000-8000-000000000001', '{"archived_at": "2026-10-21T10:00:00Z"}');
select pg_temp.push('lists', 'a1000000-0000-7000-8000-000000000001', '{"archived_at": null}');
select is(pg_temp.taken(), $$[
  {"area": "lists", "action": "list.archived", "entity": "a1000000-0000-7000-8000-000000000001", "data": {"household": "Home", "list": "Weekly"}},
  {"area": "lists", "action": "list.unarchived", "entity": "a1000000-0000-7000-8000-000000000001", "data": {"household": "Home", "list": "Weekly"}}
]$$::jsonb, 'list.archived and list.unarchived');

select pg_temp.push('lists', 'a1000000-0000-7000-8000-000000000001', '{"deleted_at": "2026-10-21T10:00:00Z"}');
select pg_temp.push('lists', 'a1000000-0000-7000-8000-000000000001', '{"deleted_at": null}');
select is(pg_temp.taken(), $$[
  {"area": "lists", "action": "list.deleted", "entity": "a1000000-0000-7000-8000-000000000001", "data": {"household": "Home", "list": "Weekly"}},
  {"area": "lists", "action": "list.restored", "entity": "a1000000-0000-7000-8000-000000000001", "data": {"household": "Home", "list": "Weekly"}}
]$$::jsonb, 'list.deleted and list.restored');

update public.lists set updated_at = now() + interval '1 hour', field_clock = field_clock || '{"x": "y"}',
  created_at = now() - interval '1 day'
where id = 'a1000000-0000-7000-8000-000000000001';
select is(pg_temp.taken(), '[]'::jsonb, 'an update touching only updated_at, field_clock and created_at logs nothing');
select is(pg_temp.push('lists', 'a1000000-0000-7000-8000-000000000001', '{"name": "Weekly"}'), '{"status": "applied"}'::jsonb,
  'a newer mutation setting the same name is applied (only its clock moves)');
select is(pg_temp.taken(), '[]'::jsonb, 'and logs nothing');

select pg_temp.push('lists', 'a1000000-0000-7000-8000-000000000002',
  '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Costco", "position": 2}');
select pg_temp.taken();

-- Recipes --------------------------------------------------------------------------------------------
select is(public.apply_mutations($$ [
  { "table": "recipes", "id": "b1000000-0000-7000-8000-000000000001", "hlc": "1760000900000-0000-test",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Lasagna" } },
  { "table": "recipe_ingredients", "id": "b2000000-0000-7000-8000-000000000001", "hlc": "1760000900000-0001-test",
    "fields": { "recipe_id": "b1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "ingredient_name": "pasta", "display_name": "Pasta", "position": 1 } },
  { "table": "recipe_ingredients", "id": "b2000000-0000-7000-8000-000000000002", "hlc": "1760000900000-0002-test",
    "fields": { "recipe_id": "b1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "ingredient_name": "tomato", "display_name": "Tomatoes", "position": 2 } },
  { "table": "recipe_ingredients", "id": "b2000000-0000-7000-8000-000000000003", "hlc": "1760000900000-0003-test",
    "fields": { "recipe_id": "b1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "ingredient_name": "cheese", "display_name": "Cheese", "position": 3 } }
] $$), '[{"status": "applied"}, {"status": "applied"}, {"status": "applied"}, {"status": "applied"}]'::jsonb,
  'a recipe with three ingredients is pushed');
select results_eq(
  $$ select action, count(*)::int, count(distinct txid)::int from private.user_activity group by action order by action $$,
  $$ values ('ingredient.added', 3, 1), ('recipe.created', 1, 1) $$,
  'one recipe.created and three ingredient.added');
select is((select count(distinct txid)::int from private.user_activity), 1, 'all four share one txid');
select is(pg_temp.taken(), $$[
  {"area": "recipes", "action": "recipe.created", "entity": "b1000000-0000-7000-8000-000000000001",
   "data": {"household": "Home", "recipe": "Lasagna", "source": "manual"}},
  {"area": "recipes", "action": "ingredient.added", "entity": "b2000000-0000-7000-8000-000000000001",
   "data": {"household": "Home", "recipe": "Lasagna", "recipe_id": "b1000000-0000-7000-8000-000000000001", "ingredient": "Pasta"}},
  {"area": "recipes", "action": "ingredient.added", "entity": "b2000000-0000-7000-8000-000000000002",
   "data": {"household": "Home", "recipe": "Lasagna", "recipe_id": "b1000000-0000-7000-8000-000000000001", "ingredient": "Tomatoes"}},
  {"area": "recipes", "action": "ingredient.added", "entity": "b2000000-0000-7000-8000-000000000003",
   "data": {"household": "Home", "recipe": "Lasagna", "recipe_id": "b1000000-0000-7000-8000-000000000001", "ingredient": "Cheese"}}
]$$::jsonb, 'recipe.created (manual) and ingredient.added with their data');

select pg_temp.push('recipes', 'b1000000-0000-7000-8000-000000000002',
  '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Tacos", "source_url": "https://www.SeriousEats.com/tacos?x=1"}');
select pg_temp.push('recipes', 'b1000000-0000-7000-8000-000000000003',
  '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Gran''s soup", "source_pages": ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/b1000000-0000-7000-8000-000000000003/f0000000-0000-7000-8000-000000000001.jpg"]}');
select is(
  (select jsonb_agg(e -> 'data' -> 'source') from jsonb_array_elements(pg_temp.taken()) e),
  '["seriouseats.com", "photo"]'::jsonb,
  'a recipe''s source is its link''s host without www., or photo');

select pg_temp.push('recipes', 'b1000000-0000-7000-8000-000000000001', '{"name": "Lasagne"}');
select is(pg_temp.taken(), $$[{"area": "recipes", "action": "recipe.renamed", "entity": "b1000000-0000-7000-8000-000000000001",
  "data": {"household": "Home", "recipe": "Lasagne", "from": "Lasagna"}}]$$::jsonb, 'recipe.renamed');

select pg_temp.push('recipes', 'b1000000-0000-7000-8000-000000000001', '{"notes": "Secret family trick", "servings": 4}');
select is(pg_temp.taken(), $$[{"area": "recipes", "action": "recipe.edited", "entity": "b1000000-0000-7000-8000-000000000001",
  "data": {"household": "Home", "recipe": "Lasagne", "fields": ["notes", "servings"]}}]$$::jsonb,
  'recipe.edited names the fields, never the text');

select pg_temp.push('recipes', 'b1000000-0000-7000-8000-000000000001', '{"tags": {"meal": ["dinner"]}, "tags_edited": true}');
select is(pg_temp.taken(), $$[{"area": "recipes", "action": "recipe.tagged", "entity": "b1000000-0000-7000-8000-000000000001",
  "data": {"household": "Home", "recipe": "Lasagne"}}]$$::jsonb, 'recipe.tagged');

select pg_temp.push('recipes', 'b1000000-0000-7000-8000-000000000001',
  '{"photo_path": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/b1000000-0000-7000-8000-000000000001/f0000000-0000-7000-8000-000000000002.jpg"}');
select pg_temp.push('recipes', 'b1000000-0000-7000-8000-000000000001', '{"photo_path": null}');
select is((select jsonb_agg(e -> 'action') from jsonb_array_elements(pg_temp.taken()) e),
  '["recipe.photo_added", "recipe.photo_removed"]'::jsonb, 'recipe.photo_added and recipe.photo_removed');

select pg_temp.push('recipes', 'b1000000-0000-7000-8000-000000000003', '{"deleted_at": "2026-10-21T10:00:00Z"}');
select pg_temp.push('recipes', 'b1000000-0000-7000-8000-000000000003', '{"deleted_at": null}');
select is(pg_temp.taken(), $$[
  {"area": "recipes", "action": "recipe.deleted", "entity": "b1000000-0000-7000-8000-000000000003", "data": {"household": "Home", "recipe": "Gran's soup"}},
  {"area": "recipes", "action": "recipe.restored", "entity": "b1000000-0000-7000-8000-000000000003", "data": {"household": "Home", "recipe": "Gran's soup"}}
]$$::jsonb, 'recipe.deleted and recipe.restored');

select pg_temp.push('recipe_ingredients', 'b2000000-0000-7000-8000-000000000002', '{"quantity": 2, "unit": "can"}');
select is(pg_temp.taken(), $$[{"area": "recipes", "action": "ingredient.edited", "entity": "b2000000-0000-7000-8000-000000000002",
  "data": {"household": "Home", "recipe": "Lasagne", "recipe_id": "b1000000-0000-7000-8000-000000000001", "ingredient": "Tomatoes",
    "fields": ["quantity", "unit"]}}]$$::jsonb, 'ingredient.edited');

select pg_temp.push('recipe_ingredients', 'b2000000-0000-7000-8000-000000000003', '{"position": 0.5}');
select is(pg_temp.taken(), $$[{"area": "recipes", "action": "ingredient.reordered", "entity": "b2000000-0000-7000-8000-000000000003",
  "data": {"household": "Home", "recipe": "Lasagne", "recipe_id": "b1000000-0000-7000-8000-000000000001", "ingredient": "Cheese"}}]$$::jsonb,
  'ingredient.reordered when only its position changed');

select pg_temp.push('recipe_ingredients', 'b2000000-0000-7000-8000-000000000003', '{"deleted_at": "2026-10-21T10:00:00Z"}');
select is(pg_temp.taken(), $$[{"area": "recipes", "action": "ingredient.removed", "entity": "b2000000-0000-7000-8000-000000000003",
  "data": {"household": "Home", "recipe": "Lasagne", "recipe_id": "b1000000-0000-7000-8000-000000000001", "ingredient": "Cheese"}}]$$::jsonb,
  'ingredient.removed');

-- List items -------------------------------------------------------------------------------------------
select is(public.apply_mutations($$ [
  { "table": "list_items", "id": "c1000000-0000-7000-8000-000000000001", "hlc": "1760000910000-0000-test",
    "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "ingredient_name": "lime", "display_name": "Lime" } },
  { "table": "list_item_contributions", "id": "c2000000-0000-7000-8000-000000000001", "hlc": "1760000910000-0001-test",
    "fields": { "list_item_id": "c1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "source": "manual", "quantity": 2, "unit": "kg", "added_by": "11111111-1111-1111-1111-111111111111" } }
] $$), '[{"status": "applied"}, {"status": "applied"}]'::jsonb, 'an item and its first contribution are pushed together');
select is(pg_temp.taken(), $$[{"area": "lists", "action": "item.added", "entity": "c2000000-0000-7000-8000-000000000001",
  "data": {"household": "Home", "list": "Weekly", "list_id": "a1000000-0000-7000-8000-000000000001", "item": "Lime",
    "item_id": "c1000000-0000-7000-8000-000000000001", "source": "manual", "quantity": 2, "unit": "kg"}}]$$::jsonb,
  'one item.added, from the contribution');

select pg_temp.push('list_items', 'c1000000-0000-7000-8000-000000000002',
  '{"list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "tomato", "display_name": "Tomato"}');
select is(pg_temp.taken(), $$[{"area": "lists", "action": "item.added", "entity": "c1000000-0000-7000-8000-000000000002",
  "data": {"household": "Home", "list": "Weekly", "list_id": "a1000000-0000-7000-8000-000000000001", "item": "Tomato",
    "item_id": "c1000000-0000-7000-8000-000000000002"}}]$$::jsonb,
  'an item inserted without a contribution logs item.added from the item');

select pg_temp.push('list_item_contributions', 'c2000000-0000-7000-8000-000000000002',
  '{"list_item_id": "c1000000-0000-7000-8000-000000000002", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "source": "recipe", "recipe_id": "b1000000-0000-7000-8000-000000000001", "quantity": 1}');
select is(pg_temp.taken(), $$[{"area": "lists", "action": "item.added", "entity": "c2000000-0000-7000-8000-000000000002",
  "data": {"household": "Home", "list": "Weekly", "list_id": "a1000000-0000-7000-8000-000000000001", "item": "Tomato",
    "item_id": "c1000000-0000-7000-8000-000000000002", "source": "recipe", "quantity": 1, "unit": null,
    "recipe": "Lasagne", "recipe_id": "b1000000-0000-7000-8000-000000000001"}}]$$::jsonb,
  'item.added from a recipe has the recipe');

select pg_temp.push('list_items', 'c1000000-0000-7000-8000-000000000001', '{"checked_at": "2026-10-21T10:00:00Z", "checked_by": "11111111-1111-1111-1111-111111111111"}');
select pg_temp.push('list_items', 'c1000000-0000-7000-8000-000000000001', '{"checked_at": null, "checked_by": null}');
select is(pg_temp.taken(), $$[
  {"area": "lists", "action": "item.checked", "entity": "c1000000-0000-7000-8000-000000000001", "data": {"household": "Home", "list": "Weekly", "item": "Lime"}},
  {"area": "lists", "action": "item.unchecked", "entity": "c1000000-0000-7000-8000-000000000001", "data": {"household": "Home", "list": "Weekly", "item": "Lime"}}
]$$::jsonb, 'item.checked and item.unchecked');

select pg_temp.push('list_items', 'c1000000-0000-7000-8000-000000000001', '{"list_id": "a1000000-0000-7000-8000-000000000002"}');
select is(pg_temp.taken(), $$[{"area": "lists", "action": "item.moved", "entity": "c1000000-0000-7000-8000-000000000001",
  "data": {"household": "Home", "item": "Lime", "from": "Weekly", "to": "Costco"}}]$$::jsonb, 'item.moved names both lists');

select pg_temp.push('list_items', 'c1000000-0000-7000-8000-000000000001', '{"display_name": "Limes"}');
select is(pg_temp.taken(), $$[{"area": "lists", "action": "item.renamed", "entity": "c1000000-0000-7000-8000-000000000001",
  "data": {"household": "Home", "item": "Limes", "from": "Lime"}}]$$::jsonb, 'item.renamed');

select pg_temp.push('list_items', 'c1000000-0000-7000-8000-000000000001', '{"note": "the ripe ones"}');
select is(pg_temp.taken(), $$[{"area": "lists", "action": "item.edited", "entity": "c1000000-0000-7000-8000-000000000001",
  "data": {"household": "Home", "list": "Costco", "item": "Limes", "fields": ["note"]}}]$$::jsonb, 'item.edited for the note, without its text');

select pg_temp.push('list_item_contributions', 'c2000000-0000-7000-8000-000000000001', '{"quantity": 3}');
select is(pg_temp.taken(), $$[{"area": "lists", "action": "item.edited", "entity": "c2000000-0000-7000-8000-000000000001",
  "data": {"household": "Home", "list": "Costco", "item": "Limes", "fields": ["quantity"]}}]$$::jsonb, 'item.edited for a contribution''s quantity');

select pg_temp.push('list_items', 'c1000000-0000-7000-8000-000000000001',
  '{"photo_path": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/c1000000-0000-7000-8000-000000000001/f0000000-0000-7000-8000-000000000003.jpg"}');
select pg_temp.push('list_items', 'c1000000-0000-7000-8000-000000000001', '{"photo_path": null}');
select is((select jsonb_agg(e -> 'action') from jsonb_array_elements(pg_temp.taken()) e),
  '["item.photo_added", "item.photo_removed"]'::jsonb, 'item.photo_added and item.photo_removed');

select pg_temp.push('list_item_contributions', 'c2000000-0000-7000-8000-000000000002', '{"deleted_at": "2026-10-21T10:00:00Z"}');
select is(pg_temp.taken(), $$[{"area": "lists", "action": "item.add_undone", "entity": "c2000000-0000-7000-8000-000000000002",
  "data": {"household": "Home", "list": "Weekly", "item": "Tomato"}}]$$::jsonb, 'item.add_undone');

select pg_temp.push('list_items', 'c1000000-0000-7000-8000-000000000002', '{"deleted_at": "2026-10-21T10:00:00Z"}');
select pg_temp.push('list_items', 'c1000000-0000-7000-8000-000000000002', '{"deleted_at": null}');
select is(pg_temp.taken(), $$[
  {"area": "lists", "action": "item.deleted", "entity": "c1000000-0000-7000-8000-000000000002", "data": {"household": "Home", "list": "Weekly", "item": "Tomato"}},
  {"area": "lists", "action": "item.restored", "entity": "c1000000-0000-7000-8000-000000000002", "data": {"household": "Home", "list": "Weekly", "item": "Tomato"}}
]$$::jsonb, 'item.deleted and item.restored');

-- A second open onion on the list is merged into the first (7.3); its contribution follows it.
select pg_temp.push('list_items', 'c1000000-0000-7000-8000-000000000003',
  '{"list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "onion", "display_name": "Onion"}');
select pg_temp.taken();
select is(public.apply_mutations($$ [
  { "table": "list_items", "id": "c1000000-0000-7000-8000-000000000004", "hlc": "1760000920000-0000-test",
    "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "ingredient_name": "onion", "display_name": "Red onion" } },
  { "table": "list_item_contributions", "id": "c2000000-0000-7000-8000-000000000004", "hlc": "1760000920000-0001-test",
    "fields": { "list_item_id": "c1000000-0000-7000-8000-000000000004", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "source": "manual", "quantity": 1 } }
] $$) -> 0 ->> 'status', 'merged', 'the second onion is merged');
select is(pg_temp.taken(), $$[
  {"area": "lists", "action": "item.merged", "entity": "c1000000-0000-7000-8000-000000000004",
   "data": {"household": "Home", "list": "Weekly", "item": "Red onion", "into": "Onion"}},
  {"area": "lists", "action": "item.added", "entity": "c2000000-0000-7000-8000-000000000004",
   "data": {"household": "Home", "list": "Weekly", "list_id": "a1000000-0000-7000-8000-000000000001", "item": "Onion",
     "item_id": "c1000000-0000-7000-8000-000000000003", "source": "manual", "quantity": 1, "unit": null}}
]$$::jsonb, 'item.merged, and the contribution is added to the item it was merged into');

-- Meal plan ----------------------------------------------------------------------------------------------
select pg_temp.push('meal_plan_entries', 'd1000000-0000-7000-8000-000000000001',
  '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "plan_date": "2026-10-21", "meal": "dinner", "position": 1, "kind": "recipe", "recipe_id": "b1000000-0000-7000-8000-000000000001"}');
select pg_temp.push('meal_plan_entries', 'd1000000-0000-7000-8000-000000000002',
  '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "plan_date": "2026-10-22", "meal": "lunch", "position": 1, "kind": "note", "note": "Pizza night"}');
select is(pg_temp.taken(), $$[
  {"area": "plan", "action": "plan.added", "entity": "d1000000-0000-7000-8000-000000000001",
   "data": {"household": "Home", "date": "2026-10-21", "meal": "dinner", "kind": "recipe", "recipe": "Lasagne", "recipe_id": "b1000000-0000-7000-8000-000000000001"}},
  {"area": "plan", "action": "plan.added", "entity": "d1000000-0000-7000-8000-000000000002",
   "data": {"household": "Home", "date": "2026-10-22", "meal": "lunch", "kind": "note"}}
]$$::jsonb, 'plan.added, for a recipe and for a note (without its text)');

select pg_temp.push('meal_plan_entries', 'd1000000-0000-7000-8000-000000000001', '{"plan_date": "2026-10-23", "meal": "lunch"}');
select is(pg_temp.taken(), $$[{"area": "plan", "action": "plan.moved", "entity": "d1000000-0000-7000-8000-000000000001",
  "data": {"household": "Home", "from": {"date": "2026-10-21", "meal": "dinner"}, "to": {"date": "2026-10-23", "meal": "lunch"}, "recipe": "Lasagne"}}]$$::jsonb,
  'plan.moved');

select pg_temp.push('meal_plan_entries', 'd1000000-0000-7000-8000-000000000001', '{"position": 0.5}');
select is(pg_temp.taken(), $$[{"area": "plan", "action": "plan.reordered", "entity": "d1000000-0000-7000-8000-000000000001",
  "data": {"household": "Home", "date": "2026-10-23", "meal": "lunch", "recipe": "Lasagne"}}]$$::jsonb, 'plan.reordered');

select pg_temp.push('meal_plan_entries', 'd1000000-0000-7000-8000-000000000002', '{"deleted_at": "2026-10-21T10:00:00Z"}');
select pg_temp.push('meal_plan_entries', 'd1000000-0000-7000-8000-000000000002', '{"deleted_at": null}');
select is(pg_temp.taken(), $$[
  {"area": "plan", "action": "plan.removed", "entity": "d1000000-0000-7000-8000-000000000002", "data": {"household": "Home", "date": "2026-10-22", "meal": "lunch", "kind": "note"}},
  {"area": "plan", "action": "plan.restored", "entity": "d1000000-0000-7000-8000-000000000002", "data": {"household": "Home", "date": "2026-10-22", "meal": "lunch", "kind": "note"}}
]$$::jsonb, 'plan.removed and plan.restored');

-- Aisles ---------------------------------------------------------------------------------------------------
select pg_temp.push('categories', 'e1000000-0000-7000-8000-000000000001', '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Mexican"}');
select pg_temp.push('categories', 'e1000000-0000-7000-8000-000000000001', '{"name": "Tex-Mex"}');
select is(pg_temp.taken(), $$[
  {"area": "aisles", "action": "aisle.created", "entity": "e1000000-0000-7000-8000-000000000001", "data": {"household": "Home", "aisle": "Mexican"}},
  {"area": "aisles", "action": "aisle.renamed", "entity": "e1000000-0000-7000-8000-000000000001", "data": {"household": "Home", "aisle": "Tex-Mex", "from": "Mexican"}}
]$$::jsonb, 'aisle.created and aisle.renamed');

select pg_temp.push_key('household_category_overrides', '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "lime"}',
  '{"category_id": "e1000000-0000-7000-8000-000000000001"}');
select pg_temp.push_key('household_category_overrides', '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "lime"}',
  '{"category_id": null}');
select is(pg_temp.taken(), $$[
  {"area": "aisles", "action": "aisle.assigned", "entity": "lime", "data": {"household": "Home", "ingredient": "lime", "aisle": "Tex-Mex"}},
  {"area": "aisles", "action": "aisle.assigned", "entity": "lime", "data": {"household": "Home", "ingredient": "lime", "aisle": null}}
]$$::jsonb, 'aisle.assigned, and Reset to default with a null aisle');

select pg_temp.push_key('household_staples', '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "lime"}', '{"deleted_at": null}');
select pg_temp.push_key('household_staples', '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "lime"}', '{"deleted_at": "2026-10-21T10:00:00Z"}');
select pg_temp.push_key('household_staples', '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "lime"}', '{"deleted_at": null}');
select is((select jsonb_agg(jsonb_build_array(e -> 'action', e -> 'data')) from jsonb_array_elements(pg_temp.taken()) e), $$[
  ["staple.added", {"household": "Home", "ingredient": "lime"}],
  ["staple.removed", {"household": "Home", "ingredient": "lime"}],
  ["staple.added", {"household": "Home", "ingredient": "lime"}]
]$$::jsonb, 'staple.added, staple.removed, and staple.added again when restored');

delete from public.categories where id = 'e1000000-0000-7000-8000-000000000001';
select is(pg_temp.taken(), $$[{"area": "aisles", "action": "aisle.deleted", "entity": "e1000000-0000-7000-8000-000000000001",
  "data": {"household": "Home", "aisle": "Tex-Mex"}}]$$::jsonb, 'aisle.deleted');

-- Settings and devices (per user: no household) --------------------------------------------------------
update public.user_settings set default_list_id = 'a1000000-0000-7000-8000-000000000001' where user_id = '11111111-1111-1111-1111-111111111111';
select is(pg_temp.taken(), $$[{"area": "settings", "action": "settings.default_list", "entity": null, "data": {"list": "Weekly"}}]$$::jsonb,
  'settings.default_list');
select is((select household_id from private.user_activity), null, 'a per-user entry has no household');

insert into public.user_household_category_order (user_id, household_id, category_ids)
select '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', jsonb_agg(c.id order by c.default_rank)
from public.categories c where c.household_id is null;
delete from public.user_household_category_order where user_id = '11111111-1111-1111-1111-111111111111';
select is(pg_temp.taken(), $$[
  {"area": "settings", "action": "settings.aisle_order", "entity": null, "data": {"household": "Home", "removed": false}},
  {"area": "settings", "action": "settings.aisle_order", "entity": null, "data": {"household": "Home", "removed": true}}
]$$::jsonb, 'settings.aisle_order for saving and removing your own order (more in 65_household_aisle_order)');

update public.notification_settings set items_added = not items_added where user_id = '11111111-1111-1111-1111-111111111111';
select is(pg_temp.taken(), $$[{"area": "settings", "action": "settings.notifications", "entity": null, "data": {"fields": ["items_added"]}}]$$::jsonb,
  'settings.notifications names the fields');

select public.register_push_token('ExponentPushToken[abc123]', 'ios');
select public.register_push_token('ExponentPushToken[abc123]', 'ios');
select public.unregister_push_token('ExponentPushToken[abc123]');
select is(pg_temp.taken(), $$[
  {"area": "devices", "action": "device.registered", "entity": null, "data": {"platform": "ios"}},
  {"area": "devices", "action": "device.unregistered", "entity": null, "data": {"platform": "ios"}}
]$$::jsonb, 'device.registered (once for the same token) and device.unregistered, never the token');

-- Logging never fails the write --------------------------------------------------------------------------
alter table private.user_activity add constraint tmp_fail check (action <> 'list.created');
select is(pg_temp.push('lists', 'a1000000-0000-7000-8000-000000000003',
  '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Party", "position": 3}'), '{"status": "applied"}'::jsonb,
  'a write whose logging fails still applies');
select ok(exists (select 1 from public.lists where id = 'a1000000-0000-7000-8000-000000000003'), 'and the list is there');
select is(pg_temp.taken(), '[]'::jsonb, 'with no entry');
alter table private.user_activity drop constraint tmp_fail;

-- The household functions: one entry per call -----------------------------------------------------------
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select public.create_household('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Dana''s place');
select results_eq(
  $$ select user_id, household_id, area, action, entity_id, data from private.user_activity $$,
  $$ values ('44444444-4444-4444-4444-444444444444'::uuid, 'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid, 'household', 'household.created',
     'dddddddd-dddd-dddd-dddd-dddddddddddd', '{"household": "Dana''s place"}'::jsonb) $$,
  'create_household logs one household.created, as the caller');
select pg_temp.taken();

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.rename_household('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Our home');
select is(pg_temp.taken(), $$[{"area": "household", "action": "household.renamed", "entity": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  "data": {"household": "Our home", "from": "Home"}}]$$::jsonb, 'rename_household logs household.renamed');
select public.rename_household('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Our home');
select is(pg_temp.taken(), '[]'::jsonb, 'a rename to the same name writes nothing and logs nothing');

select public.set_combine_languages('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);
select is(pg_temp.taken(), $$[{"area": "household", "action": "household.combine_languages", "entity": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  "data": {"household": "Our home", "on": true}}]$$::jsonb, 'set_combine_languages logs household.combine_languages');

select public.create_invite('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Eve@Test.local');
select is((select jsonb_agg(e) from jsonb_array_elements(pg_temp.taken()) e), (
  select jsonb_build_array(jsonb_build_object('area', 'household', 'action', 'invite.created', 'entity', i.id::text,
    'data', jsonb_build_object('household', 'Our home', 'invite_id', i.id)))
  from public.household_invites i where i.invited_email = 'eve@test.local'),
  'create_invite logs invite.created with the invite''s id');

set local role authenticated;
select pg_temp.as_user('55555555-5555-5555-5555-555555555555', 'eve@test.local');
select public.decline_invite((select id from public.my_invites() limit 1));
reset role;
select is((select jsonb_agg(e) from jsonb_array_elements(pg_temp.taken()) e), (
  select jsonb_build_array(jsonb_build_object('area', 'household', 'action', 'invite.declined', 'entity', i.id::text,
    'data', jsonb_build_object('household', 'Our home', 'invite_id', i.id)))
  from public.household_invites i where i.invited_email = 'eve@test.local'),
  'decline_invite logs invite.declined');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.create_invite('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'eve@test.local');
select public.create_invite('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select is((select count(*)::int from private.user_activity where action = 'invite.created'), 2, 'two more invites');
select ok(not exists (select 1 from private.user_activity where data::text ilike '%@%' or entity_id ilike '%@%'),
  'no entry holds an email');
select pg_temp.taken();
select public.revoke_invite((select id from public.household_invites where invited_email is null));
select is((select jsonb_agg(e) from jsonb_array_elements(pg_temp.taken()) e), (
  select jsonb_build_array(jsonb_build_object('area', 'household', 'action', 'invite.revoked', 'entity', i.id::text,
    'data', jsonb_build_object('household', 'Our home', 'invite_id', i.id)))
  from public.household_invites i where i.invited_email is null),
  'revoke_invite logs invite.revoked');

select pg_temp.as_user('55555555-5555-5555-5555-555555555555', 'eve@test.local');
select public.accept_invite_by_id((select id from public.household_invites where invited_email = 'eve@test.local' and declined_at is null));
select results_eq(
  $$ select user_id, household_id, action, data - 'invite_id' from private.user_activity $$,
  $$ values ('55555555-5555-5555-5555-555555555555'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'invite.accepted', '{"household": "Our home"}'::jsonb) $$,
  'accept_invite_by_id logs one invite.accepted, as the person accepting');
select pg_temp.taken();

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select public.set_member_role('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'owner');
select is(pg_temp.taken(), $$[{"area": "household", "action": "member.role_changed", "entity": "22222222-2222-2222-2222-222222222222",
  "data": {"household": "Our home", "member": "Sam Lee", "member_id": "22222222-2222-2222-2222-222222222222", "role": "owner"}}]$$::jsonb,
  'set_member_role logs member.role_changed, with the member''s full name');

select public.remove_member('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333');
select is(pg_temp.taken(), $$[{"area": "household", "action": "member.removed", "entity": "33333333-3333-3333-3333-333333333333",
  "data": {"household": "Our home", "member": "pat", "member_id": "33333333-3333-3333-3333-333333333333", "role": "member"}}]$$::jsonb,
  'remove_member logs one member.removed (a member with no last name: the first name), not the rows it writes (Pat''s new personal household)');
select ok(exists (select 1 from public.household_members where user_id = '33333333-3333-3333-3333-333333333333'),
  'Pat was rehomed');

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select public.leave_household('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select is(pg_temp.taken(), $$[{"area": "household", "action": "household.left", "entity": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  "data": {"household": "Our home"}}]$$::jsonb, 'leave_household logs one household.left');

select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select public.delete_household('dddddddd-dddd-dddd-dddd-dddddddddddd');
select is(pg_temp.taken(), $$[{"area": "household", "action": "household.deleted", "entity": "dddddddd-dddd-dddd-dddd-dddddddddddd",
  "data": {"household": "Dana's place"}}]$$::jsonb, 'delete_household logs one household.deleted, not its cascade or the new household');

select is(current_setting('app.activity_action', true), '', 'each function clears its action when it''s done');
select pg_temp.push('lists', 'a1000000-0000-7000-8000-000000000004',
  jsonb_build_object('household_id', (select household_id from public.household_members where user_id = '44444444-4444-4444-4444-444444444444'),
    'name', 'After', 'position', 1));
select is((select jsonb_agg(e -> 'action') from jsonb_array_elements(pg_temp.taken()) e), '["list.created"]'::jsonb,
  'so a later write in the same transaction is logged again');

-- Deleting an account ------------------------------------------------------------------------------------
-- Pat writes something, Alex's history has entries about Pat, and someone else.
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select pg_temp.push('lists', 'a1000000-0000-7000-8000-000000000005',
  jsonb_build_object('household_id', (select household_id from public.household_members where user_id = '33333333-3333-3333-3333-333333333333'),
    'name', 'Pat''s', 'position', 1));
insert into private.user_activity (user_id, household_id, area, action, entity_id, data) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'household', 'member.removed', '33333333-3333-3333-3333-333333333333',
   '{"household": "Our home", "member": "pat", "member_id": "33333333-3333-3333-3333-333333333333", "role": "member"}'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'household', 'member.role_changed', '33333333-3333-3333-3333-333333333333',
   '{"household": "Our home", "member": "pat", "member_id": "33333333-3333-3333-3333-333333333333", "role": "owner"}'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'household', 'member.removed', '22222222-2222-2222-2222-222222222222',
   '{"household": "Our home", "member": "sam", "member_id": "22222222-2222-2222-2222-222222222222", "role": "member"}');
select is((select count(*)::int from private.user_activity where user_id = '33333333-3333-3333-3333-333333333333'), 1, 'Pat has an entry');

select public.delete_account();
select is((select count(*)::int from private.user_activity where user_id = '33333333-3333-3333-3333-333333333333'), 0,
  'delete_account leaves no entries of the user''s, its own deletes included');
select results_eq(
  $$ select action, data from private.user_activity where entity_id = '33333333-3333-3333-3333-333333333333' order by id $$,
  $$ values ('member.removed', '{"household": "Our home", "role": "member"}'::jsonb),
            ('member.role_changed', '{"household": "Our home", "role": "owner"}'::jsonb) $$,
  'and scrubs them from other users'' member entries');
select is((select data from private.user_activity where entity_id = '22222222-2222-2222-2222-222222222222'),
  '{"household": "Our home", "member": "sam", "member_id": "22222222-2222-2222-2222-222222222222", "role": "member"}'::jsonb,
  'another member''s entry is untouched');
select is(current_setting('app.activity_action', true), '', 'delete_account clears its suppression');

-- admin.delete_user (from the dashboard, no auth.uid()) does the same.
select set_config('request.jwt.claims', '', true);
insert into private.user_activity (user_id, area, action, data) values
  ('22222222-2222-2222-2222-222222222222', 'settings', 'settings.aisle_order', '{}');
select admin.delete_user('22222222-2222-2222-2222-222222222222', 'asked by email');
select is((select count(*)::int from private.user_activity where user_id = '22222222-2222-2222-2222-222222222222'), 0,
  'admin.delete_user deletes the user''s entries');
select is((select data from private.user_activity where entity_id = '22222222-2222-2222-2222-222222222222'),
  '{"household": "Our home", "role": "member"}'::jsonb, 'and scrubs them from others''');

-- Retention ---------------------------------------------------------------------------------------------------
delete from private.user_activity;
insert into private.user_activity (user_id, area, action, created_at) values
  ('11111111-1111-1111-1111-111111111111', 'settings', 'old', now() - interval '91 days'),
  ('11111111-1111-1111-1111-111111111111', 'settings', 'recent', now() - interval '89 days');
select is((select count(*)::int from cron.job where jobname = 'user-activity-retention'), 1, 'the retention job is scheduled');
select is((select schedule from cron.job where jobname = 'user-activity-retention'), '47 3 * * *', 'daily');
do $$ begin execute (select command from cron.job where jobname = 'user-activity-retention'); end $$;
select is((select array_agg(action) from private.user_activity), array['recent'], 'it deletes entries older than 90 days');

select * from finish();
rollback;
