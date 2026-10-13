-- recipes.tags, tags_edited, total_minutes and added_by (spec 4.14, 5, 7.1).
begin;
create extension if not exists pgtap with schema extensions;
select plan(34);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex and Jo share household A, which has one recipe Alex's device made before this migration
-- (no added_by). Sam owns household S.
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
select col_type_is('public', 'recipes', 'tags', 'jsonb', 'tags is jsonb');
select col_type_is('public', 'recipes', 'total_minutes', 'integer', 'total_minutes is an int');
select col_type_is('public', 'recipes', 'added_by', 'uuid', 'added_by is a uuid');
select fk_ok('public', 'recipes', 'added_by', 'auth', 'users', 'id', 'added_by references auth.users');
select results_eq(
  $$ select tags, tags_edited, total_minutes, added_by from public.recipes where id = 'a2000000-0000-7000-8000-000000000001' $$,
  $$ values (null::jsonb, false, null::int, null::uuid) $$,
  'an existing recipe is untagged, unedited, untimed and has no added_by');

-- The check constraints -----------------------------------------------------------
select throws_ok(
  $$ update public.recipes set tags = '["dinner"]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'tags must be an object');
select throws_ok(
  $$ update public.recipes set tags = '{"meal": [], "course": []}' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'an unknown facet is refused');
select throws_ok(
  $$ update public.recipes set tags = '{"meal": "dinner"}' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a facet that isn''t an array is refused');
select throws_ok(
  $$ update public.recipes set tags = '{"meal": ["dinner", 3]}' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a value that isn''t a string is refused');
select throws_ok(
  $$ update public.recipes set tags = '{"protein": [["beef"]]}' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a nested array is refused');
select lives_ok(
  $$ update public.recipes set tags = '{"meal": ["brunch"], "cuisine": [], "protein": [], "diet": [], "method": []}' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  'a value the database doesn''t know is accepted');
select lives_ok(
  $$ update public.recipes set tags = '{"meal": ["dinner"]}' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  'missing facets are accepted');
select lives_ok(
  $$ update public.recipes set tags = '{}' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  'an empty object is accepted');
select throws_ok(
  $$ update public.recipes set total_minutes = 0 where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, '0 minutes is refused');
select throws_ok(
  $$ update public.recipes set total_minutes = 2881 where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'over 2880 minutes (two days) is refused');
select lives_ok(
  $$ update public.recipes set total_minutes = 1 where id = 'a2000000-0000-7000-8000-000000000001';
     update public.recipes set total_minutes = 2880 where id = 'a2000000-0000-7000-8000-000000000001';
     update public.recipes set total_minutes = null, tags = null where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '1 and 2880 minutes and null are accepted');

-- As Alex (a member) --------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select is(
  public.apply_mutations($$ [
    { "table": "recipes", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000001-0000-alex",
      "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Tacos",
                  "tags": { "meal": ["dinner"], "cuisine": ["mexican"], "protein": ["beef"], "diet": [], "method": [] },
                  "tags_edited": false, "total_minutes": 45 } },
    { "table": "recipes", "id": "a2000000-0000-7000-8000-000000000003", "hlc": "1760000000001-0001-alex",
      "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Salad",
                  "added_by": "33333333-3333-3333-3333-333333333333" } }
  ] $$),
  '[{"status": "applied"}, {"status": "applied"}]'::jsonb, 'Alex inserts two recipes, one claiming Jo added it');
select results_eq(
  $$ select tags, tags_edited, total_minutes, added_by from public.recipes where id = 'a2000000-0000-7000-8000-000000000002' $$,
  $$ values ('{"meal": ["dinner"], "cuisine": ["mexican"], "protein": ["beef"], "diet": [], "method": []}'::jsonb, false, 45, '11111111-1111-1111-1111-111111111111'::uuid) $$,
  'the insert stores tags and time, and added_by is the caller');
select is(
  (select added_by from public.recipes where id = 'a2000000-0000-7000-8000-000000000003'),
  '11111111-1111-1111-1111-111111111111'::uuid, 'a client''s added_by is ignored on insert: it''s the caller');
select ok(
  (select not (field_clock ? 'added_by') from public.recipes where id = 'a2000000-0000-7000-8000-000000000003'),
  'added_by gets no field clock');
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000004", "hlc": "1760000000001-0002-alex",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Bad", "tags": { "meal": "dinner" } } }] $$),
  '[{"status": "rejected", "code": "23514", "message": "new row for relation \"recipes\" violates check constraint \"recipes_tags_shape\""}]'::jsonb,
  'a bad tags shape is rejected through apply_mutations');
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000001-0003-alex",
    "fields": { "total_minutes": 0 } }] $$),
  '[{"status": "rejected", "code": "23514", "message": "new row for relation \"recipes\" violates check constraint \"recipes_total_minutes_range\""}]'::jsonb,
  'minutes out of range are rejected through apply_mutations');

-- Last-writer-wins on tags: Alex edits at :05, Jo's older offline edit (:03) arrives later.
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000005-0000-alex",
    "fields": { "tags": { "meal": ["lunch"], "cuisine": [], "protein": ["beef"], "diet": [], "method": [] }, "tags_edited": true } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Alex edits the tags');

-- As Jo (another member of the same household) ------------------------------------
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);

select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000003-0000-jo",
    "fields": { "tags": { "meal": ["snack"], "cuisine": [], "protein": [], "diet": [], "method": [] }, "total_minutes": 20 } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Jo''s older edit applies its newer field (time) only');
select results_eq(
  $$ select tags, tags_edited, total_minutes, field_clock ->> 'tags', field_clock ->> 'total_minutes'
     from public.recipes where id = 'a2000000-0000-7000-8000-000000000002' $$,
  $$ values ('{"meal": ["lunch"], "cuisine": [], "protein": ["beef"], "diet": [], "method": []}'::jsonb, true, 20,
             '1760000000005-0000-alex', '1760000000003-0000-jo') $$,
  'Alex''s newer tags win, Jo''s time lands');
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000007-0000-jo",
    "fields": { "tags": { "meal": [], "cuisine": ["mexican"] } } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Jo''s newer tags edit applies');
select is(
  (select tags from public.recipes where id = 'a2000000-0000-7000-8000-000000000002'),
  '{"meal": [], "cuisine": ["mexican"]}'::jsonb, 'the whole tags value is one field: it''s replaced, not merged');

-- added_by can't change on update.
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000008-0000-jo",
    "fields": { "added_by": "33333333-3333-3333-3333-333333333333" } }] $$),
  '[{"status": "unchanged"}]'::jsonb, 'an update setting only added_by changes nothing');
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000009-0000-jo",
    "fields": { "added_by": null, "name": "Beef tacos" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'an update with added_by and another field applies the other field');
select results_eq(
  $$ select name, added_by from public.recipes where id = 'a2000000-0000-7000-8000-000000000002' $$,
  $$ values ('Beef tacos', '11111111-1111-1111-1111-111111111111'::uuid) $$,
  'added_by is still Alex');
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000009-0001-jo",
    "fields": { "added_by": "33333333-3333-3333-3333-333333333333", "tags_edited": true } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Jo edits the old recipe, claiming to have added it');
select results_eq(
  $$ select added_by, tags_edited from public.recipes where id = 'a2000000-0000-7000-8000-000000000001' $$,
  $$ values (null::uuid, true) $$,
  'an existing recipe''s null added_by stays null');
select throws_ok(
  $$ update public.recipes set added_by = '33333333-3333-3333-3333-333333333333' where id = 'a2000000-0000-7000-8000-000000000002' $$,
  '42501', null, 'added_by can''t be updated directly');

-- Deleting a user keeps their recipes, with added_by null.
reset role;
delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
select results_eq(
  $$ select name, added_by from public.recipes where id = 'a2000000-0000-7000-8000-000000000002' $$,
  $$ values ('Beef tacos', null::uuid) $$,
  'a deleted user''s recipe stays with no added_by');

select * from finish();
rollback;
