-- AI photos (spec 4.12, 5, 6.11): the recipe_photo_ai feature, private.recipe_photo_ai and its
-- reserve / complete / release functions, the global cap, and how a completed photo meets the
-- recipe-photos cleanup queue. now() is fixed within the transaction, so ages are set by hand.
begin;
create extension if not exists pgtap with schema extensions;
select plan(43);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex owns household A, with recipes R1, R2, R3, R4 and the deleted D. Sam owns household S.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sam''s household');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner', 1);
insert into public.recipes (id, household_id, name, deleted_at) values
  ('a4000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Blueberry bread', null),
  ('a4000000-0000-7000-8000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tacos', null),
  ('a4000000-0000-7000-8000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Soup', null),
  ('a4000000-0000-7000-8000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Salad', null),
  ('a4000000-0000-7000-8000-00000000000d', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Gone', now());
delete from private.recipe_photo_ai_daily_total;

-- The feature -----------------------------------------------------------------
select ok(exists (select 1 from public.plan_features where plan_id = 'plus' and feature = 'recipe_photo_ai')
  and exists (select 1 from public.plan_features where plan_id = 'unlimited' and feature = 'recipe_photo_ai'),
  'plus and unlimited have recipe_photo_ai');
select ok(not exists (select 1 from public.plan_features
                      where plan_id not in ('plus', 'unlimited') and feature = 'recipe_photo_ai'),
  'none and basic don''t');

-- Access ----------------------------------------------------------------------
select ok(
  not has_table_privilege('authenticated', 'private.recipe_photo_ai', 'select')
  and not has_table_privilege('authenticated', 'private.recipe_photo_ai', 'insert')
  and not has_table_privilege('authenticated', 'private.recipe_photo_ai', 'update')
  and not has_table_privilege('authenticated', 'private.recipe_photo_ai', 'delete')
  and not has_table_privilege('anon', 'private.recipe_photo_ai', 'select')
  and not has_table_privilege('anon', 'private.recipe_photo_ai', 'insert'),
  'clients have no privileges on the table');
select ok(
  not has_table_privilege('authenticated', 'private.recipe_photo_ai_daily_total', 'select')
  and not has_table_privilege('anon', 'private.recipe_photo_ai_daily_total', 'select'),
  'clients can''t read the daily total');
select ok(
  not has_function_privilege('authenticated', 'public.reserve_recipe_photo_ai(uuid, uuid, integer)', 'execute')
  and not has_function_privilege('anon', 'public.reserve_recipe_photo_ai(uuid, uuid, integer)', 'execute')
  and has_function_privilege('service_role', 'public.reserve_recipe_photo_ai(uuid, uuid, integer)', 'execute'),
  'only service_role can reserve');
select ok(
  not has_function_privilege('authenticated', 'public.complete_recipe_photo_ai(uuid, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.complete_recipe_photo_ai(uuid, text, text)', 'execute')
  and has_function_privilege('service_role', 'public.complete_recipe_photo_ai(uuid, text, text)', 'execute'),
  'only service_role can complete');
select ok(
  not has_function_privilege('authenticated', 'public.release_recipe_photo_ai(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.release_recipe_photo_ai(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.release_recipe_photo_ai(uuid)', 'execute'),
  'only service_role can release');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select * from private.recipe_photo_ai $$, '42501', null, 'a member can''t read the table');
select throws_ok(
  $$ select * from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000001', 500) $$,
  '42501', null, 'a member can''t reserve');
select throws_ok(
  $$ select public.release_recipe_photo_ai('a4000000-0000-7000-8000-000000000001') $$,
  '42501', null, 'a member can''t release');
reset role;

set local role service_role;
select results_eq(
  $$ select * from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000004', 500) $$,
  $$ values ('ok'::text, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid) $$,
  'service_role can reserve');
reset role;

-- Reserve ---------------------------------------------------------------------
select results_eq(
  $$ select * from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000001', 500) $$,
  $$ values ('ok'::text, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid) $$,
  'a member reserves a recipe with no AI photo, getting its household');
select results_eq(
  $$ select household_id, created_by, status, description, path from private.recipe_photo_ai
     where recipe_id = 'a4000000-0000-7000-8000-000000000001' $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, '11111111-1111-1111-1111-111111111111'::uuid,
             'pending'::text, null::text, null::text) $$,
  'the reservation is a pending row by the caller');
select results_eq(
  $$ select * from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000001', 500) $$,
  $$ values ('already_generated'::text, null::uuid) $$,
  'a second reserve while the first is pending is already_generated');

-- Release
select lives_ok($$ select public.release_recipe_photo_ai('a4000000-0000-7000-8000-000000000001') $$, 'release runs');
select is_empty($$ select 1 from private.recipe_photo_ai where recipe_id = 'a4000000-0000-7000-8000-000000000001' $$,
  'release deletes the pending row');
select results_eq(
  $$ select status from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000001', 500) $$,
  $$ values ('ok'::text) $$,
  'a released recipe can be reserved again');

-- A stale pending row
update private.recipe_photo_ai set created_at = now() - interval '9 minutes 59 seconds'
  where recipe_id = 'a4000000-0000-7000-8000-000000000001';
select results_eq(
  $$ select status from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000001', 500) $$,
  $$ values ('already_generated'::text) $$,
  'a pending row under 10 minutes old still holds the slot');
update private.recipe_photo_ai set created_at = now() - interval '10 minutes 1 second', created_by = null
  where recipe_id = 'a4000000-0000-7000-8000-000000000001';
select results_eq(
  $$ select status from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000001', 500) $$,
  $$ values ('ok'::text) $$,
  'a pending row over 10 minutes old is replaced');
select results_eq(
  $$ select created_at = now(), created_by, status from private.recipe_photo_ai
     where recipe_id = 'a4000000-0000-7000-8000-000000000001' $$,
  $$ values (true, '11111111-1111-1111-1111-111111111111'::uuid, 'pending'::text) $$,
  'the replaced row is a fresh pending one by the caller');

-- Not found
select results_eq(
  $$ select * from public.reserve_recipe_photo_ai('22222222-2222-2222-2222-222222222222', 'a4000000-0000-7000-8000-000000000002', 500) $$,
  $$ values ('not_found'::text, null::uuid) $$,
  'someone outside the household gets not_found');
select results_eq(
  $$ select status from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-00000000000d', 500) $$,
  $$ values ('not_found'::text) $$,
  'a deleted recipe is not_found');
select results_eq(
  $$ select status from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-0000000000ff', 500) $$,
  $$ values ('not_found'::text) $$,
  'an unknown recipe is not_found');
select is_empty(
  $$ select 1 from private.recipe_photo_ai where recipe_id in
       ('a4000000-0000-7000-8000-000000000002', 'a4000000-0000-7000-8000-00000000000d') $$,
  'not_found reserves nothing');

select throws_ok(
  $$ select * from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000002', -1) $$,
  '22023', null, 'a negative cap is refused');

-- Complete --------------------------------------------------------------------
select is(
  public.complete_recipe_photo_ai('a4000000-0000-7000-8000-000000000001', 'A golden loaf, sliced',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a4000000-0000-7000-8000-000000000001/c1000000-0000-7000-8000-000000000001.jpg'),
  true, 'complete finds the pending slot');
select results_eq(
  $$ select status, description, path from private.recipe_photo_ai where recipe_id = 'a4000000-0000-7000-8000-000000000001' $$,
  $$ values ('done'::text, 'A golden loaf, sliced'::text,
             'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a4000000-0000-7000-8000-000000000001/c1000000-0000-7000-8000-000000000001.jpg'::text) $$,
  'the slot is done with its description and path');
select results_eq(
  $$ select path, is_prefix from private.recipe_photo_deletions $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a4000000-0000-7000-8000-000000000001/c1000000-0000-7000-8000-000000000001.jpg'::text, false) $$,
  'complete queues the new object for cleanup');
select results_eq(
  $$ select status from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000001', 500) $$,
  $$ values ('already_generated'::text) $$,
  'a recipe with a done photo is already_generated');

update public.recipes
  set photo_path = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a4000000-0000-7000-8000-000000000001/c1000000-0000-7000-8000-000000000001.jpg'
  where id = 'a4000000-0000-7000-8000-000000000001';
update public.recipes set photo_path = null where id = 'a4000000-0000-7000-8000-000000000001';
select results_eq(
  $$ select status from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000001', 500) $$,
  $$ values ('already_generated'::text) $$,
  'still already_generated after the photo was removed');
update private.recipe_photo_ai set created_at = now() - interval '1 day'
  where recipe_id = 'a4000000-0000-7000-8000-000000000001';
select results_eq(
  $$ select status from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000001', 500) $$,
  $$ values ('already_generated'::text) $$,
  'a done row never goes stale');
do $$ begin perform public.release_recipe_photo_ai('a4000000-0000-7000-8000-000000000001'); end $$;
select results_eq(
  $$ select status from private.recipe_photo_ai where recipe_id = 'a4000000-0000-7000-8000-000000000001' $$,
  $$ values ('done'::text) $$,
  'release leaves a done row alone');

select is(
  public.complete_recipe_photo_ai('a4000000-0000-7000-8000-000000000003', 'Soup',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a4000000-0000-7000-8000-000000000003/c1000000-0000-7000-8000-000000000003.jpg'),
  false, 'complete with no pending slot answers false');
select ok(
  exists (select 1 from private.recipe_photo_deletions
          where path = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a4000000-0000-7000-8000-000000000003/c1000000-0000-7000-8000-000000000003.jpg')
  and not exists (select 1 from private.recipe_photo_ai where recipe_id = 'a4000000-0000-7000-8000-000000000003'),
  'it still queues the object, and makes no row');
select throws_ok(
  $$ select public.complete_recipe_photo_ai('a4000000-0000-7000-8000-000000000001', 'x', null) $$,
  '22023', null, 'complete needs a path');

-- The global cap --------------------------------------------------------------
-- Today: R4, then R1 three times (two reserves, one replacing a stale row) = 4 photos.
select is((select photos from private.recipe_photo_ai_daily_total), 4, 'each ok reserve counts one photo today');
select results_eq(
  $$ select * from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000002', 4) $$,
  $$ values ('global_cap'::text, null::uuid) $$,
  'at the cap, a reserve is global_cap');
select ok(
  (select photos from private.recipe_photo_ai_daily_total) = 4
  and not exists (select 1 from private.recipe_photo_ai where recipe_id = 'a4000000-0000-7000-8000-000000000002'),
  'a refused call uses no budget and reserves nothing');
select results_eq(
  $$ select status from public.reserve_recipe_photo_ai('11111111-1111-1111-1111-111111111111', 'a4000000-0000-7000-8000-000000000002', 5) $$,
  $$ values ('ok'::text) $$,
  'under the cap it reserves');

-- Cleanup ---------------------------------------------------------------------
-- R2's photo is set as its photo_path, R3's never is: claim drops R2's entry and deletes R3's.
do $$ begin perform public.complete_recipe_photo_ai('a4000000-0000-7000-8000-000000000002', 'Tacos',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a4000000-0000-7000-8000-000000000002/c1000000-0000-7000-8000-000000000002.jpg'); end $$;
delete from private.recipe_photo_deletions
  where path not in (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a4000000-0000-7000-8000-000000000002/c1000000-0000-7000-8000-000000000002.jpg',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a4000000-0000-7000-8000-000000000003/c1000000-0000-7000-8000-000000000003.jpg');
insert into storage.objects (bucket_id, name) values
  ('recipe-photos', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a4000000-0000-7000-8000-000000000002/c1000000-0000-7000-8000-000000000002.jpg'),
  ('recipe-photos', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a4000000-0000-7000-8000-000000000003/c1000000-0000-7000-8000-000000000003.jpg');
update public.recipes
  set photo_path = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a4000000-0000-7000-8000-000000000002/c1000000-0000-7000-8000-000000000002.jpg'
  where id = 'a4000000-0000-7000-8000-000000000002';
select is(
  (select count(*) from public.claim_recipe_photo_deletions(10, '1 hour')), 0::bigint,
  'a just-completed photo isn''t claimed within the hour');
select results_eq(
  $$ select name from public.claim_recipe_photo_deletions(10, '0 seconds') $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a4000000-0000-7000-8000-000000000003/c1000000-0000-7000-8000-000000000003.jpg'::text) $$,
  'claim deletes the photo nothing points at, not the one set as photo_path');
select is_empty(
  $$ select 1 from private.recipe_photo_deletions
     where path = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/a4000000-0000-7000-8000-000000000002/c1000000-0000-7000-8000-000000000002.jpg' $$,
  'the set photo is dropped from the queue');

-- Cascade
delete from public.recipes where id = 'a4000000-0000-7000-8000-000000000002';
select is_empty($$ select 1 from private.recipe_photo_ai where recipe_id = 'a4000000-0000-7000-8000-000000000002' $$,
  'a purged recipe takes its row with it');

select * from finish();
rollback;
