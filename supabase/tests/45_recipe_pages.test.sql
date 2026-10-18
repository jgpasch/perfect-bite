-- A recipe's original pages (spec 4.10, 5): the recipe-pages bucket and its policies,
-- recipes.source_pages's check and apply_mutations, and the cleanup queue for changed, cleared,
-- purged and deleted-household pages, including household deletion through delete_household.
begin;
create extension if not exists pgtap with schema extensions;
select plan(48);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex and Jo share household A, with recipes RA1 and RA2; Sam owns household S, with recipe RS. A
-- and S have page objects already: RA1 has pages e…01 and e…02, RS has e…09.
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
  ('a3000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Blueberry bread'),
  ('a3000000-0000-7000-8000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tacos'),
  ('b3000000-0000-7000-8000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Soup');
insert into storage.objects (bucket_id, name) values
  ('recipe-pages', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000001.jpg'),
  ('recipe-pages', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000002.jpg'),
  ('recipe-pages', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/b3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000009.jpg');

-- The bucket and the column ---------------------------------------------------------
select results_eq(
  $$ select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'recipe-pages' $$,
  $$ values (false, 2097152::bigint, array['image/jpeg']) $$,
  'recipe-pages is private, jpeg only, 2 MB');
select col_type_is('public', 'recipes', 'source_pages', 'jsonb', 'source_pages is jsonb');
select is(
  (select source_pages from public.recipes where id = 'a3000000-0000-7000-8000-000000000001'),
  null, 'a recipe has no pages to start with');

-- Storage policies -------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select results_eq(
  $$ select name from storage.objects where bucket_id = 'recipe-pages' order by name $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000001.jpg'),
            ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000002.jpg') $$,
  'a member sees their household''s pages and no other household''s');
select lives_ok(
  $$ insert into storage.objects (bucket_id, name) values
     ('recipe-pages', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/e0000000-0000-7000-8000-000000000003.jpg') $$,
  'a member can upload a page under their household''s prefix');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values
     ('recipe-pages', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/b3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000004.jpg') $$,
  '42501', null, 'a member can''t upload under another household''s prefix');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values
     ('recipe-pages', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/e0000000-0000-7000-8000-000000000004.jpg') $$,
  '42501', null, 'an upload outside <household>/<recipe>/<uuid>.jpg is refused');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values
     ('recipe-pages', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/e0000000-0000-7000-8000-000000000004.png') $$,
  '42501', null, 'a non-jpg name is refused');
update storage.objects set metadata = '{"x": 1}'
where name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000001.jpg';
reset role;
select is(
  (select metadata from storage.objects
   where name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000001.jpg'),
  null, 'nobody can update a page (a new page is a new object)');

-- Sam can't see or delete household A's pages; Jo, its other member, can delete them.
select set_config('storage.allow_delete_query', 'true', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is(
  (select count(*) from storage.objects where bucket_id = 'recipe-pages' and name like 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/%'),
  0::bigint, 'another household''s member can''t read the pages');
delete from storage.objects where bucket_id = 'recipe-pages' and name like 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/%';
reset role;
select is(
  (select count(*) from storage.objects where bucket_id = 'recipe-pages' and name like 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/%'),
  3::bigint, 'another household''s member can''t delete them');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
delete from storage.objects
where bucket_id = 'recipe-pages'
  and name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/e0000000-0000-7000-8000-000000000003.jpg';
reset role;
select is(
  (select count(*) from storage.objects where bucket_id = 'recipe-pages' and name like 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/%'),
  2::bigint, 'a member can delete under their household''s prefix');
select set_config('storage.allow_delete_query', 'false', true);
set local role authenticated;

select throws_ok(
  $$ select * from private.recipe_page_deletions $$, '42501', null, 'a member can''t read the cleanup queue');
select throws_ok(
  $$ select * from public.claim_recipe_page_deletions(10, '0 seconds') $$, '42501', null, 'a member can''t claim deletions');
select throws_ok(
  $$ select public.complete_recipe_page_deletions(array[1::bigint]) $$, '42501', null, 'a member can''t complete deletions');

set local role anon;
select is(
  (select count(*) from storage.objects where bucket_id = 'recipe-pages'), 0::bigint, 'anon sees no pages');
reset role;

-- source_pages's check -------------------------------------------------------------------
select lives_ok(
  $$ update public.recipes
     set source_pages = '["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/e0000000-0000-7000-8000-000000000011.jpg",
                         "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/e0000000-0000-7000-8000-000000000012.jpg",
                         "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/e0000000-0000-7000-8000-000000000013.jpg"]'
     where id = 'a3000000-0000-7000-8000-000000000002' $$,
  'three pages in the recipe''s household under its own id are accepted');
select throws_ok(
  $$ update public.recipes
     set source_pages = '["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/e0000000-0000-7000-8000-000000000011.jpg",
                         "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/e0000000-0000-7000-8000-000000000012.jpg",
                         "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/e0000000-0000-7000-8000-000000000013.jpg",
                         "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/e0000000-0000-7000-8000-000000000014.jpg"]'
     where id = 'a3000000-0000-7000-8000-000000000002' $$,
  '23514', null, 'four pages are too many');
select throws_ok(
  $$ update public.recipes set source_pages = '[]' where id = 'a3000000-0000-7000-8000-000000000002' $$,
  '23514', null, 'an empty array is refused (no pages is null)');
select throws_ok(
  $$ update public.recipes
     set source_pages = '"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/e0000000-0000-7000-8000-000000000011.jpg"'
     where id = 'a3000000-0000-7000-8000-000000000002' $$,
  '23514', null, 'a bare string instead of an array is refused');
select throws_ok(
  $$ update public.recipes set source_pages = '[1]' where id = 'a3000000-0000-7000-8000-000000000002' $$,
  '23514', null, 'a page that isn''t a string is refused');
select throws_ok(
  $$ update public.recipes
     set source_pages = '["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/a3000000-0000-7000-8000-000000000002/e0000000-0000-7000-8000-000000000011.jpg"]'
     where id = 'a3000000-0000-7000-8000-000000000002' $$,
  '23514', null, 'a page whose household isn''t the recipe''s is refused');
select throws_ok(
  $$ update public.recipes
     set source_pages = '["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000011.jpg"]'
     where id = 'a3000000-0000-7000-8000-000000000002' $$,
  '23514', null, 'a page under another recipe''s id is refused');
select throws_ok(
  $$ update public.recipes
     set source_pages = '["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/e0000000-0000-7000-8000-000000000011.png"]'
     where id = 'a3000000-0000-7000-8000-000000000002' $$,
  '23514', null, 'a page that isn''t a .jpg is refused');
select throws_ok(
  $$ update public.recipes
     set source_pages = '["AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA/a3000000-0000-7000-8000-000000000002/e0000000-0000-7000-8000-000000000011.jpg"]'
     where id = 'a3000000-0000-7000-8000-000000000002' $$,
  '23514', null, 'an uppercase household folder is refused');
select throws_ok(
  $$ update public.recipes
     set source_pages = '["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/e0000000-0000-7000-8000-000000000011.jpg",
                         "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/e0000000-0000-7000-8000-000000000011.jpg"]'
     where id = 'a3000000-0000-7000-8000-000000000002' $$,
  '23514', null, 'the same page twice is refused');

-- Through apply_mutations, as the app writes it: applied with its own clock, or rejected.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a3000000-0000-7000-8000-000000000001", "hlc": "1760000000001-0000-alex",
    "fields": { "source_pages": ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000001.jpg",
                                 "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000002.jpg"] } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Alex sets source_pages through apply_mutations');
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a3000000-0000-7000-8000-000000000001", "hlc": "1760000000001-0001-alex",
    "fields": { "source_pages": ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000001.jpg"] } }] $$),
  '[{"status": "rejected", "code": "23514", "message": "new row for relation \"recipes\" violates check constraint \"recipes_source_pages_shape\""}]'::jsonb,
  'another household''s page is rejected through apply_mutations');
-- Jo's later rename and Alex's older source_pages merge per field: both stick.
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a3000000-0000-7000-8000-000000000001", "hlc": "1760000000002-0000-jo00",
    "fields": { "name": "Lemon blueberry bread" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Jo renames the recipe');
reset role;
select results_eq(
  $$ select source_pages, name, field_clock ->> 'source_pages', field_clock ->> 'name'
     from public.recipes where id = 'a3000000-0000-7000-8000-000000000001' $$,
  $$ values ('["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000001.jpg",
               "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000002.jpg"]'::jsonb,
             'Lemon blueberry bread', '1760000000001-0000-alex', '1760000000002-0000-jo00') $$,
  'source_pages is stored in order with its own clock, merged per field with the name');
delete from private.recipe_page_deletions;

-- Queueing for cleanup -------------------------------------------------------------------
select is((select count(*) from private.recipe_page_deletions), 0::bigint, 'nothing is queued to start with');

update public.recipes set name = 'Blueberry loaf' where id = 'a3000000-0000-7000-8000-000000000001';
select is((select count(*) from private.recipe_page_deletions), 0::bigint, 'another column''s change queues nothing');

-- e…02 stays, e…01 goes, e…05 is new: only e…01 is queued.
update public.recipes
set source_pages = '["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000002.jpg",
                     "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000005.jpg"]'
where id = 'a3000000-0000-7000-8000-000000000001';
select results_eq(
  $$ select path, is_prefix from private.recipe_page_deletions $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000001.jpg', false) $$,
  'a changed array queues each old page no longer in it, and only those');

update public.recipes set source_pages = null where id = 'a3000000-0000-7000-8000-000000000001';
select results_eq(
  $$ select path from private.recipe_page_deletions order by id $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000001.jpg'),
            ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000002.jpg'),
            ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000005.jpg') $$,
  'cleared pages queue every old page, in page order');
select is((select count(*) from private.recipe_photo_deletions), 0::bigint, 'pages don''t go in the recipe photo queue');
select is((select count(*) from private.item_photo_deletions), 0::bigint, '…or the item photo queue');

-- The sweep -------------------------------------------------------------------------------
select is(
  (select count(*) from public.claim_recipe_page_deletions(10, '1 hour')),
  0::bigint, 'an entry younger than the minimum age isn''t claimed yet');

-- Undo puts e…02 back before the sweep. e…05 was never uploaded. Only e…01 is left to delete.
update public.recipes
set source_pages = '["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000002.jpg"]'
where id = 'a3000000-0000-7000-8000-000000000001';
select results_eq(
  $$ select name from public.claim_recipe_page_deletions(10, '0 seconds') $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000001.jpg') $$,
  'claiming skips a page a recipe points at again and one never uploaded');
select results_eq(
  $$ select path from private.recipe_page_deletions $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000001.jpg') $$,
  '…and drops their entries');
select lives_ok(
  $$ select public.complete_recipe_page_deletions(array(select id from private.recipe_page_deletions)) $$,
  'completing works');
select is((select count(*) from private.recipe_page_deletions), 0::bigint, 'completed entries are gone');

-- A purged recipe (its row deleted) queues its own prefix, which also catches a stray upload.
insert into storage.objects (bucket_id, name) values
  ('recipe-pages', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000006.jpg');
delete from public.recipes where id = 'a3000000-0000-7000-8000-000000000001';
select results_eq(
  $$ select path, is_prefix from private.recipe_page_deletions $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/', true) $$,
  'a purged recipe queues its <household>/<recipe>/ prefix');
select results_eq(
  $$ select name from public.claim_recipe_page_deletions(10, '0 seconds') $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000001.jpg'),
            ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000002.jpg'),
            ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000006.jpg') $$,
  'the recipe prefix stands for every object under it, a page or a stray upload');
delete from private.recipe_page_deletions;

-- Deleting a household queues its recipes' prefixes and its whole prefix.
update public.recipes
set source_pages = '["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/b3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000009.jpg"]'
where id = 'b3000000-0000-7000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select lives_ok($$ select public.delete_household('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') $$, 'Sam deletes household S');
reset role;
select results_eq(
  $$ select path, is_prefix from private.recipe_page_deletions order by path $$,
  $$ values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/', true),
            ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/b3000000-0000-7000-8000-000000000001/', true) $$,
  'a deleted household queues its whole prefix and its recipe''s');
select results_eq(
  $$ select name from public.claim_recipe_page_deletions(10, '0 seconds')
     where queue_id = (select id from private.recipe_page_deletions where path = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/') $$,
  $$ values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/b3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-000000000009.jpg') $$,
  'the household prefix stands for every page under it');
delete from private.recipe_page_deletions;

-- Calling the function -----------------------------------------------------------------------
delete from private.recipe_photo_deletions;
delete from private.item_photo_deletions;
select vault.create_secret('http://host.docker.internal:55321', 'project_url');
select vault.create_secret('test-key', 'photo_cleanup_key');
select is(private.request_recipe_photo_cleanup(), false, 'with every queue empty, nothing is called');
insert into private.recipe_page_deletions (path) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/e0000000-0000-7000-8000-000000000011.jpg');
select is(private.request_recipe_photo_cleanup(), true, 'with only pages queued, photo-cleanup is called');

select * from finish();
rollback;
