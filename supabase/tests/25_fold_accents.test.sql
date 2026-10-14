-- Accent folding (spec 4.15): private.fold_accents matches the app's foldAccents, and
-- private.fold_ingredient_keys (run once by the fold_accents migration) merges accented keys into
-- their folded keys in every table that holds one.
begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

-- fold_accents -------------------------------------------------------------------
select is(private.fold_accents('limón'), 'limon', 'folds an acute accent');
select is(private.fold_accents('jalapeño'), 'jalapeno', 'folds a tilde');
select is(private.fold_accents('crème fraîche'), 'creme fraiche', 'folds grave and circumflex');
select is(private.fold_accents('lim' || 'o' || U&'\0301' || 'n'), 'limon', 'folds a decomposed accent');
select is(private.fold_accents('straße smørrebrød'), 'straße smørrebrød', 'keeps letters with no decomposition');
select is(private.fold_accents('chicken thigh'), 'chicken thigh', 'leaves plain text alone');

-- Fixtures (as postgres) ---------------------------------------------------------
-- Households A and B. "test limón" is categorized (by admin) and "test limon" pending; the seed's
-- "test jalapeño" and a model's "test jalapeno"; "test piña" has no plain twin.
insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'B');

insert into public.ingredients
  (normalized_name, display_name, default_category_id, status, is_grocery_item, categorized_by, default_unit, household_count)
select n, d, (select id from public.categories where slug = s), st, g, b, u, hc
from (values
  ('test limón', 'Limón', 'produce', 'categorized', true, 'admin', 'lb', 1),
  ('test limon', 'limon', null, 'pending', null, null, null, 2),
  ('test jalapeño', 'Jalapeño', 'produce', 'categorized', true, 'seed', 'count', 1000),
  ('test jalapeno', 'jalapeno', 'canned-jarred', 'categorized', true, 'model-x', 'can', 1),
  ('test piña', 'Piña', 'produce', 'categorized', true, 'model-x', 'count', 1)
) as v (n, d, s, st, g, b, u, hc);

insert into public.ingredient_households (ingredient_name, household_id) values
  ('test limón', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('test limon', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('test limon', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  ('test jalapeño', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('test jalapeno', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  ('test piña', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

insert into public.lists (id, household_id, name, position) values
  ('a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Groceries', 1);
-- Two open items that fold to one key on one list (the older one stays), and a checked one.
insert into public.list_items (id, list_id, household_id, ingredient_name, display_name, checked_at, created_at) values
  ('a2000000-0000-7000-8000-000000000001', 'a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test limon', 'limones', null, '2026-10-01T10:00:00Z'),
  ('a2000000-0000-7000-8000-000000000002', 'a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test limón', 'Limón', null, '2026-10-02T10:00:00Z'),
  ('a2000000-0000-7000-8000-000000000003', 'a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test piña', 'piña', '2026-10-03T10:00:00Z', '2026-10-01T10:00:00Z');
insert into public.list_item_contributions (id, list_item_id, household_id, quantity) values
  ('a3000000-0000-7000-8000-000000000001', 'a2000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 2),
  ('a3000000-0000-7000-8000-000000000002', 'a2000000-0000-7000-8000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 3);

insert into public.recipes (id, household_id, name) values
  ('a4000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Salsa');
insert into public.recipe_ingredients (id, recipe_id, household_id, ingredient_name, display_name, position) values
  ('a5000000-0000-7000-8000-000000000001', 'a4000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test jalapeño', 'jalapeños', 1);

-- Usage: two rows that fold to one in household A (one hidden), and one in B alone.
insert into public.ingredient_usage (household_id, ingredient_name, display_name, use_count, last_used_at, hidden_at, field_clock) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test limón', 'Limón', 2, '2026-10-02T10:00:00Z', '2026-10-05T10:00:00Z', '{"hidden_at": "1760000000005-0000-a"}'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test limon', 'limones', 3, '2026-10-04T10:00:00Z', null, '{"display_name": "1760000000004-0000-a"}'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'test piña', 'piñas', 1, '2026-10-01T10:00:00Z', null, '{}');
insert into public.ingredient_unit_usage (household_id, ingredient_name, unit_key, use_count, last_used_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test limón', 'count', 1, '2026-10-02T10:00:00Z'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test limón', 'lb', 1, '2026-10-02T10:00:00Z'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test limon', 'count', 2, '2026-10-04T10:00:00Z');

-- Overrides and staples: two rows that fold to one in household A; the newer HLC wins.
insert into public.household_category_overrides (household_id, ingredient_name, category_id, field_clock)
select 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', n, (select id from public.categories where slug = s), jsonb_build_object('category_id', h)
from (values ('test limón', 'deli', '1760000000009-0000-a'), ('test limon', 'frozen', '1760000000001-0000-a')) as v (n, s, h);
insert into public.household_staples (household_id, ingredient_name, deleted_at, field_clock) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test piña', null, '{"deleted_at": "1760000000002-0000-a"}'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test pina', '2026-10-01T10:00:00Z', '{"deleted_at": "1760000000001-0000-a"}');

select private.fold_ingredient_keys();

-- Catalog --------------------------------------------------------------------------
select results_eq(
  $$ select i.normalized_name, i.display_name, c.slug, i.status, i.categorized_by, i.default_unit, i.household_count
     from public.ingredients i left join public.categories c on c.id = i.default_category_id
     where i.normalized_name like 'test %' order by 1 $$,
  $$ values
    ('test jalapeno', 'Jalapeño', 'produce', 'categorized', 'seed', 'count', 1001),
    ('test limon', 'Limón', 'produce', 'categorized', 'admin', 'lb', 2),
    ('test pina', 'Piña', 'produce', 'categorized', 'model-x', 'count', 1) $$,
  'each folded key keeps the categorized row (the seed''s first), with the households the others add');
select results_eq(
  $$ select ingredient_name, household_id::text from public.ingredient_households where ingredient_name like 'test %' order by 1, 2 $$,
  $$ values
    ('test jalapeno', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), ('test jalapeno', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
    ('test limon', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), ('test limon', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
    ('test pina', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
  'households that used either spelling are recorded under the folded key');
select is((select count(*)::int from public.ingredients where private.fold_accents(normalized_name) <> normalized_name), 0,
  'no accented key is left in the catalog');

-- List items, contributions, recipe ingredients ---------------------------------------
select results_eq(
  $$ select id::text, ingredient_name, display_name, deleted_at is not null, merged_into::text from public.list_items order by id $$,
  $$ values
    ('a2000000-0000-7000-8000-000000000001', 'test limon', 'limones', false, null::text),
    ('a2000000-0000-7000-8000-000000000002', 'test limon', 'Limón', true, 'a2000000-0000-7000-8000-000000000001'),
    ('a2000000-0000-7000-8000-000000000003', 'test pina', 'piña', false, null::text) $$,
  'keys are rewritten, display names kept, and the newer of two open items is merged into the older');
select results_eq(
  $$ select id::text, list_item_id::text from public.list_item_contributions order by id $$,
  $$ values
    ('a3000000-0000-7000-8000-000000000001', 'a2000000-0000-7000-8000-000000000001'),
    ('a3000000-0000-7000-8000-000000000002', 'a2000000-0000-7000-8000-000000000001') $$,
  'the merged item''s contributions move to the item that stays');
select results_eq(
  $$ select ingredient_name, display_name from public.recipe_ingredients $$,
  $$ values ('test jalapeno', 'jalapeños') $$,
  'recipe ingredients get the folded key and keep their display name');

-- Usage ------------------------------------------------------------------------------
select results_eq(
  $$ select household_id::text, ingredient_name, display_name, use_count, last_used_at, hidden_at, field_clock
     from public.ingredient_usage order by 1, 2 $$,
  $$ values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test limon', 'limones', 5, '2026-10-04T10:00:00Z'::timestamptz, null::timestamptz, '{"display_name": "1760000000004-0000-a"}'::jsonb),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'test pina', 'piñas', 1, '2026-10-01T10:00:00Z'::timestamptz, null::timestamptz, '{}'::jsonb) $$,
  'usage sums counts and keeps the latest use; a row is hidden only if every merged row was');
select results_eq(
  $$ select ingredient_name, unit_key, use_count, last_used_at from public.ingredient_unit_usage order by 1, 2 $$,
  $$ values
    ('test limon', 'count', 3, '2026-10-04T10:00:00Z'::timestamptz),
    ('test limon', 'lb', 1, '2026-10-02T10:00:00Z'::timestamptz) $$,
  'unit usage sums counts per unit with the latest last_used_at');

-- Overrides and staples -----------------------------------------------------------------
select results_eq(
  $$ select o.ingredient_name, c.slug, o.field_clock ->> 'category_id'
     from public.household_category_overrides o join public.categories c on c.id = o.category_id $$,
  $$ values ('test limon', 'deli', '1760000000009-0000-a') $$,
  'of two overrides that fold to one, the newest wins');
select results_eq(
  $$ select ingredient_name, deleted_at from public.household_staples $$,
  $$ values ('test pina', null::timestamptz) $$,
  'of two staples that fold to one, the newest wins');

-- Running it again changes nothing ---------------------------------------------------------
create temp table before_rerun as
  select 'usage' as t, ingredient_name, use_count::text as v from public.ingredient_usage
  union all select 'items', ingredient_name, id::text from public.list_items
  union all select 'catalog', normalized_name, household_count::text from public.ingredients where normalized_name like 'test %';
select private.fold_ingredient_keys();
select bag_eq(
  $$ select 'usage' as t, ingredient_name, use_count::text from public.ingredient_usage
     union all select 'items', ingredient_name, id::text from public.list_items
     union all select 'catalog', normalized_name, household_count::text from public.ingredients where normalized_name like 'test %' $$,
  $$ select * from before_rerun $$,
  'a second run is a no-op');

-- A key the catalog doesn't hold (usage needs no catalog row) still folds.
insert into public.ingredient_usage (household_id, ingredient_name, display_name, use_count, last_used_at) values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'test café', 'café', 4, '2026-10-06T10:00:00Z');
select private.fold_ingredient_keys();
select results_eq(
  $$ select ingredient_name, display_name, use_count from public.ingredient_usage where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' order by 1 $$,
  $$ values ('test cafe', 'café', 4), ('test pina', 'piñas', 1) $$,
  'a usage row with no catalog row is renamed');

-- The live data has no accented keys after the migration.
select is((select count(*)::int from public.ingredients where normalized_name ~ '[À-ÿ]'), 0,
  'the seed has no accented keys');

-- No client may call the merge.
select ok(not has_function_privilege('authenticated', 'private.fold_ingredient_keys()', 'execute'),
  'authenticated can''t run the merge');
select ok(not has_function_privilege('anon', 'private.fold_ingredient_keys()', 'execute'),
  'anon can''t run the merge');

select * from finish();
rollback;
