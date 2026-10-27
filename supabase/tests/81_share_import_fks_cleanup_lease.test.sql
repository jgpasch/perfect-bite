-- Share imports' foreign keys (a deleted household takes its share imports, a deleted list leaves
-- list_id null) and photo-cleanup's 10-minute claim lease over all three queues.
begin;
create extension if not exists pgtap with schema extensions;
select plan(37);

-- Fixtures (as postgres) ---------------------------------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('81818181-0000-4000-8000-000000000001', 'fk@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name) values
  ('81818181-0000-4000-8000-0000000000a1', 'Home'),
  ('81818181-0000-4000-8000-0000000000a2', 'Cabin');
insert into public.lists (id, household_id, name, position) values
  ('81818181-0000-4000-8000-0000000000b1', '81818181-0000-4000-8000-0000000000a1', 'Groceries', 1),
  ('81818181-0000-4000-8000-0000000000b2', '81818181-0000-4000-8000-0000000000a1', 'Party', 2);

create function pg_temp.share(p_id text, p_household text, p_list text) returns void language sql as $$
  insert into public.share_imports (id, user_id, household_id, list_id, add_to_list, url, url_key, payload_hash)
  values (p_id::uuid, '81818181-0000-4000-8000-000000000001', p_household::uuid, p_list::uuid, p_list is not null,
          'https://a.test/' || p_id, 'a.test/' || p_id, '\x01');
$$;

-- The keys ----------------------------------------------------------------------------------------
select is(
  (select string_agg(format('%s -> %s del=%s', conname, confrelid::regclass, confdeltype), ', ' order by conname)
   from pg_constraint
   where conrelid = 'public.share_imports'::regclass and contype = 'f'
     and conname in ('share_imports_household_id_fkey', 'share_imports_list_id_fkey')),
  'share_imports_household_id_fkey -> households del=c, share_imports_list_id_fkey -> lists del=n',
  'household_id cascades and list_id is set null');

select throws_ok(
  $$ select pg_temp.share('81818181-0000-4000-8000-0000000000c9', '81818181-0000-4000-8000-0000000000ff', null) $$,
  '23503', null, 'a share import can''t name a household that doesn''t exist');
select throws_ok(
  $$ select pg_temp.share('81818181-0000-4000-8000-0000000000c9', '81818181-0000-4000-8000-0000000000a1',
                          '81818181-0000-4000-8000-0000000000ff') $$,
  '23503', null, 'or a list that doesn''t exist');

select pg_temp.share('81818181-0000-4000-8000-0000000000c1', '81818181-0000-4000-8000-0000000000a1', '81818181-0000-4000-8000-0000000000b1');
select pg_temp.share('81818181-0000-4000-8000-0000000000c2', '81818181-0000-4000-8000-0000000000a1', '81818181-0000-4000-8000-0000000000b2');
select pg_temp.share('81818181-0000-4000-8000-0000000000c3', '81818181-0000-4000-8000-0000000000a1', null);
select pg_temp.share('81818181-0000-4000-8000-0000000000c4', '81818181-0000-4000-8000-0000000000a2', null);

-- A deleted list: its share imports stay, with no list.
delete from public.lists where id = '81818181-0000-4000-8000-0000000000b1';
select results_eq(
  $$ select id::text, list_id::text, add_to_list from public.share_imports
     where id::text like '81818181-%' order by id $$,
  $$ values ('81818181-0000-4000-8000-0000000000c1', null::text, true),
            ('81818181-0000-4000-8000-0000000000c2', '81818181-0000-4000-8000-0000000000b2', true),
            ('81818181-0000-4000-8000-0000000000c3', null::text, false),
            ('81818181-0000-4000-8000-0000000000c4', null::text, false) $$,
  'deleting a list clears list_id on its share imports and leaves the others alone');

-- A deleted household: its share imports go (the list's with it), the other household's stay.
delete from public.households where id = '81818181-0000-4000-8000-0000000000a1';
select results_eq(
  $$ select id::text from public.share_imports where id::text like '81818181-%' order by id $$,
  $$ values ('81818181-0000-4000-8000-0000000000c4') $$,
  'deleting a household deletes its share imports and only those');
select is(
  (select count(*)::int from public.lists where household_id = '81818181-0000-4000-8000-0000000000a1'), 0,
  '…and its lists went with it');

-- The cleanup leases ------------------------------------------------------------------------------
-- Each queue: two loose objects and a prefix with two objects under it, all queued long enough ago
-- and none pointed at by anything.
delete from private.recipe_photo_deletions;
delete from private.item_photo_deletions;
delete from private.recipe_page_deletions;

insert into storage.objects (bucket_id, name) values
  ('recipe-photos', 'p/1.jpg'), ('recipe-photos', 'p/2.jpg'), ('recipe-photos', 'h/x.jpg'), ('recipe-photos', 'h/y.jpg'),
  ('item-photos', 'p/1.jpg'), ('item-photos', 'p/2.jpg'), ('item-photos', 'h/x.jpg'), ('item-photos', 'h/y.jpg'),
  ('recipe-pages', 'p/1.jpg'), ('recipe-pages', 'p/2.jpg'), ('recipe-pages', 'h/x.jpg'), ('recipe-pages', 'h/y.jpg');
insert into private.recipe_photo_deletions (path, is_prefix, queued_at) values
  ('p/1.jpg', false, now() - interval '2 hours'), ('p/2.jpg', false, now() - interval '2 hours'), ('h/', true, now() - interval '2 hours');
insert into private.item_photo_deletions (path, is_prefix, queued_at) values
  ('p/1.jpg', false, now() - interval '2 hours'), ('p/2.jpg', false, now() - interval '2 hours'), ('h/', true, now() - interval '2 hours');
insert into private.recipe_page_deletions (path, is_prefix, queued_at) values
  ('p/1.jpg', false, now() - interval '2 hours'), ('p/2.jpg', false, now() - interval '2 hours'), ('h/', true, now() - interval '2 hours');

-- recipe-photos
select results_eq(
  $$ select name from public.claim_recipe_photo_deletions(1) $$,
  $$ values ('p/1.jpg') $$,
  'recipe photos: a claim with a limit of 1 gets the oldest entry');
select results_eq(
  $$ select name from public.claim_recipe_photo_deletions(10) $$,
  $$ values ('p/2.jpg'), ('h/x.jpg'), ('h/y.jpg') $$,
  'recipe photos: the next claim right after skips it and gets the rest, the prefix''s objects included');
select is(
  (select count(*)::int from public.claim_recipe_photo_deletions(10)), 0,
  'recipe photos: a third claim straight after gets nothing');
select is(
  (select count(*)::int from private.recipe_photo_deletions where claimed_at = now()), 3,
  'recipe photos: every claimed entry is marked claimed now');
update private.recipe_photo_deletions set claimed_at = now() - interval '9 minutes' where path = 'p/1.jpg';
select is(
  (select count(*)::int from public.claim_recipe_photo_deletions(10)), 0,
  'recipe photos: an entry claimed 9 minutes ago is still leased');
update private.recipe_photo_deletions set claimed_at = now() - interval '11 minutes' where path in ('p/1.jpg', 'h/');
select results_eq(
  $$ select name from public.claim_recipe_photo_deletions(10) $$,
  $$ values ('p/1.jpg'), ('h/x.jpg'), ('h/y.jpg') $$,
  'recipe photos: once the lease is up (a run that never completed), the entries are claimed again');
select is(
  (select claimed_at from private.recipe_photo_deletions where path = 'p/1.jpg'), now(),
  'recipe photos: and their lease starts over');
select lives_ok(
  $$ select public.complete_recipe_photo_deletions(array(select id from private.recipe_photo_deletions)) $$,
  'recipe photos: completing claimed entries works');
select is((select count(*)::int from private.recipe_photo_deletions), 0, 'recipe photos: completed entries are gone');
select is(
  (select count(*)::int from public.claim_recipe_photo_deletions(10, '1 hour')), 0,
  'recipe photos: nothing left to claim');

-- item-photos
select results_eq(
  $$ select name from public.claim_item_photo_deletions(1) $$,
  $$ values ('p/1.jpg') $$,
  'item photos: a claim with a limit of 1 gets the oldest entry');
select results_eq(
  $$ select name from public.claim_item_photo_deletions(10) $$,
  $$ values ('p/2.jpg'), ('h/x.jpg'), ('h/y.jpg') $$,
  'item photos: the next claim right after skips it and gets the rest');
select is(
  (select count(*)::int from public.claim_item_photo_deletions(10)), 0,
  'item photos: a third claim straight after gets nothing');
select is(
  (select count(*)::int from private.item_photo_deletions where claimed_at = now()), 3,
  'item photos: every claimed entry is marked claimed now');
update private.item_photo_deletions set claimed_at = now() - interval '9 minutes' where path = 'p/1.jpg';
select is(
  (select count(*)::int from public.claim_item_photo_deletions(10)), 0,
  'item photos: an entry claimed 9 minutes ago is still leased');
update private.item_photo_deletions set claimed_at = now() - interval '11 minutes' where path = 'p/1.jpg';
select results_eq(
  $$ select name from public.claim_item_photo_deletions(10) $$,
  $$ values ('p/1.jpg') $$,
  'item photos: once the lease is up, the entry is claimed again');
select lives_ok(
  $$ select public.complete_item_photo_deletions(array(select id from private.item_photo_deletions)) $$,
  'item photos: completing claimed entries works');
select is((select count(*)::int from private.item_photo_deletions), 0, 'item photos: completed entries are gone');

-- recipe-pages
select results_eq(
  $$ select name from public.claim_recipe_page_deletions(1) $$,
  $$ values ('p/1.jpg') $$,
  'recipe pages: a claim with a limit of 1 gets the oldest entry');
select results_eq(
  $$ select name from public.claim_recipe_page_deletions(10) $$,
  $$ values ('p/2.jpg'), ('h/x.jpg'), ('h/y.jpg') $$,
  'recipe pages: the next claim right after skips it and gets the rest');
select is(
  (select count(*)::int from public.claim_recipe_page_deletions(10)), 0,
  'recipe pages: a third claim straight after gets nothing');
select is(
  (select count(*)::int from private.recipe_page_deletions where claimed_at = now()), 3,
  'recipe pages: every claimed entry is marked claimed now');
update private.recipe_page_deletions set claimed_at = now() - interval '9 minutes' where path = 'p/1.jpg';
select is(
  (select count(*)::int from public.claim_recipe_page_deletions(10)), 0,
  'recipe pages: an entry claimed 9 minutes ago is still leased');
update private.recipe_page_deletions set claimed_at = now() - interval '11 minutes' where path = 'p/1.jpg';
select results_eq(
  $$ select name from public.claim_recipe_page_deletions(10) $$,
  $$ values ('p/1.jpg') $$,
  'recipe pages: once the lease is up, the entry is claimed again');
select lives_ok(
  $$ select public.complete_recipe_page_deletions(array(select id from private.recipe_page_deletions)) $$,
  'recipe pages: completing claimed entries works');
select is((select count(*)::int from private.recipe_page_deletions), 0, 'recipe pages: completed entries are gone');

-- A leased entry is still dropped when nothing is left to delete (its object is gone).
insert into private.recipe_photo_deletions (path, queued_at, claimed_at) values ('p/9.jpg', now() - interval '2 hours', now());
select is(
  (select count(*)::int from public.claim_recipe_photo_deletions(10)), 0, 'a leased entry whose object is gone isn''t claimed');
select is((select count(*)::int from private.recipe_photo_deletions), 0, '…and it''s dropped as before');

-- An entry younger than the minimum age isn't claimed or leased.
insert into private.item_photo_deletions (path, queued_at) values ('p/2.jpg', now());
select is(
  (select count(*)::int from public.claim_item_photo_deletions(10)), 0, 'an entry younger than the minimum age isn''t claimed');
select is(
  (select claimed_at from private.item_photo_deletions where path = 'p/2.jpg'), null::timestamptz,
  '…and isn''t leased, so it''s claimed as soon as it''s due');
select results_eq(
  $$ select name from public.claim_item_photo_deletions(10, '0 seconds') $$,
  $$ values ('p/2.jpg') $$,
  '…which it is');

select * from finish();
rollback;
