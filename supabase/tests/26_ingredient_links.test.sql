-- Linked ingredients and the Spanish seed (spec 4.15, 5).
begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

-- Columns ------------------------------------------------------------------------
select has_column('public', 'ingredients', 'lang', 'ingredients has lang');
select has_column('public', 'ingredients', 'same_as', 'ingredients has same_as');
select has_column('public', 'ingredients', 'linked_by', 'ingredients has linked_by');
select fk_ok('public', 'ingredients', 'same_as', 'public', 'ingredients', 'normalized_name');

-- The seeds -----------------------------------------------------------------------
select results_eq(
  $$ select lang, same_as, linked_by from public.ingredients where normalized_name = 'milk' $$,
  $$ values ('en'::text, null::text, null::text) $$,
  'an English seed name is en and unlinked');
select is((select count(*)::int from public.ingredients where categorized_by = 'seed' and lang is null), 0,
  'every seed name has a language');
select results_eq(
  $$ select i.lang, i.same_as, i.linked_by, c.slug, i.default_unit, i.display_name
     from public.ingredients i join public.categories c on c.id = i.default_category_id
     where i.normalized_name = 'leche' $$,
  $$ values ('es'::text, 'milk'::text, 'seed'::text, 'dairy-eggs'::text, 'gal'::text, 'leche'::text) $$,
  'leche links to milk and takes its aisle and unit');
select results_eq(
  $$ select normalized_name, same_as from public.ingredients where normalized_name in ('jitomate', 'huevo', 'limon amarillo') order by 1 $$,
  $$ values ('huevo'::text, 'egg'::text), ('jitomate', 'tomato'), ('limon amarillo', 'lemon') $$,
  'Spanish names link to the English key they mean');
select results_eq(
  $$ select normalized_name, lang, same_as from public.ingredients
     where normalized_name in ('tomate', 'chile', 'limon', 'tomate verde', 'flor de jamaica') order by 1 $$,
  $$ values ('chile'::text, 'es'::text, null::text), ('flor de jamaica', 'es', null), ('limon', 'es', null),
            ('tomate', 'es', null), ('tomate verde', 'es', null) $$,
  'ambiguous and Mexico-only names stay unlinked');
select results_eq(
  $$ select lang, same_as from public.ingredients where normalized_name in ('crema', 'queso fresco') order by normalized_name $$,
  $$ values ('en'::text, null::text), ('en', null) $$,
  'Spanish words the English seed has stay its unlinked rows');
select is((select count(*)::int from public.ingredients t join public.ingredients s on s.same_as = t.normalized_name
           where t.same_as is not null), 0, 'no seed link points at a linked name');

-- Constraints ----------------------------------------------------------------------
insert into public.ingredients (normalized_name, display_name) values ('pepino test', 'pepino test'), ('cucumber test', 'cucumber test'),
  ('chain test', 'chain test');

select throws_ok($$ update public.ingredients set same_as = 'pepino test', linked_by = 'admin' where normalized_name = 'pepino test' $$,
  '23514', null, 'a name can''t link to itself');
select throws_ok($$ update public.ingredients set same_as = 'cucumber test' where normalized_name = 'pepino test' $$,
  '23514', null, 'a link needs linked_by');
select throws_ok($$ update public.ingredients set linked_by = 'admin' where normalized_name = 'pepino test' $$,
  '23514', null, 'linked_by needs a link');
select throws_ok($$ update public.ingredients set lang = 'fr' where normalized_name = 'pepino test' $$,
  '23514', null, 'lang is en or es');
select throws_ok($$ update public.ingredients set same_as = 'no such name', linked_by = 'admin' where normalized_name = 'pepino test' $$,
  '23503', null, 'same_as must be a catalog name');

select lives_ok($$ update public.ingredients set same_as = 'cucumber test', linked_by = 'gemini-test', lang = 'es'
  where normalized_name = 'pepino test' $$, 'a name links to an unlinked one');
select throws_ok($$ update public.ingredients set same_as = 'pepino test', linked_by = 'admin' where normalized_name = 'chain test' $$,
  '23514', null, 'a link can''t point at a linked name');
select throws_ok($$ update public.ingredients set same_as = 'chain test', linked_by = 'admin' where normalized_name = 'cucumber test' $$,
  '23514', null, 'a link target can''t gain a link of its own');
select throws_ok($$ insert into public.ingredients (normalized_name, display_name, same_as, linked_by)
  values ('pepinillo test', 'pepinillo test', 'pepino test', 'admin') $$,
  '23514', null, 'a new row can''t link to a linked name');
select lives_ok($$ update public.ingredients set same_as = null, linked_by = null where normalized_name = 'pepino test' $$,
  'a link can be cleared');
select lives_ok($$ update public.ingredients set same_as = 'pepino test', linked_by = 'admin' where normalized_name = 'chain test' $$,
  'once cleared, the name can be a target');

select * from finish();
rollback;
