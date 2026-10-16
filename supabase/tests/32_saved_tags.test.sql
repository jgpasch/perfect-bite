-- The Saved tag facet in recipes_tags_shape (spec 4.14, 5).
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex owns household A, with one recipe tagged before the Saved facet (no saved key).
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1);
insert into public.recipes (id, household_id, name, tags) values
  ('a3000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tacos',
   '{"meal": ["dinner"], "cuisine": [], "protein": [], "diet": [], "method": []}');

-- The shape check -----------------------------------------------------------------
select lives_ok(
  $$ update public.recipes set tags = '{"saved": ["favorite"], "meal": ["dinner"], "cuisine": [], "protein": [], "diet": [], "method": []}'
     where id = 'a3000000-0000-7000-8000-000000000001' $$,
  'saved is accepted with the other facets');
select lives_ok(
  $$ update public.recipes set tags = '{"saved": ["favorite", "want-to-try"]}' where id = 'a3000000-0000-7000-8000-000000000001' $$,
  'saved alone, with both values, is accepted');
select lives_ok(
  $$ update public.recipes set tags = '{"saved": ["loved"]}' where id = 'a3000000-0000-7000-8000-000000000001' $$,
  'a saved value the database doesn''t know is accepted');
select lives_ok(
  $$ update public.recipes set tags = '{"meal": ["lunch"]}' where id = 'a3000000-0000-7000-8000-000000000001' $$,
  'tags without saved are still accepted');
select throws_ok(
  $$ update public.recipes set tags = '{"saved": [], "course": []}' where id = 'a3000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'an unknown key is still refused');
select throws_ok(
  $$ update public.recipes set tags = '{"saved": "favorite"}' where id = 'a3000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a saved facet that isn''t an array is refused');
select throws_ok(
  $$ update public.recipes set tags = '{"saved": [true]}' where id = 'a3000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a saved value that isn''t a string is refused');

-- Through apply_mutations -------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}', true);
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a3000000-0000-7000-8000-000000000001", "hlc": "1800000000000-0000-alex",
    "fields": { "tags": { "saved": ["want-to-try"], "meal": ["dinner"], "cuisine": [], "protein": [], "diet": [], "method": [] },
                "tags_edited": true } }] $$),
  '[{"status": "applied"}]'::jsonb, 'a member saves Want to try through apply_mutations');
reset role;
select is(
  (select tags -> 'saved' from public.recipes where id = 'a3000000-0000-7000-8000-000000000001'),
  '["want-to-try"]'::jsonb, 'the saved value is stored');

select * from finish();
rollback;
