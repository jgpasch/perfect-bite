-- share-ingest's photo shares (spec 6.12): ingest_photo_share_import's answers (new, a check that
-- records nothing, the same operation again, conflicts with photo and link shares, the household
-- and list checks and fallbacks), the row it records, and its argument checks.
begin;
create extension if not exists pgtap with schema extensions;
select plan(32);

-- Fixtures (as postgres) ---------------------------------------------------------------------------
-- Alex is in Home (list Groceries) and, later joined, Cabin (Alex's default list); Sam is in Away
-- (list Hardware).
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-4111-8111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-4222-8222-222222222222', 'sam@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Home'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Cabin'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Away');
insert into public.household_members (household_id, user_id, role, position, joined_at) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'owner', 1, now() - interval '2 days'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '11111111-1111-4111-8111-111111111111', 'owner', 2, now() - interval '1 day'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'owner', 1, now());
insert into public.lists (id, household_id, name, position) values
  ('c0000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Groceries', 1),
  ('c0000000-0000-4000-8000-000000000003', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Hardware', 1),
  ('c0000000-0000-4000-8000-000000000004', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Cabin list', 1);
insert into public.user_settings (user_id, default_list_id) values
  ('11111111-1111-4111-8111-111111111111', 'c0000000-0000-4000-8000-000000000004')
on conflict (user_id) do update set default_list_id = excluded.default_list_id;

-- ingest_photo_share_import with the usual columns: id, user, household, list, add_to_list, hash,
-- page count and check-only.
create function pg_temp.photo(p_id uuid, p_user uuid, p_household uuid, p_list uuid, p_add boolean, p_hash text,
                              p_pages integer default 2, p_check boolean default false)
returns text language sql as $$
  select i.outcome || coalesce('/' || i.status, '')
  from public.ingest_photo_share_import(p_id, p_user, null, p_household, p_list, p_add, p_hash, p_pages,
                                        '2026-10-22T09:30:00Z', '1.4.0', 'share', p_check) i
$$;
create function pg_temp.job(p_id uuid) returns public.share_imports language sql as $$
  select * from public.share_imports where id = p_id
$$;

-- Access -------------------------------------------------------------------------------------------
select ok(
  has_function_privilege('service_role', 'public.ingest_photo_share_import(uuid, uuid, uuid, uuid, uuid, boolean, text, integer, timestamptz, text, text, boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.ingest_photo_share_import(uuid, uuid, uuid, uuid, uuid, boolean, text, integer, timestamptz, text, text, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.ingest_photo_share_import(uuid, uuid, uuid, uuid, uuid, boolean, text, integer, timestamptz, text, text, boolean)', 'execute'),
  'ingest_photo_share_import: service role only');
select ok(
  not has_function_privilege('authenticated', 'private.share_import_household(uuid, uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'private.share_import_household(uuid, uuid, uuid)', 'execute'),
  'share_import_household: not for clients');

-- A new photo share ---------------------------------------------------------------------------------
select is(pg_temp.photo('0192f0c4-7b1a-7c3d-8e4f-000000000001', '11111111-1111-4111-8111-111111111111',
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c0000000-0000-4000-8000-000000000001', true, repeat('11', 32), 2, true),
          'new', 'a check of a new share answers new');
select is((select count(*)::int from public.share_imports where id = '0192f0c4-7b1a-7c3d-8e4f-000000000001'), 0,
          'and records nothing');

select is(pg_temp.photo('0192f0c4-7b1a-7c3d-8e4f-000000000001', '11111111-1111-4111-8111-111111111111',
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c0000000-0000-4000-8000-000000000001', true, repeat('11', 32)),
          'accepted/received', 'recording it accepts it as received');
select is((pg_temp.job('0192f0c4-7b1a-7c3d-8e4f-000000000001')).kind, 'photo', 'kind photo');
select is((pg_temp.job('0192f0c4-7b1a-7c3d-8e4f-000000000001')).page_count, 2, 'its page count');
select is((pg_temp.job('0192f0c4-7b1a-7c3d-8e4f-000000000001')).images,
          array['11111111-1111-4111-8111-111111111111/0192f0c4-7b1a-7c3d-8e4f-000000000001/1.jpg',
                '11111111-1111-4111-8111-111111111111/0192f0c4-7b1a-7c3d-8e4f-000000000001/2.jpg'],
          'images: <user>/<id>/<n>.jpg from 1, in page order');
select ok((select url is null and url_key is null and page is null and title is null
           from public.share_imports where id = '0192f0c4-7b1a-7c3d-8e4f-000000000001'),
          'no url, url_key, page or title');
select is((select household_id::text || ' ' || list_id::text || ' ' || add_to_list::text || ' ' || status
           || ' ' || encode(payload_hash, 'hex') || ' ' || source || ' ' || app_version
           from public.share_imports where id = '0192f0c4-7b1a-7c3d-8e4f-000000000001'),
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa c0000000-0000-4000-8000-000000000001 true received ' || repeat('11', 32) || ' share 1.4.0',
          'household, list, addToList, status, hash and the envelope fields');
select is((select count(*)::int from private.share_image_deletions), 0, 'recording queues nothing for deletion');

-- The same operation again --------------------------------------------------------------------------
select is(pg_temp.photo('0192f0c4-7b1a-7c3d-8e4f-000000000001', '11111111-1111-4111-8111-111111111111',
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c0000000-0000-4000-8000-000000000001', true, repeat('11', 32), 2, true),
          'accepted/received', 'a check of a recorded share answers its status, so nothing is uploaded again');
update public.share_imports set status = 'extracting' where id = '0192f0c4-7b1a-7c3d-8e4f-000000000001';
select is(pg_temp.photo('0192f0c4-7b1a-7c3d-8e4f-000000000001', '11111111-1111-4111-8111-111111111111',
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c0000000-0000-4000-8000-000000000001', true, repeat('11', 32)),
          'accepted/extracting', 'a resubmit answers the current status');
select is((select count(*)::int from public.share_imports where id = '0192f0c4-7b1a-7c3d-8e4f-000000000001'), 1,
          'one row');

-- Conflicts -----------------------------------------------------------------------------------------
select is(pg_temp.photo('0192f0c4-7b1a-7c3d-8e4f-000000000001', '11111111-1111-4111-8111-111111111111',
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c0000000-0000-4000-8000-000000000001', true, repeat('22', 32), 2, true),
          'conflict', 'a check with another payload is a conflict');
select is(pg_temp.photo('0192f0c4-7b1a-7c3d-8e4f-000000000001', '11111111-1111-4111-8111-111111111111',
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c0000000-0000-4000-8000-000000000001', true, repeat('22', 32), 3),
          'conflict', 'recording another payload is a conflict');
select is(pg_temp.photo('0192f0c4-7b1a-7c3d-8e4f-000000000001', '22222222-2222-4222-8222-222222222222',
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', null, true, repeat('11', 32)),
          'conflict', 'another user with the same hash is a conflict');
select is((pg_temp.job('0192f0c4-7b1a-7c3d-8e4f-000000000001')).page_count, 2, 'the first share is kept');

select is((select i.outcome from public.ingest_share_import('0192f0c4-7b1a-7c3d-8e4f-000000000002',
          '11111111-1111-4111-8111-111111111111', null, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null, true,
          'https://a.test/pasta', 'https://a.test/pasta', 'Pasta', repeat('33', 32), null,
          '2026-10-22T09:30:00Z', '1.4.0', 'share') i), 'accepted', 'a link share still records');
select is(pg_temp.photo('0192f0c4-7b1a-7c3d-8e4f-000000000002', '11111111-1111-4111-8111-111111111111',
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null, true, repeat('33', 32), 2, true),
          'conflict', 'a photo share under a link share''s id is a conflict, even with its hash');
select is((select i.outcome from public.ingest_share_import('0192f0c4-7b1a-7c3d-8e4f-000000000001',
          '11111111-1111-4111-8111-111111111111', null, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          'c0000000-0000-4000-8000-000000000001', true, 'https://a.test/pasta', 'https://a.test/pasta', 'Pasta',
          repeat('11', 32), null, '2026-10-22T09:30:00Z', '1.4.0', 'share') i), 'conflict',
          'and a link share under a photo share''s id, even with its hash');

-- The household and the list ------------------------------------------------------------------------
select is(pg_temp.photo('0192f0c4-7b1a-7c3d-8e4f-000000000003', '11111111-1111-4111-8111-111111111111',
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', null, false, repeat('44', 32), 1, true),
          'not_a_member', 'a check for a household the user isn''t in');
select is(pg_temp.photo('0192f0c4-7b1a-7c3d-8e4f-000000000003', '11111111-1111-4111-8111-111111111111',
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', null, false, repeat('44', 32), 1),
          'not_a_member', 'recording for a household the user isn''t in');
select is(pg_temp.photo('0192f0c4-7b1a-7c3d-8e4f-000000000003', '11111111-1111-4111-8111-111111111111',
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c0000000-0000-4000-8000-000000000003', true, repeat('44', 32), 1, true),
          'invalid_list', 'a list outside the household');
select is(pg_temp.photo('0192f0c4-7b1a-7c3d-8e4f-000000000003', '11111111-1111-4111-8111-111111111111',
          null, 'c0000000-0000-4000-8000-0000000000ff', true, repeat('44', 32), 1),
          'invalid_list', 'an unknown list with no household');
select is((select count(*)::int from public.share_imports where id = '0192f0c4-7b1a-7c3d-8e4f-000000000003'), 0,
          'refusals record nothing');

select is(pg_temp.photo('0192f0c4-7b1a-7c3d-8e4f-000000000004', '11111111-1111-4111-8111-111111111111',
          null, null, true, repeat('55', 32), 3),
          'accepted/received', 'no household or list (an older extension) is accepted');
select is((pg_temp.job('0192f0c4-7b1a-7c3d-8e4f-000000000004')).household_id, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
          'in the default list''s household');
select is(cardinality((pg_temp.job('0192f0c4-7b1a-7c3d-8e4f-000000000004')).images), 3, 'with one image per page');

-- Argument checks -----------------------------------------------------------------------------------
select throws_ok($$ select pg_temp.photo('0192f0c4-7b1a-7c3d-8e4f-000000000005', '11111111-1111-4111-8111-111111111111',
                   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null, true, repeat('66', 32), 0) $$,
                 '22023', 'p_page_count must be 1 to 3', 'no pages');
select throws_ok($$ select pg_temp.photo('0192f0c4-7b1a-7c3d-8e4f-000000000005', '11111111-1111-4111-8111-111111111111',
                   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null, true, repeat('66', 32), 4) $$,
                 '22023', 'p_page_count must be 1 to 3', 'four pages');
select throws_ok($$ select pg_temp.photo('0192f0c4-7b1a-7c3d-8e4f-000000000005', '11111111-1111-4111-8111-111111111111',
                   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null, true, 'AB', 1) $$,
                 '22023', 'invalid payload hash', 'a hash that isn''t 64 lower-case hex digits');

select * from finish();
rollback;
