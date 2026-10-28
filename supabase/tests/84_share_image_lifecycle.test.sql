-- Shared images: lifecycle and Dismiss (spec 5, 6.12, Q17): when a photo share's images are nulled
-- and its share-images prefix queued, share-imports-retention's image rules, dismiss_share_import,
-- Try again on a dismissed share, and the share-images sweep. now() is fixed within the transaction.
begin;
create extension if not exists pgtap with schema extensions;
select plan(53);

-- Fixtures (as postgres) ---------------------------------------------------------------------------
-- Alex shares into Home; Sam is another user; Kim shares into Away, deleted below.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-4111-8111-111111111111', 'alex@shareimages.test', 'authenticated', 'authenticated'),
  ('22222222-2222-4222-8222-222222222222', 'sam@shareimages.test', 'authenticated', 'authenticated'),
  ('33333333-3333-4333-8333-333333333333', 'kim@shareimages.test', 'authenticated', 'authenticated');
insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Home'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Away');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'owner', 1),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '33333333-3333-4333-8333-333333333333', 'member', 2),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'owner', 1);
delete from private.share_image_deletions;

create function pg_temp.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated;
create function pg_temp.job(p_id uuid) returns public.share_imports language sql as $$
  select * from public.share_imports where id = p_id
$$;
-- A one-page photo share of Alex's (or another user's) in Home, its image kept.
create function pg_temp.photo(p_id uuid, p_status text default 'received', p_user uuid default '11111111-1111-4111-8111-111111111111',
                              p_household uuid default 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
returns void language sql as $$
  insert into public.share_imports (id, user_id, household_id, add_to_list, kind, page_count, images, payload_hash, status)
  values (p_id, p_user, p_household, false, 'photo', 1, array[p_user::text || '/' || p_id::text || '/0.jpg'], '\x01', p_status)
$$;
-- How often a job's prefix is queued.
create function pg_temp.queued(p_id uuid, p_user uuid default '11111111-1111-4111-8111-111111111111') returns int
language sql as $$
  select count(*)::int from private.share_image_deletions
  where is_prefix and path = p_user::text || '/' || p_id::text || '/'
$$;
create function pg_temp.kept(p_id uuid) returns boolean language sql as $$
  select images is not null from public.share_imports where id = p_id
$$;

-- Becoming done ------------------------------------------------------------------------------------
select pg_temp.photo('d0000000-0000-4000-8000-000000000001', 'committing');
update public.share_imports set status = 'done' where id = 'd0000000-0000-4000-8000-000000000001';
select is(pg_temp.kept('d0000000-0000-4000-8000-000000000001'), false, 'a done photo share''s images are nulled');
select is(pg_temp.queued('d0000000-0000-4000-8000-000000000001'), 1, 'and its prefix is queued');
update public.share_imports set items_added = 2 where id = 'd0000000-0000-4000-8000-000000000001';
select is(pg_temp.queued('d0000000-0000-4000-8000-000000000001'), 1, 'a later update doesn''t queue it again');

select pg_temp.photo('d0000000-0000-4000-8000-000000000002', 'extracting');
update public.share_imports set status = 'extracted' where id = 'd0000000-0000-4000-8000-000000000002';
select is(pg_temp.kept('d0000000-0000-4000-8000-000000000002'), true, 'a share still under way keeps its images');
select is(pg_temp.queued('d0000000-0000-4000-8000-000000000002'), 0, 'and nothing is queued');

-- Failing ------------------------------------------------------------------------------------------
select pg_temp.photo('d0000000-0000-4000-8000-000000000003', 'extracting');
update public.share_imports
set status = 'failed', error_kind = 'permanent', error_code = 'not_a_recipe', metered_at = now()
where id = 'd0000000-0000-4000-8000-000000000003';
select is(pg_temp.kept('d0000000-0000-4000-8000-000000000003'), false, 'not_a_recipe once charged nulls the images');
select is(pg_temp.queued('d0000000-0000-4000-8000-000000000003'), 1, 'and queues the prefix');

select pg_temp.photo('d0000000-0000-4000-8000-000000000004', 'extracting');
update public.share_imports
set status = 'failed', error_kind = 'permanent', error_code = 'not_a_recipe'
where id = 'd0000000-0000-4000-8000-000000000004';
select is(pg_temp.kept('d0000000-0000-4000-8000-000000000004'), true, 'not_a_recipe before the charge keeps them (it can be tried again)');
select is(pg_temp.queued('d0000000-0000-4000-8000-000000000004'), 0, 'and queues nothing');

select pg_temp.photo('d0000000-0000-4000-8000-000000000005', 'extracting');
update public.share_imports
set status = 'failed', error_kind = 'transient', error_code = 'model_error', metered_at = now()
where id = 'd0000000-0000-4000-8000-000000000005';
select is(pg_temp.kept('d0000000-0000-4000-8000-000000000005'), true, 'another failure once charged keeps them');
select is(pg_temp.queued('d0000000-0000-4000-8000-000000000005'), 0, 'and queues nothing');

-- Deleting -----------------------------------------------------------------------------------------
select pg_temp.photo('d0000000-0000-4000-8000-000000000006');
delete from public.share_imports where id = 'd0000000-0000-4000-8000-000000000006';
select is(pg_temp.queued('d0000000-0000-4000-8000-000000000006'), 1, 'deleting a share with images queues its prefix');

select pg_temp.photo('d0000000-0000-4000-8000-000000000007', 'committing');
update public.share_imports set status = 'done' where id = 'd0000000-0000-4000-8000-000000000007';
delete from public.share_imports where id = 'd0000000-0000-4000-8000-000000000007';
select is(pg_temp.queued('d0000000-0000-4000-8000-000000000007'), 1, 'deleting one whose images were already queued doesn''t queue them twice');

insert into public.share_imports (id, user_id, household_id, add_to_list, url, url_key, payload_hash, status) values
  ('d0000000-0000-4000-8000-000000000008', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   false, 'https://a.test/x', 'a.test/x', '\x01', 'committing');
update public.share_imports set status = 'done' where id = 'd0000000-0000-4000-8000-000000000008';
delete from public.share_imports where id = 'd0000000-0000-4000-8000-000000000008';
select is(pg_temp.queued('d0000000-0000-4000-8000-000000000008'), 0, 'a link share queues nothing, done or deleted');

select pg_temp.photo('d0000000-0000-4000-8000-000000000009', 'received', '33333333-3333-4333-8333-333333333333');
delete from auth.users where id = '33333333-3333-4333-8333-333333333333';
select is(pg_temp.job('d0000000-0000-4000-8000-000000000009') is null, true, 'deleting the user deletes their share');
select is(pg_temp.queued('d0000000-0000-4000-8000-000000000009', '33333333-3333-4333-8333-333333333333'), 1,
  'and queues its images under the user''s id');

select pg_temp.photo('d0000000-0000-4000-8000-00000000000a', 'received', p_household => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
delete from public.households where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
select is(pg_temp.queued('d0000000-0000-4000-8000-00000000000a'), 1, 'deleting the household queues its shares'' images');

-- Retention ----------------------------------------------------------------------------------------
-- Failed 8 days ago, failed 6 days ago, waiting and 9 days old, waiting and 7 days old.
insert into public.share_imports (id, user_id, household_id, add_to_list, kind, page_count, images, payload_hash,
                                  status, error_kind, error_code, created_at, updated_at) values
  ('e0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   false, 'photo', 1, array['a/0.jpg'], '\x01', 'failed', 'transient', 'model_error', now() - interval '8 days', now() - interval '8 days'),
  ('e0000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   false, 'photo', 1, array['a/0.jpg'], '\x01', 'failed', 'transient', 'model_error', now() - interval '7 days', now() - interval '6 days'),
  ('e0000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   false, 'photo', 1, array['a/0.jpg'], '\x01', 'received', null, null, now() - interval '9 days', now() - interval '1 hour'),
  ('e0000000-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   false, 'photo', 1, array['a/0.jpg'], '\x01', 'received', null, null, now() - interval '7 days', now() - interval '1 hour');
insert into public.share_imports (id, user_id, household_id, add_to_list, url, url_key, payload_hash, page, status, created_at) values
  ('e0000000-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   false, 'https://a.test/y', 'a.test/y', '\x01', '{"html": "x"}', 'received', now() - interval '2 days');
select lives_ok($$ select private.share_imports_retention() $$, 'retention runs');
select is(
  array[pg_temp.kept('e0000000-0000-4000-8000-000000000001'), pg_temp.kept('e0000000-0000-4000-8000-000000000002'),
        pg_temp.kept('e0000000-0000-4000-8000-000000000003'), pg_temp.kept('e0000000-0000-4000-8000-000000000004')],
  array[false, true, false, true],
  'it nulls the images of a failure older than 7 days and of a share older than 8, and keeps the rest');
select is(
  array[pg_temp.queued('e0000000-0000-4000-8000-000000000001'), pg_temp.queued('e0000000-0000-4000-8000-000000000002'),
        pg_temp.queued('e0000000-0000-4000-8000-000000000003'), pg_temp.queued('e0000000-0000-4000-8000-000000000004')],
  array[1, 0, 1, 0],
  'and queues exactly those');
select is((pg_temp.job('e0000000-0000-4000-8000-000000000005')).page, null, 'it still purges a day-old page');
select lives_ok($$ select private.share_imports_retention() $$, 'running it again');
select is(pg_temp.queued('e0000000-0000-4000-8000-000000000001'), 1, 'queues nothing twice');

-- dismiss_share_import -----------------------------------------------------------------------------
-- F1 a failed photo share, F2 a failed link, W a waiting photo share.
select pg_temp.photo('f0000000-0000-4000-8000-000000000001', 'extracting');
update public.share_imports set status = 'failed', error_kind = 'transient', error_code = 'model_error'
where id = 'f0000000-0000-4000-8000-000000000001';
insert into public.share_imports (id, user_id, household_id, add_to_list, url, url_key, payload_hash, status, error_kind, error_code) values
  ('f0000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   false, 'https://a.test/z', 'a.test/z', '\x01', 'failed', 'permanent', 'daily_limit');
select pg_temp.photo('f0000000-0000-4000-8000-000000000003', 'received');

select ok(has_function_privilege('authenticated', 'public.dismiss_share_import(uuid)', 'execute'), 'a signed-in user can dismiss');
select ok(not has_function_privilege('anon', 'public.dismiss_share_import(uuid)', 'execute'), 'anon can''t');

set local role authenticated;
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
select throws_ok($$ select public.dismiss_share_import('f0000000-0000-4000-8000-000000000001') $$, 'P0002', 'not found',
  'another user can''t dismiss Alex''s share');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select throws_ok($$ select public.dismiss_share_import('f0000000-0000-4000-8000-0000000000ff') $$, 'P0002', 'not found',
  'an unknown id is not found');
select throws_ok($$ select public.dismiss_share_import('f0000000-0000-4000-8000-000000000003') $$, '55000', 'dismiss_refused',
  'a share that hasn''t failed can''t be dismissed');
select throws_ok($$ select public.dismiss_share_import('d0000000-0000-4000-8000-000000000001') $$, '55000', 'dismiss_refused',
  'nor a done one');
select is((select count(*)::int from public.my_share_imports where id = 'f0000000-0000-4000-8000-000000000001'), 1,
  'the failed share is in the view before');
select lives_ok($$ select public.dismiss_share_import('f0000000-0000-4000-8000-000000000001') $$, 'Alex dismisses a failed photo share');
select is((select count(*)::int from public.my_share_imports where id = 'f0000000-0000-4000-8000-000000000001'), 0,
  'and it leaves the view');
select lives_ok($$ select public.dismiss_share_import('f0000000-0000-4000-8000-000000000002') $$, 'and a failed link');
select lives_ok($$ select public.dismiss_share_import('f0000000-0000-4000-8000-000000000001') $$, 'dismissing again is harmless');
reset role;

select is((pg_temp.job('f0000000-0000-4000-8000-000000000001')).dismissed_at, now(), 'dismissed_at is set');
select is(pg_temp.kept('f0000000-0000-4000-8000-000000000001'), false, 'the photo share''s images are nulled');
select is(pg_temp.queued('f0000000-0000-4000-8000-000000000001'), 1, 'and queued once');
select is((pg_temp.job('f0000000-0000-4000-8000-000000000001')).status, 'failed', 'the row stays failed');
select is((pg_temp.job('f0000000-0000-4000-8000-000000000002')).dismissed_at, now(), 'the link is dismissed');
select is(pg_temp.queued('f0000000-0000-4000-8000-000000000002'), 0, 'with nothing to queue');
select is(
  array[(pg_temp.job('f0000000-0000-4000-8000-000000000003')).status, (pg_temp.job('f0000000-0000-4000-8000-000000000003')).dismissed_at::text],
  array['received', null],
  'the refused one is unchanged');
select is(pg_temp.kept('f0000000-0000-4000-8000-000000000003'), true, 'and keeps its images');

-- Try again on a dismissed share -------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select throws_ok($$ select public.retry_share_import('f0000000-0000-4000-8000-000000000002') $$, '55000', 'retry_refused',
  'a dismissed link can''t be tried again (its failure was retryable)');
select throws_ok($$ select public.retry_share_import('f0000000-0000-4000-8000-000000000001') $$, '55000', 'retry_refused',
  'nor a dismissed photo share');
reset role;
select is(
  (select array[status, error_kind, retries::text] from pg_temp.job('f0000000-0000-4000-8000-000000000002')),
  array['failed', 'permanent', '0'],
  'the refused retry changed nothing');

-- The sweep ----------------------------------------------------------------------------------------
delete from private.share_image_deletions;
insert into storage.objects (bucket_id, name) values
  ('share-images', 'u/j/0.jpg'), ('share-images', 'u/j/1.jpg'), ('share-images', 'u/k/0.jpg'),
  ('recipe-pages', 'u/j/2.jpg');
insert into private.share_image_deletions (path, is_prefix, queued_at) values
  ('u/j/', true, now() - interval '2 hours'),
  ('u/gone/', true, now() - interval '2 hours'),
  ('u/k/', true, now() - interval '5 minutes');

select ok(not has_function_privilege('authenticated', 'public.claim_share_image_deletions(integer, interval)', 'execute'),
  'a signed-in user can''t claim share-image deletions');
select ok(not has_function_privilege('authenticated', 'public.complete_share_image_deletions(bigint[])', 'execute'),
  'or complete them');
select ok(has_function_privilege('service_role', 'public.claim_share_image_deletions(integer, interval)', 'execute'),
  'the service role can');
select results_eq(
  $$ select name from public.claim_share_image_deletions(10) $$,
  $$ values ('u/j/0.jpg'), ('u/j/1.jpg') $$,
  'a claim returns the share-images objects under a due prefix, not another bucket''s or a prefix queued under an hour ago');
select is((select count(*)::int from private.share_image_deletions where path = 'u/gone/'), 0,
  'a prefix with nothing under it is dropped');
select is((select count(*)::int from public.claim_share_image_deletions(10)), 0, 'a claimed entry is leased');
select lives_ok(
  $$ select public.complete_share_image_deletions(array(select id from private.share_image_deletions where path = 'u/j/')) $$,
  'completing it works');
select results_eq($$ select path from private.share_image_deletions $$, $$ values ('u/k/') $$, 'only the entry not yet due is left');

select * from finish();
rollback;
