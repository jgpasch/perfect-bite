-- recipes.steps, servings and image_url (spec 5, 7.1).
begin;
create extension if not exists pgtap with schema extensions;
select plan(42);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex and Jo share household A, which has one recipe from before this migration. Sam owns
-- household S.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'jo@test.local', 'authenticated', 'authenticated');

insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sam''s household');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'member', 2),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner', 1);
insert into public.recipes (id, household_id, name) values
  ('a2000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Old soup');

-- The columns ---------------------------------------------------------------------
select col_type_is('public', 'recipes', 'steps', 'jsonb', 'steps is jsonb');
select col_type_is('public', 'recipes', 'servings', 'integer', 'servings is an int');
select col_type_is('public', 'recipes', 'image_url', 'text', 'image_url is text');
select results_eq(
  $$ select steps, servings, image_url from public.recipes where id = 'a2000000-0000-7000-8000-000000000001' $$,
  $$ values (null::jsonb, null::int, null::text) $$,
  'an existing recipe has no steps, servings or photo');

-- steps -------------------------------------------------------------------------
select throws_ok(
  $$ update public.recipes set steps = '{"1": "Chop"}' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'steps must be an array');
select throws_ok(
  $$ update public.recipes set steps = '"Chop"' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a bare string is refused');
select throws_ok(
  $$ update public.recipes set steps = '[]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'an empty array is refused (null means none)');
select throws_ok(
  $$ update public.recipes set steps = (select jsonb_agg('Stir'::text) from generate_series(1, 101))
     where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, '101 steps are refused');
select throws_ok(
  $$ update public.recipes set steps = '["Chop", 2]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a step that isn''t a string is refused');
select throws_ok(
  $$ update public.recipes set steps = '["Chop", ["Stir"]]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a nested array is refused');
select throws_ok(
  $$ update public.recipes set steps = '["Chop", null]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a null step is refused');
select throws_ok(
  $$ update public.recipes set steps = '["Chop", ""]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'an empty step is refused');
select throws_ok(
  $$ update public.recipes set steps = jsonb_build_array(repeat('a', 2001))
     where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a step over 2000 characters is refused');
select lives_ok(
  $$ update public.recipes set steps = '["Chop"]' where id = 'a2000000-0000-7000-8000-000000000001';
     update public.recipes set steps = (select jsonb_agg('Stir ' || i) from generate_series(1, 100) i)
       where id = 'a2000000-0000-7000-8000-000000000001';
     update public.recipes set steps = jsonb_build_array(repeat('é', 2000), 'x')
       where id = 'a2000000-0000-7000-8000-000000000001';
     update public.recipes set steps = null where id = 'a2000000-0000-7000-8000-000000000001' $$,
  'one step, 100 steps, a 2000-character step (counted in characters, not bytes) and null are accepted');

-- servings ----------------------------------------------------------------------
select throws_ok(
  $$ update public.recipes set servings = 0 where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, '0 servings are refused');
select throws_ok(
  $$ update public.recipes set servings = 101 where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'over 100 servings are refused');
select lives_ok(
  $$ update public.recipes set servings = 1 where id = 'a2000000-0000-7000-8000-000000000001';
     update public.recipes set servings = 100 where id = 'a2000000-0000-7000-8000-000000000001';
     update public.recipes set servings = null where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '1 and 100 servings and null are accepted');

-- image_url ---------------------------------------------------------------------
select throws_ok(
  $$ update public.recipes set image_url = 'http://example.com/a.jpg' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'an http:// photo is refused');
select throws_ok(
  $$ update public.recipes set image_url = '/images/a.jpg' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a relative photo URL is refused');
select throws_ok(
  $$ update public.recipes set image_url = 'HTTPS://example.com/a.jpg' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'the scheme must be lower-case https://');
select throws_ok(
  $$ update public.recipes set image_url = '' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'an empty photo URL is refused');
select throws_ok(
  $$ update public.recipes set image_url = 'https://example.com/' || repeat('a', 2029)
     where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a photo URL over 2048 characters is refused');
select lives_ok(
  $$ update public.recipes set image_url = 'https://example.com/' || repeat('a', 2028)
       where id = 'a2000000-0000-7000-8000-000000000001';
     update public.recipes set image_url = null where id = 'a2000000-0000-7000-8000-000000000001' $$,
  'a 2048-character https:// URL and null are accepted');

-- As Alex (a member) --------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select is(
  public.apply_mutations($$ [
    { "table": "recipes", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000001-0000-alex",
      "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Tacos",
                  "steps": ["Brown the beef.", "Warm the tortillas."], "servings": 4,
                  "image_url": "https://example.com/tacos.jpg" } }
  ] $$),
  '[{"status": "applied"}]'::jsonb, 'Alex inserts a recipe with steps, servings and a photo');
select results_eq(
  $$ select steps, servings, image_url, field_clock ->> 'steps', field_clock ->> 'servings', field_clock ->> 'image_url'
     from public.recipes where id = 'a2000000-0000-7000-8000-000000000002' $$,
  $$ values ('["Brown the beef.", "Warm the tortillas."]'::jsonb, 4, 'https://example.com/tacos.jpg',
             '1760000000001-0000-alex', '1760000000001-0000-alex', '1760000000001-0000-alex') $$,
  'the insert stores all three, each with its own clock');
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000001-0001-alex",
    "fields": { "steps": ["Simmer."], "servings": 2, "image_url": "https://example.com/soup.jpg" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Alex sets all three on an existing recipe');
select results_eq(
  $$ select steps, servings, image_url from public.recipes where id = 'a2000000-0000-7000-8000-000000000001' $$,
  $$ values ('["Simmer."]'::jsonb, 2, 'https://example.com/soup.jpg') $$,
  'the update stores all three');

-- Each check also rejects through apply_mutations.
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000002-0000-alex",
    "fields": { "steps": [] } }] $$),
  '[{"status": "rejected", "code": "23514", "message": "new row for relation \"recipes\" violates check constraint \"recipes_steps_shape\""}]'::jsonb,
  'empty steps are rejected through apply_mutations');
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000002-0001-alex",
    "fields": { "servings": 0 } }] $$),
  '[{"status": "rejected", "code": "23514", "message": "new row for relation \"recipes\" violates check constraint \"recipes_servings_range\""}]'::jsonb,
  'servings out of range are rejected through apply_mutations');
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000004", "hlc": "1760000000002-0002-alex",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Bad", "image_url": "http://example.com/a.jpg" } }] $$),
  '[{"status": "rejected", "code": "23514", "message": "new row for relation \"recipes\" violates check constraint \"recipes_image_url_shape\""}]'::jsonb,
  'an http:// photo is rejected on insert through apply_mutations');
select is(
  (select count(*)::int from public.recipes where id = 'a2000000-0000-7000-8000-000000000004'),
  0, 'the rejected insert made no recipe');

-- Last-writer-wins per field: Alex edits steps and servings at :05, Jo's older offline edit (:03)
-- of all three arrives later.
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000005-0000-alex",
    "fields": { "steps": ["Brown the beef with cumin."], "servings": 6 } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Alex edits steps and servings');

-- As Jo (another member of the same household) ------------------------------------
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);

select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000003-0000-jo",
    "fields": { "steps": ["Jo's way."], "servings": 3, "image_url": "https://example.com/jo.jpg" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Jo''s older edit applies its newer field (the photo) only');
select results_eq(
  $$ select steps, servings, image_url, field_clock ->> 'steps', field_clock ->> 'servings', field_clock ->> 'image_url'
     from public.recipes where id = 'a2000000-0000-7000-8000-000000000002' $$,
  $$ values ('["Brown the beef with cumin."]'::jsonb, 6, 'https://example.com/jo.jpg',
             '1760000000005-0000-alex', '1760000000005-0000-alex', '1760000000003-0000-jo') $$,
  'Alex''s newer steps and servings win, Jo''s photo lands');
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000004-0000-jo",
    "fields": { "steps": null, "servings": null } }] $$),
  '[{"status": "unchanged"}]'::jsonb, 'an older clear loses too');
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000007-0000-jo",
    "fields": { "steps": null, "servings": null, "image_url": null } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Jo''s newer edit clears all three');
select results_eq(
  $$ select steps, servings, image_url from public.recipes where id = 'a2000000-0000-7000-8000-000000000002' $$,
  $$ values (null::jsonb, null::int, null::text) $$,
  'all three are null again');

-- As Sam (another household) ------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);

select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000009-0000-sam",
    "fields": { "steps": ["Sam's step."], "servings": 9, "image_url": "https://example.com/sam.jpg" } }] $$),
  '[{"status": "rejected", "code": "42501", "message": "not a member of household aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}]'::jsonb,
  'Sam can''t set them on household A''s recipe');
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000005", "hlc": "1760000000009-0001-sam",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Sam's", "steps": ["Sam's step."] } }] $$),
  '[{"status": "rejected", "code": "42501", "message": "not a member of household aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}]'::jsonb,
  'Sam can''t insert a recipe with them into household A');
select throws_ok(
  $$ update public.recipes set steps = '["Sam''s step."]', servings = 9, image_url = 'https://example.com/sam.jpg'
     where id = 'a2000000-0000-7000-8000-000000000002' $$,
  '42501', null, 'Sam can''t update them directly');

reset role;
select results_eq(
  $$ select steps, servings, image_url from public.recipes where id = 'a2000000-0000-7000-8000-000000000002' $$,
  $$ values (null::jsonb, null::int, null::text) $$,
  'Sam''s writes changed nothing');
select is(
  (select count(*)::int from public.recipes where id = 'a2000000-0000-7000-8000-000000000005'),
  0, 'Sam made no recipe');

select * from finish();
rollback;
