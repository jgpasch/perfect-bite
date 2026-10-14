-- Shared aisle across a family (spec 4.15, 4.3.2): private.move_overrides_to_family_keys (run once
-- by the family_overrides migration) moves household overrides on linked keys to their family key,
-- keeping the newest when a household has one on both twins, and leaves unlinked pairs alone.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

-- Fixtures (as postgres) ---------------------------------------------------------
insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'B');

-- English targets first, then the names that link to them. "test tomate" and "test tomato" stay
-- unlinked (spec 4.15).
insert into public.ingredients (normalized_name, display_name, status, lang) values
  ('test milk', 'milk', 'categorized', 'en'),
  ('test bread', 'bread', 'categorized', 'en'),
  ('test tomato', 'tomato', 'categorized', 'en'),
  ('test tomate', 'tomate', 'categorized', 'es');
insert into public.ingredients (normalized_name, display_name, status, lang, same_as, linked_by) values
  ('test leche', 'leche', 'categorized', 'es', 'test milk', 'seed'),
  ('test pan', 'pan', 'categorized', 'es', 'test bread', 'seed');

-- A: leche (newer) and milk (older) both moved; pan alone; tomate and tomato each their own.
-- B: milk (newer) and leche (older); leche alone in neither. B's leche reset to the default.
insert into public.household_category_overrides (household_id, ingredient_name, category_id, field_clock)
select h::uuid, n, (select id from public.categories where slug = s), jsonb_build_object('category_id', c)
from (values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test leche', 'deli', '1760000000009-0000-a'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test milk', 'frozen', '1760000000001-0000-a'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test pan', 'deli', '1760000000002-0000-a'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test tomate', 'canned-jarred', '1760000000003-0000-a'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test tomato', 'frozen', '1760000000004-0000-a'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'test milk', 'frozen', '1760000000009-0000-b'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'test leche', 'deli', '1760000000001-0000-b'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'test pan', null, '1760000000005-0000-b')
) as v (h, n, s, c);

select private.move_overrides_to_family_keys();

select results_eq(
  $$ select c.slug, o.field_clock ->> 'category_id' from public.household_category_overrides o
     join public.categories c on c.id = o.category_id
     where o.household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and o.ingredient_name = 'test milk' $$,
  $$ values ('deli', '1760000000009-0000-a') $$,
  'a newer override on the linked name wins over its target''s');
select results_eq(
  $$ select c.slug from public.household_category_overrides o
     join public.categories c on c.id = o.category_id
     where o.household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' and o.ingredient_name = 'test milk' $$,
  $$ values ('frozen') $$,
  'a newer override on the target wins over the linked name''s');
select results_eq(
  $$ select o.household_id::text, c.slug from public.household_category_overrides o
     left join public.categories c on c.id = o.category_id
     where o.ingredient_name = 'test bread' order by 1 $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'deli'), ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', null) $$,
  'an override on a linked name alone moves to its family key, a reset (null) included');
select is_empty(
  $$ select 1 from public.household_category_overrides where ingredient_name in ('test leche', 'test pan') $$,
  'no override stays on a linked key');
select results_eq(
  $$ select o.ingredient_name, c.slug from public.household_category_overrides o
     join public.categories c on c.id = o.category_id
     where o.ingredient_name in ('test tomate', 'test tomato') order by 1 $$,
  $$ values ('test tomate', 'canned-jarred'), ('test tomato', 'frozen') $$,
  'an unlinked pair keeps two overrides');
select lives_ok(
  $$ select private.move_overrides_to_family_keys() $$,
  'running it again changes nothing and doesn''t fail');

select * from finish();
rollback;
