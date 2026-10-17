-- A stock photo's credit on a recipe (spec 4.5, 5): recipes.photo_credit and its check
-- (recipes_photo_credit_shape), directly and through apply_mutations.
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex owns household A, with recipe R (which has an own photo) and recipe N (which has none).
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1);
insert into public.recipes (id, household_id, name, photo_path) values
  ('a3000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Blueberry bread',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000001.jpg'),
  ('a3000000-0000-7000-8000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tacos', null);

-- The column ------------------------------------------------------------------
select col_type_is('public', 'recipes', 'photo_credit', 'jsonb', 'photo_credit is jsonb');
select is(
  (select photo_credit from public.recipes where id = 'a3000000-0000-7000-8000-000000000001'),
  null, 'a recipe has no credit to start with');

-- A valid credit --------------------------------------------------------------
select lives_ok(
  $$ update public.recipes set photo_credit = '{"provider": "pexels", "author": "Jane Doe",
       "authorUrl": "https://www.pexels.com/@jane", "pageUrl": "https://www.pexels.com/photo/bread-123/"}'
     where id = 'a3000000-0000-7000-8000-000000000001' $$,
  'a valid credit on a recipe with an own photo saves');
select is(
  (select photo_credit ->> 'author' from public.recipes where id = 'a3000000-0000-7000-8000-000000000001'),
  'Jane Doe', 'the credit is stored');
select lives_ok(
  $$ update public.recipes set photo_credit = jsonb_build_object('provider', 'pexels', 'author', repeat('a', 200),
       'authorUrl', 'https://' || repeat('a', 2040), 'pageUrl', 'https://' || repeat('b', 2040))
     where id = 'a3000000-0000-7000-8000-000000000001' $$,
  'a 200-character author and 2048-character URLs save');
select lives_ok(
  $$ update public.recipes set photo_credit = null where id = 'a3000000-0000-7000-8000-000000000001' $$,
  'the credit can be cleared');
select lives_ok(
  $$ update public.recipes set photo_credit = '{"provider": "pexels", "author": "Jane Doe",
       "authorUrl": "https://www.pexels.com/@jane", "pageUrl": "https://www.pexels.com/photo/bread-123/"}'
     where id = 'a3000000-0000-7000-8000-000000000001' $$,
  'the credit can be set again');
select lives_ok(
  $$ update public.recipes set photo_path = null, photo_credit = null where id = 'a3000000-0000-7000-8000-000000000001' $$,
  'clearing the photo and its credit together saves');
update public.recipes
  set photo_path = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000001.jpg'
  where id = 'a3000000-0000-7000-8000-000000000001';

-- Refused ---------------------------------------------------------------------
select throws_ok(
  $$ update public.recipes set photo_credit = '{"provider": "unsplash", "author": "Jane Doe",
       "authorUrl": "https://www.pexels.com/@jane", "pageUrl": "https://www.pexels.com/photo/bread-123/"}'
     where id = 'a3000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a provider other than pexels is refused');
select throws_ok(
  $$ update public.recipes set photo_credit = '{"provider": "pexels", "author": "Jane Doe",
       "authorUrl": "https://www.pexels.com/@jane"}'
     where id = 'a3000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a missing key is refused');
select throws_ok(
  $$ update public.recipes set photo_credit = '{"provider": "pexels", "author": "Jane Doe",
       "authorUrl": "https://www.pexels.com/@jane", "pageUrl": "https://www.pexels.com/photo/bread-123/", "alt": "Bread"}'
     where id = 'a3000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'an extra key is refused');
select throws_ok(
  $$ update public.recipes set photo_credit = '{"provider": "pexels", "author": "Jane Doe",
       "authorUrl": "http://www.pexels.com/@jane", "pageUrl": "https://www.pexels.com/photo/bread-123/"}'
     where id = 'a3000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'an http:// author URL is refused');
select throws_ok(
  $$ update public.recipes set photo_credit = '{"provider": "pexels", "author": "Jane Doe",
       "authorUrl": "https://www.pexels.com/@jane", "pageUrl": "http://www.pexels.com/photo/bread-123/"}'
     where id = 'a3000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'an http:// page URL is refused');
select throws_ok(
  $$ update public.recipes set photo_credit = '{"provider": "pexels", "author": "",
       "authorUrl": "https://www.pexels.com/@jane", "pageUrl": "https://www.pexels.com/photo/bread-123/"}'
     where id = 'a3000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'an empty author is refused');
select throws_ok(
  $$ update public.recipes set photo_credit = jsonb_build_object('provider', 'pexels', 'author', repeat('a', 201),
       'authorUrl', 'https://www.pexels.com/@jane', 'pageUrl', 'https://www.pexels.com/photo/bread-123/')
     where id = 'a3000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a 201-character author is refused');
select throws_ok(
  $$ update public.recipes set photo_credit = jsonb_build_object('provider', 'pexels', 'author', 'Jane Doe',
       'authorUrl', 'https://www.pexels.com/@jane', 'pageUrl', 'https://' || repeat('b', 2041))
     where id = 'a3000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a URL over 2048 characters is refused');
select throws_ok(
  $$ update public.recipes set photo_credit = '{"provider": "pexels", "author": 42,
       "authorUrl": "https://www.pexels.com/@jane", "pageUrl": "https://www.pexels.com/photo/bread-123/"}'
     where id = 'a3000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a non-string author is refused');
select throws_ok(
  $$ update public.recipes set photo_credit = '["pexels"]' where id = 'a3000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a non-object credit is refused');
select throws_ok(
  $$ update public.recipes set photo_credit = '{"provider": "pexels", "author": "Jane Doe",
       "authorUrl": "https://www.pexels.com/@jane", "pageUrl": "https://www.pexels.com/photo/bread-123/"}'
     where id = 'a3000000-0000-7000-8000-000000000002' $$,
  '23514', null, 'a credit without a photo_path is refused');
update public.recipes set photo_credit = '{"provider": "pexels", "author": "Jane Doe",
  "authorUrl": "https://www.pexels.com/@jane", "pageUrl": "https://www.pexels.com/photo/bread-123/"}'
  where id = 'a3000000-0000-7000-8000-000000000001';
select throws_ok(
  $$ update public.recipes set photo_path = null where id = 'a3000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'clearing the photo but not its credit is refused');

-- Through apply_mutations, as the app writes it: the credit with the photo, one clock.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a3000000-0000-7000-8000-000000000002", "hlc": "1760000000001-0000-alex",
    "fields": { "photo_path": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/c0000000-0000-7000-8000-000000000002.jpg",
                "photo_credit": { "provider": "pexels", "author": "Sam Lee", "authorUrl": "https://www.pexels.com/@sam",
                                  "pageUrl": "https://www.pexels.com/photo/tacos-9/" } } }] $$),
  '[{"status": "applied"}]'::jsonb, 'a photo and its credit apply through apply_mutations');
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a3000000-0000-7000-8000-000000000002", "hlc": "1760000000001-0001-alex",
    "fields": { "photo_credit": { "provider": "pexels", "author": "Sam Lee", "authorUrl": "http://www.pexels.com/@sam",
                                  "pageUrl": "https://www.pexels.com/photo/tacos-9/" } } }] $$),
  '[{"status": "rejected", "code": "23514", "message": "new row for relation \"recipes\" violates check constraint \"recipes_photo_credit_shape\""}]'::jsonb,
  'a bad credit is rejected through apply_mutations');
reset role;
select results_eq(
  $$ select photo_credit, field_clock ->> 'photo_credit', field_clock ->> 'photo_path'
     from public.recipes where id = 'a3000000-0000-7000-8000-000000000002' $$,
  $$ values ('{"provider": "pexels", "author": "Sam Lee", "authorUrl": "https://www.pexels.com/@sam",
              "pageUrl": "https://www.pexels.com/photo/tacos-9/"}'::jsonb,
             '1760000000001-0000-alex', '1760000000001-0000-alex') $$,
  'the credit is stored with the photo''s clock');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a3000000-0000-7000-8000-000000000002", "hlc": "1760000000001-0002-alex",
    "fields": { "photo_path": null, "photo_credit": null } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Remove photo clears both through apply_mutations');
reset role;

select * from finish();
rollback;
