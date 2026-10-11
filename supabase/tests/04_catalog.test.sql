-- Catalog and per-user preferences (spec 5, 6.2).
begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

-- Fixtures (as postgres) ------------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated');

insert into public.categories (id, name, owner_user_id) values
  ('cccccccc-0000-7000-8000-000000000002', 'Sam''s aisle', '22222222-2222-2222-2222-222222222222');
insert into public.user_category_order (user_id, category_id, position) values
  ('22222222-2222-2222-2222-222222222222', '019a4c10-0000-7000-8000-00000000ca01', 1);
insert into public.user_category_overrides (user_id, ingredient_name, category_id) values
  ('22222222-2222-2222-2222-222222222222', 'milk', '019a4c10-0000-7000-8000-00000000ca20');

-- Seed ------------------------------------------------------------------------
select results_eq($$ select count(*)::int from public.categories where owner_user_id is null $$,
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

select lives_ok($$ insert into public.categories (id, name, owner_user_id) values ('cccccccc-0000-7000-8000-000000000001', 'Costco run', '11111111-1111-1111-1111-111111111111') $$,
  'Alex creates a custom category');
select throws_ok($$ insert into public.categories (id, name, owner_user_id) values ('cccccccc-0000-7000-8000-000000000003', 'Sneaky', '22222222-2222-2222-2222-222222222222') $$,
  '42501', null, 'Alex can''t create a category for Sam');
select throws_ok($$ insert into public.categories (id, slug, name, owner_user_id) values ('cccccccc-0000-7000-8000-000000000004', 'fake', 'Fake', '11111111-1111-1111-1111-111111111111') $$,
  '42501', null, 'clients can''t set a slug');
update public.categories set name = 'Hacked' where id = '019a4c10-0000-7000-8000-00000000ca01';
select results_eq($$ select name from public.categories where id = '019a4c10-0000-7000-8000-00000000ca01' $$,
  $$ values ('Produce') $$, 'system categories can''t be renamed');

select lives_ok($$ insert into public.user_category_order (user_id, category_id, position) values ('11111111-1111-1111-1111-111111111111', '019a4c10-0000-7000-8000-00000000ca02', 1) $$,
  'Alex orders a category');
select lives_ok($$ insert into public.user_category_overrides (user_id, ingredient_name, category_id) values ('11111111-1111-1111-1111-111111111111', 'banana', 'cccccccc-0000-7000-8000-000000000001') $$,
  'Alex overrides an ingredient''s category');
select results_eq($$ select (select count(*)::int from public.user_category_order), (select count(*)::int from public.user_category_overrides) $$,
  $$ values (1, 1) $$, 'Alex sees only their own order and overrides');
select throws_ok($$ insert into public.user_category_overrides (user_id, ingredient_name, category_id) values ('22222222-2222-2222-2222-222222222222', 'banana', '019a4c10-0000-7000-8000-00000000ca01') $$,
  '42501', null, 'Alex can''t write Sam''s overrides');

select * from finish();
rollback;
