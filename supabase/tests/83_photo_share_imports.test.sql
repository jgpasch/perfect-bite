-- Photo shares (spec 5, 6.12): share_imports' kind check, the share-images bucket, the view's new
-- columns and dismissed rows, the photo branch of reserve_share_import, and Try again on a photo
-- share whose images are gone. now() is fixed within the transaction.
begin;
create extension if not exists pgtap with schema extensions;
select plan(43);

-- Fixtures (as postgres) ---------------------------------------------------------------------------
-- Alex shares into Home (unlimited); Sam is another user.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-4111-8111-111111111111', 'alex@photoshare.test', 'authenticated', 'authenticated'),
  ('22222222-2222-4222-8222-222222222222', 'sam@photoshare.test', 'authenticated', 'authenticated');
insert into public.households (id, name) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Home');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'owner', 1);
insert into public.household_plans (household_id, plan_id) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'unlimited');

create function pg_temp.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated;
create function pg_temp.job(p_id uuid) returns public.share_imports language sql as $$
  select * from public.share_imports where id = p_id
$$;
-- A photo share of Alex's with n pages, in the given state.
create function pg_temp.photo(p_id uuid, p_pages integer, p_images text[], p_status text default 'received',
                              p_error_kind text default null, p_dismissed timestamptz default null)
returns void language sql as $$
  insert into public.share_imports (id, user_id, household_id, add_to_list, kind, page_count, images, payload_hash,
                                    status, error_kind, error_code, dismissed_at)
  values (p_id, '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false, 'photo',
          p_pages, p_images, '\x01', p_status, p_error_kind,
          case when p_error_kind is not null then 'model_error' end, p_dismissed)
$$;
-- Puts a job under a known lease, as claim_share_import would.
create function pg_temp.lease(p_id uuid) returns void language sql as $$
  update public.share_imports
  set status = 'extracting', lease_token = 'f0000000-0000-4000-8000-0000000000ff', lease_expires_at = now() + interval '2 minutes'
  where id = p_id
$$;
create function pg_temp.photo_imports_today() returns int language sql as $$
  select coalesce(sum(imports), 0)::int from private.recipe_photo_import_usage
  where user_id = '11111111-1111-4111-8111-111111111111' and day = (now() at time zone 'utc')::date
$$;
create function pg_temp.link_imports_today() returns int language sql as $$
  select coalesce(sum(imports), 0)::int from private.recipe_import_usage
  where user_id = '11111111-1111-4111-8111-111111111111' and day = (now() at time zone 'utc')::date
$$;
create function pg_temp.household_imports() returns int language sql as $$
  select private.monthly_usage('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'recipe_import')
$$;
delete from private.recipe_import_usage where user_id = '11111111-1111-4111-8111-111111111111';
delete from private.recipe_photo_import_usage where user_id = '11111111-1111-4111-8111-111111111111';

-- The kind check -----------------------------------------------------------------------------------
select col_default_is('public', 'share_imports', 'kind', 'link'::text, 'kind defaults to link');
select col_is_null('public', 'share_imports', 'url', 'url is nullable');
select col_is_null('public', 'share_imports', 'url_key', 'url_key is nullable');

insert into public.share_imports (id, user_id, household_id, add_to_list, url, url_key, title, payload_hash) values
  ('b0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   false, 'https://a.test/pasta', 'a.test/pasta', 'Pasta', '\x01');
select is((pg_temp.job('b0000000-0000-4000-8000-000000000001')).kind, 'link', 'a share inserted without a kind is a link');

select throws_ok(
  $$ insert into public.share_imports (id, user_id, household_id, add_to_list, url, payload_hash)
     values (gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false, 'https://a.test/x', '\x01') $$,
  '23514', null, 'a link needs url_key');
select throws_ok(
  $$ insert into public.share_imports (id, user_id, household_id, add_to_list, url_key, payload_hash)
     values (gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false, 'a.test/x', '\x01') $$,
  '23514', null, 'and url');
select throws_ok(
  $$ insert into public.share_imports (id, user_id, household_id, add_to_list, url, url_key, page_count, payload_hash)
     values (gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false,
             'https://a.test/x', 'a.test/x', 1, '\x01') $$,
  '23514', null, 'a link has no page_count');
select throws_ok(
  $$ insert into public.share_imports (id, user_id, household_id, add_to_list, url, url_key, images, payload_hash)
     values (gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false,
             'https://a.test/x', 'a.test/x', array['u/i/0.jpg'], '\x01') $$,
  '23514', null, 'or images');
select throws_ok(
  $$ insert into public.share_imports (id, user_id, household_id, add_to_list, kind, url, page_count, images, payload_hash)
     values (gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false,
             'photo', 'https://a.test/x', 1, array['u/i/0.jpg'], '\x01') $$,
  '23514', null, 'a photo has no url');
select throws_ok(
  $$ insert into public.share_imports (id, user_id, household_id, add_to_list, kind, url_key, page_count, images, payload_hash)
     values (gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false,
             'photo', 'a.test/x', 1, array['u/i/0.jpg'], '\x01') $$,
  '23514', null, 'or url_key');
select throws_ok($$ select pg_temp.photo(gen_random_uuid(), null, array['u/i/0.jpg']) $$, '23514', null,
  'a photo needs page_count');
select throws_ok($$ select pg_temp.photo(gen_random_uuid(), 0, null) $$, '23514', null, 'page_count is at least 1');
select throws_ok($$ select pg_temp.photo(gen_random_uuid(), 4, array['a', 'b', 'c', 'd']) $$, '23514', null,
  'and at most 3');
select throws_ok($$ select pg_temp.photo(gen_random_uuid(), 2, array['u/i/0.jpg']) $$, '23514', null,
  'a photo''s images are one per page');
select throws_ok(
  $$ insert into public.share_imports (id, user_id, household_id, add_to_list, kind, payload_hash)
     values (gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', false, 'video', '\x01') $$,
  '23514', null, 'kind is link or photo');

-- Photo shares used below: P1 two pages kept, P2 its pages deleted, P3 dismissed (failed), P4 to
-- be reserved, P5 at the photo per-minute limit.
select lives_ok($$ select pg_temp.photo('c0000000-0000-4000-8000-000000000001', 2,
  array['11111111-1111-4111-8111-111111111111/c0000000-0000-4000-8000-000000000001/0.jpg',
        '11111111-1111-4111-8111-111111111111/c0000000-0000-4000-8000-000000000001/1.jpg'], 'failed', 'transient') $$,
  'a photo share with its pages');
select lives_ok($$ select pg_temp.photo('c0000000-0000-4000-8000-000000000002', 3, null, 'failed', 'transient') $$,
  'a photo share whose pages are gone keeps its page_count');
select pg_temp.photo('c0000000-0000-4000-8000-000000000003', 1, array['x/0.jpg'], 'failed', 'permanent', now());
select pg_temp.photo('c0000000-0000-4000-8000-000000000004', 1, array['x/0.jpg']);
select pg_temp.photo('c0000000-0000-4000-8000-000000000005', 1, array['x/0.jpg']);

-- share-images -------------------------------------------------------------------------------------
select results_eq(
  $$ select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'share-images' $$,
  $$ values (false, 2097152::bigint, array['image/jpeg']) $$,
  'share-images is private, jpeg only, 2 MB');
insert into storage.objects (bucket_id, name) values
  ('share-images', '11111111-1111-4111-8111-111111111111/c0000000-0000-4000-8000-000000000001/0.jpg');

set local role authenticated;
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is((select count(*)::int from storage.objects where bucket_id = 'share-images'), 0,
  'the sharer can''t see their own share images');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('share-images', '11111111-1111-4111-8111-111111111111/c0000000-0000-4000-8000-000000000009/0.jpg') $$,
  '42501', null, 'or upload one');
reset role;

-- my_share_imports ---------------------------------------------------------------------------------
select is(
  array(select column_name::text from information_schema.columns
        where table_schema = 'public' and table_name = 'my_share_imports'
          and column_name in ('kind', 'page_count', 'pages_kept', 'images', 'dismissed_at')
        order by column_name),
  array['kind', 'page_count', 'pages_kept'],
  'the view has kind, page_count and pages_kept, but not images or dismissed_at');

set local role authenticated;
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is(
  (select array[kind, coalesce(url, 'null'), coalesce(page_count::text, 'null'), pages_kept::text]
   from public.my_share_imports where id = 'b0000000-0000-4000-8000-000000000001'),
  array['link', 'https://a.test/pasta', 'null', 'false'],
  'a link: no page count, no pages kept');
select is(
  (select array[kind, coalesce(url, 'null'), page_count::text, pages_kept::text]
   from public.my_share_imports where id = 'c0000000-0000-4000-8000-000000000001'),
  array['photo', 'null', '2', 'true'],
  'a photo share with its pages kept');
select is(
  (select array[kind, page_count::text, pages_kept::text]
   from public.my_share_imports where id = 'c0000000-0000-4000-8000-000000000002'),
  array['photo', '3', 'false'],
  'a photo share whose pages are gone');
select is(
  (select count(*)::int from public.my_share_imports where id = 'c0000000-0000-4000-8000-000000000003'), 0,
  'a dismissed share isn''t in the view');
select is(
  (select count(*)::int from public.my_share_imports), 5,
  'every other share of the sharer''s is');
select is(
  array(select s.id || ':' || s.status from public.share_import_status(array['c0000000-0000-4000-8000-000000000003']::uuid[]) s),
  array['c0000000-0000-4000-8000-000000000003:failed'],
  'share_import_status still reports a dismissed share, so it isn''t submitted again');
reset role;

set local role anon;
select throws_ok($$ select * from public.my_share_imports $$, '42501', null, 'anon still can''t read the view');
reset role;

-- reserve_share_import -----------------------------------------------------------------------------
select pg_temp.lease('c0000000-0000-4000-8000-000000000004');
select is(public.reserve_share_import('c0000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-0000000000ff'), 'ok',
  'reserve charges a photo share');
select is((pg_temp.job('c0000000-0000-4000-8000-000000000004')).metered_at, now(), 'and sets metered_at');
select is(array[pg_temp.photo_imports_today(), pg_temp.link_imports_today(), pg_temp.household_imports()],
  array[1, 0, 1], 'as a photo import for the sharer, not a link one, and once for the household');
select is(public.reserve_share_import('c0000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-0000000000ff'), 'ok',
  'reserving it again is ok');
select is(array[pg_temp.photo_imports_today(), pg_temp.household_imports()], array[1, 1], 'and charges nothing more');

-- At `recipe_import_photo`'s per-minute limit (5).
update private.recipe_photo_import_usage
set imports_this_minute = 5, minute_start = date_trunc('minute', now())
where user_id = '11111111-1111-4111-8111-111111111111';
select pg_temp.lease('c0000000-0000-4000-8000-000000000005');
select is(public.reserve_share_import('c0000000-0000-4000-8000-000000000005', 'f0000000-0000-4000-8000-0000000000ff'), 'user_limit',
  'a photo share over the photo per-minute limit isn''t charged');
select is((pg_temp.job('c0000000-0000-4000-8000-000000000005')).metered_at, null, 'and isn''t metered');
select is(array[pg_temp.photo_imports_today(), pg_temp.household_imports()], array[1, 1], 'and counts nothing');

select pg_temp.lease('b0000000-0000-4000-8000-000000000001');
select is(public.reserve_share_import('b0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-0000000000ff'), 'ok',
  'a link is still charged as a link import (the photo per-minute limit is its own)');
select is(array[pg_temp.photo_imports_today(), pg_temp.link_imports_today(), pg_temp.household_imports()],
  array[1, 1, 2], 'counted as a link import');

select ok(not has_function_privilege('authenticated', 'public.reserve_share_import(uuid, uuid)', 'execute'),
  'reserve is still the service role''s only');

-- retry_share_import -------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select throws_ok($$ select public.retry_share_import('c0000000-0000-4000-8000-000000000002') $$, '55000', 'retry_refused',
  'Try again on a photo share whose pages are gone is refused');
select is(public.retry_share_import('c0000000-0000-4000-8000-000000000001'), 'received',
  'a photo share with its pages can be tried again');
reset role;

select is(
  (select array[status, error_kind, retries::text] from pg_temp.job('c0000000-0000-4000-8000-000000000002')),
  array['failed', 'transient', '0'],
  'the refused job is unchanged');
select is(
  (select array[status, coalesce(error_kind, 'null'), retries::text] from pg_temp.job('c0000000-0000-4000-8000-000000000001')),
  array['received', 'null', '1'],
  'the retried photo share is received again, one retry counted');

select * from finish();
rollback;
