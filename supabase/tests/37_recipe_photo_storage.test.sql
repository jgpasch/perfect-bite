-- A household's own recipe photos (spec 4.5, 5): the recipe-photos bucket and its policies,
-- recipes.photo_path's check, and the cleanup queue for changed, cleared, purged and deleted-household
-- photos.
begin;
create extension if not exists pgtap with schema extensions;
select plan(41);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex and Jo share household A, which has recipe RA; Sam owns household S, with recipe RS. Each
-- household has one photo object already.
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
  ('recipe-photos', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000001.jpg'),
  ('recipe-photos', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/b3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000009.jpg');

-- The bucket and the column ---------------------------------------------------------
select results_eq(
  $$ select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'recipe-photos' $$,
  $$ values (false, 2097152::bigint, array['image/jpeg']) $$,
  'recipe-photos is private, jpeg only, 2 MB');
select col_type_is('public', 'recipes', 'photo_path', 'text', 'photo_path is text');
select is(
  (select photo_path from public.recipes where id = 'a3000000-0000-7000-8000-000000000001'),
  null, 'a recipe has no own photo to start with');

-- Storage policies -------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select results_eq(
  $$ select name from storage.objects where bucket_id = 'recipe-photos' $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000001.jpg') $$,
  'a member sees their household''s photos and no other household''s');
select lives_ok(
  $$ insert into storage.objects (bucket_id, name) values
     ('recipe-photos', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/c0000000-0000-7000-8000-000000000002.jpg') $$,
  'a member can upload under their household''s prefix');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values
     ('recipe-photos', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/b3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000003.jpg') $$,
  '42501', null, 'a member can''t upload under another household''s prefix');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values
     ('recipe-photos', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/c0000000-0000-7000-8000-000000000003.jpg') $$,
  '42501', null, 'an upload outside <household>/<recipe>/<uuid>.jpg is refused');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values
     ('recipe-photos', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/c0000000-0000-7000-8000-000000000003.png') $$,
  '42501', null, 'a non-jpg name is refused');
update storage.objects set metadata = '{"x": 1}'
where name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000001.jpg';
reset role;
select is(
  (select metadata from storage.objects
   where name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000001.jpg'),
  null, 'nobody can update a photo (a new photo is a new object)');

-- Sam can't see or delete household A's photos; Jo, its other member, can delete them.
select set_config('storage.allow_delete_query', 'true', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is(
  (select count(*) from storage.objects where name like 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/%'),
  0::bigint, 'another household''s member can''t read the photos');
delete from storage.objects where name like 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/%';
reset role;
select is(
  (select count(*) from storage.objects where name like 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/%'),
  2::bigint, 'another household''s member can''t delete them');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
delete from storage.objects
where name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/c0000000-0000-7000-8000-000000000002.jpg';
reset role;
select is(
  (select count(*) from storage.objects where name like 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/%'),
  1::bigint, 'a member can delete under their household''s prefix');
select set_config('storage.allow_delete_query', 'false', true);
set local role authenticated;

select throws_ok(
  $$ select * from private.recipe_photo_deletions $$, '42501', null, 'a member can''t read the cleanup queue');
select throws_ok(
  $$ select * from public.claim_recipe_photo_deletions(10, '0 seconds') $$, '42501', null, 'a member can''t claim deletions');
select throws_ok(
  $$ select public.complete_recipe_photo_deletions(array[1::bigint]) $$, '42501', null, 'a member can''t complete deletions');

set local role anon;
select is(
  (select count(*) from storage.objects where bucket_id = 'recipe-photos'), 0::bigint, 'anon sees no photos');
reset role;

-- photo_path's check -------------------------------------------------------------------
select lives_ok(
  $$ update public.recipes
     set photo_path = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000001.jpg'
     where id = 'a3000000-0000-7000-8000-000000000001' $$,
  'a path in the recipe''s household is accepted');
select throws_ok(
  $$ update public.recipes
     set photo_path = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/a3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000004.jpg'
     where id = 'a3000000-0000-7000-8000-000000000002' $$,
  '23514', null, 'a path whose household isn''t the recipe''s is refused');
select throws_ok(
  $$ update public.recipes
     set photo_path = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/c0000000-0000-7000-8000-000000000004.png'
     where id = 'a3000000-0000-7000-8000-000000000002' $$,
  '23514', null, 'a path that isn''t a .jpg is refused');
select throws_ok(
  $$ update public.recipes set photo_path = 'https://example.com/a.jpg' where id = 'a3000000-0000-7000-8000-000000000002' $$,
  '23514', null, 'a URL is refused (that''s image_url)');
select throws_ok(
  $$ update public.recipes
     set photo_path = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA/a3000000-0000-7000-8000-000000000002/c0000000-0000-7000-8000-000000000004.jpg'
     where id = 'a3000000-0000-7000-8000-000000000002' $$,
  '23514', null, 'an uppercase household prefix is refused');

-- Through apply_mutations, as the app writes it: applied with its own clock, or rejected.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a3000000-0000-7000-8000-000000000002", "hlc": "1760000000001-0000-alex",
    "fields": { "photo_path": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/c0000000-0000-7000-8000-000000000006.jpg" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Alex sets photo_path through apply_mutations');
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a3000000-0000-7000-8000-000000000002", "hlc": "1760000000001-0001-alex",
    "fields": { "photo_path": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/a3000000-0000-7000-8000-000000000002/c0000000-0000-7000-8000-000000000006.jpg" } }] $$),
  '[{"status": "rejected", "code": "23514", "message": "new row for relation \"recipes\" violates check constraint \"recipes_photo_path_shape\""}]'::jsonb,
  'another household''s path is rejected through apply_mutations');
reset role;
select results_eq(
  $$ select photo_path, field_clock ->> 'photo_path' from public.recipes where id = 'a3000000-0000-7000-8000-000000000002' $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000002/c0000000-0000-7000-8000-000000000006.jpg',
             '1760000000001-0000-alex') $$,
  'photo_path is stored with its own clock');
update public.recipes set photo_path = null where id = 'a3000000-0000-7000-8000-000000000002';
delete from private.recipe_photo_deletions;

-- Queueing for cleanup -------------------------------------------------------------------
select is((select count(*) from private.recipe_photo_deletions), 0::bigint, 'setting a first photo queues nothing');

update public.recipes set name = 'Blueberry loaf' where id = 'a3000000-0000-7000-8000-000000000001';
select is((select count(*) from private.recipe_photo_deletions), 0::bigint, 'another column''s change queues nothing');

update public.recipes
set photo_path = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000005.jpg'
where id = 'a3000000-0000-7000-8000-000000000001';
select results_eq(
  $$ select path, is_prefix from private.recipe_photo_deletions $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000001.jpg', false) $$,
  'a changed photo queues the old object');

update public.recipes set photo_path = null where id = 'a3000000-0000-7000-8000-000000000001';
select results_eq(
  $$ select path from private.recipe_photo_deletions order by id $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000001.jpg'),
            ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000005.jpg') $$,
  'a cleared photo queues the old object');

-- The sweep -------------------------------------------------------------------------------
select is(
  (select count(*) from public.claim_recipe_photo_deletions(10, '1 hour')),
  0::bigint, 'an entry younger than the minimum age isn''t claimed yet');
-- c…05 was never uploaded: its entry is dropped. c…01 is still there and nothing points at it.
select results_eq(
  $$ select name from public.claim_recipe_photo_deletions(10, '0 seconds') $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000001.jpg') $$,
  'claiming returns an unreferenced object');
select is((select count(*) from private.recipe_photo_deletions), 1::bigint, 'an entry whose object is gone is dropped');

-- Undo puts the old photo back: its entry is dropped rather than deleted.
update public.recipes
set photo_path = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000001.jpg'
where id = 'a3000000-0000-7000-8000-000000000001';
select is(
  (select count(*) from public.claim_recipe_photo_deletions(10, '0 seconds')),
  0::bigint, 'an object a recipe points at again isn''t claimed');
select is((select count(*) from private.recipe_photo_deletions), 0::bigint, '…and its entry is dropped');

-- A purged recipe (its row deleted) queues its object.
delete from public.recipes where id = 'a3000000-0000-7000-8000-000000000001';
select results_eq(
  $$ select queue_id, name from public.claim_recipe_photo_deletions(10, '0 seconds') $$,
  $$ select id, path from private.recipe_photo_deletions $$,
  'a purged recipe''s object is queued and claimed');
select lives_ok(
  $$ select public.complete_recipe_photo_deletions(array(select id from private.recipe_photo_deletions)) $$,
  'completing works');
select is((select count(*) from private.recipe_photo_deletions), 0::bigint, 'completed entries are gone');

-- Deleting a household queues its prefix and its recipes' photos.
update public.recipes
set photo_path = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/b3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000009.jpg'
where id = 'b3000000-0000-7000-8000-000000000001';
insert into storage.objects (bucket_id, name) values
  ('recipe-photos', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/b3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000008.jpg');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select lives_ok($$ select public.delete_household('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') $$, 'Sam deletes household S');
reset role;
select results_eq(
  $$ select path, is_prefix from private.recipe_photo_deletions order by is_prefix, path $$,
  $$ values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/b3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000009.jpg', false),
            ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/', true) $$,
  'a deleted household queues its recipes'' photos and its whole prefix');
select results_eq(
  $$ select name from public.claim_recipe_photo_deletions(10, '0 seconds') where queue_id = (select id from private.recipe_photo_deletions where is_prefix) $$,
  $$ values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/b3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000008.jpg'),
            ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/b3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-000000000009.jpg') $$,
  'the prefix stands for every object under it, a photo or a stray upload');

-- Calling the function -----------------------------------------------------------------------
select is(private.request_recipe_photo_cleanup(), false, 'without the Vault secrets, nothing is called');
select is(
  (select schedule from cron.job where jobname = 'recipe-photo-cleanup'), '*/15 * * * *', 'the sweep runs every 15 minutes');

select * from finish();
rollback;
