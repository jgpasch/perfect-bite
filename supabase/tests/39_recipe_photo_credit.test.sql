-- recipes.photo_credit is gone (spec 4.5, 5; 20261109120000_drop_photo_search.sql): the column and
-- its check, and apply_mutations refuses a mutation that still names it, as app builds from before
-- the change send with every photo change.
begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex owns household A, with recipe N (which has no photo).
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1);
insert into public.recipes (id, household_id, name, photo_path) values
  ('a3000000-0000-7000-8000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tacos', null);

-- The column ------------------------------------------------------------------
select hasnt_column('public', 'recipes', 'photo_credit', 'recipes has no photo_credit');
select is(
  (select count(*)::int from pg_catalog.pg_constraint where conname = 'recipes_photo_credit_shape'),
  0, 'recipes_photo_credit_shape is gone');

-- Through apply_mutations ----------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a3000000-0000-7000-8000-000000000002", "hlc": "1760000000001-0000-alex",
    "fields": { "photo_path": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/c0000000-0000-7000-8000-000000000002.jpg",
                "photo_credit": null } }] $$),
  '[{"status": "rejected", "code": "22023", "message": "field photo_credit can''t be set on recipes"}]'::jsonb,
  'an old build''s photo change, with its null credit, is rejected');
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a3000000-0000-7000-8000-000000000002", "hlc": "1760000000001-0001-alex",
    "fields": { "photo_path": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/c0000000-0000-7000-8000-000000000002.jpg" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'a photo change without a credit applies');
reset role;

select * from finish();
rollback;
