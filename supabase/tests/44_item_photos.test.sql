-- A photo on a list item (spec 4.4, 5): the item-photos bucket and its policies, list_items.photo_path's
-- check and apply_mutations, and the cleanup queue for changed, cleared, purged and deleted-household
-- photos, including household deletion through delete_household and admin.delete_user.
begin;
create extension if not exists pgtap with schema extensions;
select plan(49);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex and Jo share household A, with items IA1 and IA2; Sam owns household S, with item IS; Tia owns
-- household T, with item IT. A and S have one photo object each already.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'jo@test.local', 'authenticated', 'authenticated'),
  ('44444444-4444-4444-4444-444444444444', 'tia@test.local', 'authenticated', 'authenticated');

insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sam''s household'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Tia''s household');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'member', 2),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner', 1),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '44444444-4444-4444-4444-444444444444', 'owner', 1);
insert into public.lists (id, household_id, name, position) values
  ('a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Groceries', 1),
  ('a1000000-0000-7000-8000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Market', 2),
  ('b1000000-0000-7000-8000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sam''s list', 1),
  ('c1000000-0000-7000-8000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Tia''s list', 1);
insert into public.list_items (id, list_id, household_id, ingredient_name, display_name) values
  ('a2000000-0000-7000-8000-000000000001', 'a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'banana', 'Bananas'),
  ('a2000000-0000-7000-8000-000000000002', 'a1000000-0000-7000-8000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'banana', 'Bananas'),
  ('b2000000-0000-7000-8000-000000000001', 'b1000000-0000-7000-8000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'banana', 'Bananas'),
  ('c2000000-0000-7000-8000-000000000001', 'c1000000-0000-7000-8000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'banana', 'Bananas');
insert into storage.objects (bucket_id, name) values
  ('item-photos', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-000000000001.jpg'),
  ('item-photos', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/b2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-000000000009.jpg');

-- The bucket and the column ---------------------------------------------------------
select results_eq(
  $$ select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'item-photos' $$,
  $$ values (false, 2097152::bigint, array['image/jpeg']) $$,
  'item-photos is private, jpeg only, 2 MB');
select col_type_is('public', 'list_items', 'photo_path', 'text', 'photo_path is text');
select is(
  (select photo_path from public.list_items where id = 'a2000000-0000-7000-8000-000000000001'),
  null, 'an item has no photo to start with');

-- Storage policies -------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select results_eq(
  $$ select name from storage.objects where bucket_id = 'item-photos' $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-000000000001.jpg') $$,
  'a member sees their household''s item photos and no other household''s');
select lives_ok(
  $$ insert into storage.objects (bucket_id, name) values
     ('item-photos', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a2000000-0000-7000-8000-000000000002/d0000000-0000-7000-8000-000000000002.jpg') $$,
  'a member can upload under their household''s prefix');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values
     ('item-photos', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/b2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-000000000003.jpg') $$,
  '42501', null, 'a member can''t upload under another household''s prefix');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values
     ('item-photos', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/d0000000-0000-7000-8000-000000000003.jpg') $$,
  '42501', null, 'an upload outside <household>/<item>/<uuid>.jpg is refused');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values
     ('item-photos', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a2000000-0000-7000-8000-000000000002/d0000000-0000-7000-8000-000000000003.png') $$,
  '42501', null, 'a non-jpg name is refused');
update storage.objects set metadata = '{"x": 1}'
where name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-000000000001.jpg';
reset role;
select is(
  (select metadata from storage.objects
   where name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-000000000001.jpg'),
  null, 'nobody can update an item photo (a new photo is a new object)');

-- Sam can't see or delete household A's photos; Jo, its other member, can delete them.
select set_config('storage.allow_delete_query', 'true', true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is(
  (select count(*) from storage.objects where bucket_id = 'item-photos' and name like 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/%'),
  0::bigint, 'another household''s member can''t read the item photos');
delete from storage.objects where bucket_id = 'item-photos' and name like 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/%';
reset role;
select is(
  (select count(*) from storage.objects where bucket_id = 'item-photos' and name like 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/%'),
  2::bigint, 'another household''s member can''t delete them');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
delete from storage.objects
where bucket_id = 'item-photos'
  and name = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a2000000-0000-7000-8000-000000000002/d0000000-0000-7000-8000-000000000002.jpg';
reset role;
select is(
  (select count(*) from storage.objects where bucket_id = 'item-photos' and name like 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/%'),
  1::bigint, 'a member can delete under their household''s prefix');
select set_config('storage.allow_delete_query', 'false', true);
set local role authenticated;

select throws_ok(
  $$ select * from private.item_photo_deletions $$, '42501', null, 'a member can''t read the cleanup queue');
select throws_ok(
  $$ select * from public.claim_item_photo_deletions(10, '0 seconds') $$, '42501', null, 'a member can''t claim deletions');
select throws_ok(
  $$ select public.complete_item_photo_deletions(array[1::bigint]) $$, '42501', null, 'a member can''t complete deletions');

set local role anon;
select is(
  (select count(*) from storage.objects where bucket_id = 'item-photos'), 0::bigint, 'anon sees no item photos');
reset role;

-- photo_path's check -------------------------------------------------------------------
select lives_ok(
  $$ update public.list_items
     set photo_path = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-000000000001.jpg'
     where id = 'a2000000-0000-7000-8000-000000000001' $$,
  'a path in the item''s household under its own id is accepted');
select throws_ok(
  $$ update public.list_items
     set photo_path = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/a2000000-0000-7000-8000-000000000002/d0000000-0000-7000-8000-000000000004.jpg'
     where id = 'a2000000-0000-7000-8000-000000000002' $$,
  '23514', null, 'a path whose household isn''t the item''s is refused');
select throws_ok(
  $$ update public.list_items
     set photo_path = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-000000000004.jpg'
     where id = 'a2000000-0000-7000-8000-000000000002' $$,
  '23514', null, 'a path under another item''s id is refused');
select throws_ok(
  $$ update public.list_items
     set photo_path = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a2000000-0000-7000-8000-000000000002/d0000000-0000-7000-8000-000000000004.png'
     where id = 'a2000000-0000-7000-8000-000000000002' $$,
  '23514', null, 'a path that isn''t a .jpg is refused');
select throws_ok(
  $$ update public.list_items
     set photo_path = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a2000000-0000-7000-8000-000000000002/photo.jpg'
     where id = 'a2000000-0000-7000-8000-000000000002' $$,
  '23514', null, 'a file name that isn''t a uuid is refused');
select throws_ok(
  $$ update public.list_items
     set photo_path = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA/a2000000-0000-7000-8000-000000000002/d0000000-0000-7000-8000-000000000004.jpg'
     where id = 'a2000000-0000-7000-8000-000000000002' $$,
  '23514', null, 'an uppercase household prefix is refused');

-- Through apply_mutations, as the app writes it: applied with its own clock, or rejected.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is(
  public.apply_mutations($$ [{ "table": "list_items", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000001-0000-alex",
    "fields": { "photo_path": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a2000000-0000-7000-8000-000000000002/d0000000-0000-7000-8000-000000000006.jpg" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Alex sets photo_path through apply_mutations');
select is(
  public.apply_mutations($$ [{ "table": "list_items", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000001-0001-alex",
    "fields": { "photo_path": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/a2000000-0000-7000-8000-000000000002/d0000000-0000-7000-8000-000000000006.jpg" } }] $$),
  '[{"status": "rejected", "code": "23514", "message": "new row for relation \"list_items\" violates check constraint \"list_items_photo_path_shape\""}]'::jsonb,
  'another household''s path is rejected through apply_mutations');
-- Jo's later note and Alex's older photo_path merge per field: both stick.
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is(
  public.apply_mutations($$ [{ "table": "list_items", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000002-0000-jo00",
    "fields": { "note": "the green jar" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Jo sets the note');
reset role;
select results_eq(
  $$ select photo_path, note, field_clock ->> 'photo_path', field_clock ->> 'note'
     from public.list_items where id = 'a2000000-0000-7000-8000-000000000002' $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a2000000-0000-7000-8000-000000000002/d0000000-0000-7000-8000-000000000006.jpg',
             'the green jar', '1760000000001-0000-alex', '1760000000002-0000-jo00') $$,
  'photo_path is stored with its own clock, merged per field with the note');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is(
  public.apply_mutations($$ [{ "table": "list_items", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000003-0000-alex",
    "fields": { "photo_path": null } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Alex clears photo_path (null) through apply_mutations');
reset role;
select is(
  (select photo_path from public.list_items where id = 'a2000000-0000-7000-8000-000000000002'),
  null, 'the null is stored');
delete from private.item_photo_deletions;

-- Queueing for cleanup -------------------------------------------------------------------
select is((select count(*) from private.item_photo_deletions), 0::bigint, 'nothing is queued to start with');

update public.list_items set display_name = 'Ripe bananas' where id = 'a2000000-0000-7000-8000-000000000001';
select is((select count(*) from private.item_photo_deletions), 0::bigint, 'another column''s change queues nothing');

update public.list_items
set photo_path = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-000000000005.jpg'
where id = 'a2000000-0000-7000-8000-000000000001';
select results_eq(
  $$ select path, is_prefix from private.item_photo_deletions $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-000000000001.jpg', false) $$,
  'a changed photo queues the old object');

update public.list_items set photo_path = null where id = 'a2000000-0000-7000-8000-000000000001';
select results_eq(
  $$ select path from private.item_photo_deletions order by id $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-000000000001.jpg'),
            ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-000000000005.jpg') $$,
  'a cleared photo queues the old object');
select is((select count(*) from private.recipe_photo_deletions), 0::bigint, 'item photos don''t go in the recipe queue');

-- The sweep -------------------------------------------------------------------------------
select is(
  (select count(*) from public.claim_item_photo_deletions(10, '1 hour')),
  0::bigint, 'an entry younger than the minimum age isn''t claimed yet');
-- d…05 was never uploaded: its entry is dropped. d…01 is still there and nothing points at it.
select results_eq(
  $$ select name from public.claim_item_photo_deletions(10, '0 seconds') $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-000000000001.jpg') $$,
  'claiming returns an unreferenced object');
select is((select count(*) from private.item_photo_deletions), 1::bigint, 'an entry whose object is gone is dropped');

-- Undo puts the old photo back: its entry is dropped rather than deleted.
update public.list_items
set photo_path = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-000000000001.jpg'
where id = 'a2000000-0000-7000-8000-000000000001';
select is(
  (select count(*) from public.claim_item_photo_deletions(10, '0 seconds')),
  0::bigint, 'an object an item points at again isn''t claimed');
select is((select count(*) from private.item_photo_deletions), 0::bigint, '…and its entry is dropped');

-- A purged item (its row deleted) queues its object.
delete from public.list_items where id = 'a2000000-0000-7000-8000-000000000001';
select results_eq(
  $$ select queue_id, name from public.claim_item_photo_deletions(10, '0 seconds') $$,
  $$ select id, path from private.item_photo_deletions $$,
  'a purged item''s object is queued and claimed');
select lives_ok(
  $$ select public.complete_item_photo_deletions(array(select id from private.item_photo_deletions)) $$,
  'completing works');
select is((select count(*) from private.item_photo_deletions), 0::bigint, 'completed entries are gone');

-- Deleting a household queues its prefix and its items' photos.
update public.list_items
set photo_path = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/b2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-000000000009.jpg'
where id = 'b2000000-0000-7000-8000-000000000001';
insert into storage.objects (bucket_id, name) values
  ('item-photos', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/b2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-000000000008.jpg');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select lives_ok($$ select public.delete_household('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') $$, 'Sam deletes household S');
reset role;
select results_eq(
  $$ select path, is_prefix from private.item_photo_deletions order by is_prefix, path $$,
  $$ values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/b2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-000000000009.jpg', false),
            ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/', true) $$,
  'a deleted household queues its items'' photos and its whole prefix');
select results_eq(
  $$ select name from public.claim_item_photo_deletions(10, '0 seconds') where queue_id = (select id from private.item_photo_deletions where is_prefix) $$,
  $$ values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/b2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-000000000008.jpg'),
            ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/b2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-000000000009.jpg') $$,
  'the prefix stands for every object under it, a photo or a stray upload');
delete from private.item_photo_deletions;

-- Deleting an account that is a household's only member deletes it too, and queues its photos.
update public.list_items
set photo_path = 'cccccccc-cccc-cccc-cccc-cccccccccccc/c2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-00000000000c.jpg'
where id = 'c2000000-0000-7000-8000-000000000001';
select lives_ok($$ select admin.delete_user('44444444-4444-4444-4444-444444444444', 'test') $$, 'admin.delete_user still works');
select results_eq(
  $$ select path, is_prefix from private.item_photo_deletions order by is_prefix, path $$,
  $$ values ('cccccccc-cccc-cccc-cccc-cccccccccccc/c2000000-0000-7000-8000-000000000001/d0000000-0000-7000-8000-00000000000c.jpg', false),
            ('cccccccc-cccc-cccc-cccc-cccccccccccc/', true) $$,
  'the deleted account''s household queues its items'' photos and its prefix');

-- Calling the function -----------------------------------------------------------------------
select is(private.request_recipe_photo_cleanup(), false, 'without the Vault secrets, nothing is called');
delete from private.recipe_photo_deletions;
select vault.create_secret('http://host.docker.internal:55321', 'project_url');
select vault.create_secret('test-key', 'photo_cleanup_key');
select is(private.request_recipe_photo_cleanup(), true, 'with only item photos queued, photo-cleanup is called');
delete from private.item_photo_deletions;
select is(private.request_recipe_photo_cleanup(), false, 'with both queues empty, nothing is called');

select * from finish();
rollback;
