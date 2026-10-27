-- share-ingest's database side (spec 6.12): authenticate_device_credential, the `share_ingest`
-- safety limit through check_share_ingest_limit, and ingest_share_import's answers (new, the same
-- operation again, conflicts, the household and list checks and fallbacks).
begin;
create extension if not exists pgtap with schema extensions;
select plan(40);

-- Fixtures (as postgres) ---------------------------------------------------------------------------
-- Alex is in Home (lists Groceries, archived Old) and, later joined, Cabin; Sam is in Away (list
-- Hardware); Nell is in no household.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-4111-8111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-4222-8222-222222222222', 'sam@test.local', 'authenticated', 'authenticated'),
  ('33333333-3333-4333-8333-333333333333', 'nell@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Home'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Cabin'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Away');
insert into public.household_members (household_id, user_id, role, position, joined_at) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'owner', 1, now() - interval '2 days'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '11111111-1111-4111-8111-111111111111', 'owner', 2, now() - interval '1 day'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'owner', 1, now());
insert into public.lists (id, household_id, name, position, archived_at) values
  ('c0000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Groceries', 1, null),
  ('c0000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Old', 2, now()),
  ('c0000000-0000-4000-8000-000000000003', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Hardware', 1, null),
  ('c0000000-0000-4000-8000-000000000004', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Cabin list', 1, null);
insert into public.user_settings (user_id, default_list_id) values
  ('11111111-1111-4111-8111-111111111111', 'c0000000-0000-4000-8000-000000000004')
on conflict (user_id) do update set default_list_id = excluded.default_list_id;
delete from public.device_credentials where user_id = '11111111-1111-4111-8111-111111111111';
insert into public.device_credentials (id, user_id, installation_id, token_hash) values
  ('d0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
   'e0000000-0000-4000-8000-000000000001', decode(repeat('a1', 32), 'hex')),
  ('d0000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
   'e0000000-0000-4000-8000-000000000002', decode(repeat('a2', 32), 'hex'));

-- ingest_share_import with the usual columns: id, user, household, list, add_to_list, hash.
create function pg_temp.ingest(p_id uuid, p_user uuid, p_household uuid, p_list uuid, p_add boolean, p_hash text,
                               p_credential uuid default null)
returns text language sql as $$
  select i.outcome || coalesce('/' || i.status, '')
  from public.ingest_share_import(p_id, p_user, p_credential, p_household, p_list, p_add, 'https://www.a.test/pasta',
                                  'https://a.test/pasta', 'Pasta', p_hash, '{"title": "Pasta", "text": "boil"}',
                                  '2026-10-22T09:30:00Z', '1.4.0', 'share') i
$$;
create function pg_temp.job(p_id uuid) returns public.share_imports language sql as $$
  select * from public.share_imports where id = p_id
$$;

-- Access -------------------------------------------------------------------------------------------
select ok(
  has_function_privilege('service_role', 'public.authenticate_device_credential(text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.authenticate_device_credential(text, text)', 'execute')
  and not has_function_privilege('anon', 'public.authenticate_device_credential(text, text)', 'execute'),
  'authenticate_device_credential: service role only');
select ok(
  has_function_privilege('service_role', 'public.check_share_ingest_limit(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.check_share_ingest_limit(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.check_share_ingest_limit(uuid)', 'execute'),
  'check_share_ingest_limit: service role only');
select ok(
  has_function_privilege('service_role', 'public.ingest_share_import(uuid, uuid, uuid, uuid, uuid, boolean, text, text, text, text, jsonb, timestamptz, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.ingest_share_import(uuid, uuid, uuid, uuid, uuid, boolean, text, text, text, text, jsonb, timestamptz, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.ingest_share_import(uuid, uuid, uuid, uuid, uuid, boolean, text, text, text, text, jsonb, timestamptz, text, text)', 'execute'),
  'ingest_share_import: service role only');
select ok(
  not has_table_privilege('authenticated', 'private.share_ingest_usage', 'select')
  and not has_table_privilege('anon', 'private.share_ingest_usage', 'select'),
  'the usage table has no client access');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select * from public.ingest_share_import('0192f0c4-7b1a-7c3d-8e4f-000000000001', '11111111-1111-4111-8111-111111111111',
  null, null, null, true, 'https://a.test', 'a.test', null, repeat('ab', 32), null, null, null, null) $$, '42501', null,
  'a signed-in user can''t record a share import directly');
reset role;

-- authenticate_device_credential -------------------------------------------------------------------
select results_eq(
  $$ select user_id, credential_id from public.authenticate_device_credential(repeat('a1', 32), 'share.ingest') $$,
  $$ values ('11111111-1111-4111-8111-111111111111'::uuid, 'd0000000-0000-4000-8000-000000000001'::uuid) $$,
  'a valid credential answers its user and id');
select ok((select last_used_at is not null from public.device_credentials where id = 'd0000000-0000-4000-8000-000000000001'),
  'and is marked used');
select is((select count(*)::int from public.authenticate_device_credential(repeat('ff', 32), 'share.ingest')), 0,
  'an unknown token answers no row');
select is((select count(*)::int from public.authenticate_device_credential(repeat('a1', 32), 'siri.add')), 0,
  'an out-of-scope one answers no row');
update public.device_credentials set revoked_at = now() - interval '1 second', revoked_reason = 'sign_out'
where id = 'd0000000-0000-4000-8000-000000000002';
select is((select count(*)::int from public.authenticate_device_credential(repeat('a2', 32), 'share.ingest')), 0,
  'a revoked one answers no row');
update public.device_credentials set revoked_at = null, revoked_reason = null where id = 'd0000000-0000-4000-8000-000000000002';

-- The share_ingest limit ---------------------------------------------------------------------------
select is((select array[per_minute, per_day] from public.ai_safety_limits where key = 'share_ingest'), array[30, null]::int[],
  'share_ingest is seeded at 30 a minute, no daily limit');
select ok('share_ingest' = any (private.safety_limit_keys()), 'and is one of the portal''s keys');

select is((select count(*)::int from generate_series(1, 30) g
           where public.check_share_ingest_limit('d0000000-0000-4000-8000-000000000001') = 'ok'), 30,
  '30 uploads in a minute pass');
select is(public.check_share_ingest_limit('d0000000-0000-4000-8000-000000000001'), 'user_limit', 'the 31st is refused');
select is((select requests_this_minute from private.share_ingest_usage where credential_id = 'd0000000-0000-4000-8000-000000000001'), 30,
  'a refusal isn''t counted');
select is(public.check_share_ingest_limit('d0000000-0000-4000-8000-000000000002'), 'ok', 'another credential has its own count');
update private.share_ingest_usage set minute_start = minute_start - interval '1 minute'
where credential_id = 'd0000000-0000-4000-8000-000000000001';
select is(public.check_share_ingest_limit('d0000000-0000-4000-8000-000000000001'), 'ok', 'the next minute starts again');
select is((select requests_this_minute from private.share_ingest_usage where credential_id = 'd0000000-0000-4000-8000-000000000001'), 1,
  'from one');
update public.ai_safety_limits set per_minute = 1 where key = 'share_ingest';
select is(public.check_share_ingest_limit('d0000000-0000-4000-8000-000000000001'), 'user_limit', 'a lowered limit applies at once');
update public.ai_safety_limits set per_minute = null where key = 'share_ingest';
select is(public.check_share_ingest_limit('d0000000-0000-4000-8000-000000000001'), 'ok', 'a null limit is no limit');
update public.ai_safety_limits set per_minute = 30 where key = 'share_ingest';
select throws_ok($$ select public.check_share_ingest_limit(null) $$, '22023', 'p_credential_id is required',
  'a credential is required');

-- ingest_share_import ------------------------------------------------------------------------------
select is(pg_temp.ingest('0192f0c4-7b1a-7c3d-8e4f-000000000001', '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c0000000-0000-4000-8000-000000000001', true, repeat('ab', 32),
    'd0000000-0000-4000-8000-000000000001'),
  'accepted/received', 'a new share is accepted as received');
select is(
  (select row(j.user_id, j.credential_id, j.household_id, j.list_id, j.add_to_list, j.url, j.url_key, j.title,
              encode(j.payload_hash, 'hex'), j.page, j.status, j.attempts, j.client_created_at, j.app_version, j.source)::text
   from pg_temp.job('0192f0c4-7b1a-7c3d-8e4f-000000000001') j),
  row('11111111-1111-4111-8111-111111111111'::uuid, 'd0000000-0000-4000-8000-000000000001'::uuid,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'c0000000-0000-4000-8000-000000000001'::uuid, true,
      'https://www.a.test/pasta', 'https://a.test/pasta', 'Pasta', repeat('ab', 32),
      '{"title": "Pasta", "text": "boil"}'::jsonb, 'received', 0, '2026-10-22T09:30:00Z'::timestamptz, '1.4.0', 'share')::text,
  'with every column');

select is(pg_temp.ingest('0192f0c4-7b1a-7c3d-8e4f-000000000001', '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c0000000-0000-4000-8000-000000000001', true, repeat('ab', 32)),
  'accepted/received', 'the same operation again (a lost answer) is accepted, from a session too');
update public.share_imports set status = 'extracting' where id = '0192f0c4-7b1a-7c3d-8e4f-000000000001';
select is(pg_temp.ingest('0192f0c4-7b1a-7c3d-8e4f-000000000001', '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c0000000-0000-4000-8000-000000000001', true, repeat('ab', 32)),
  'accepted/extracting', 'with its current status');
select is((select credential_id from pg_temp.job('0192f0c4-7b1a-7c3d-8e4f-000000000001')), 'd0000000-0000-4000-8000-000000000001'::uuid,
  'and the first record kept');
select is(pg_temp.ingest('0192f0c4-7b1a-7c3d-8e4f-000000000001', '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c0000000-0000-4000-8000-000000000001', true, repeat('cd', 32)),
  'conflict', 'the same id with another payload is a conflict');
select is(pg_temp.ingest('0192f0c4-7b1a-7c3d-8e4f-000000000001', '22222222-2222-4222-8222-222222222222',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c0000000-0000-4000-8000-000000000001', true, repeat('ab', 32)),
  'conflict', 'and from another user, even with the same hash');
delete from public.household_members
where household_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and user_id = '11111111-1111-4111-8111-111111111111';
select is(pg_temp.ingest('0192f0c4-7b1a-7c3d-8e4f-000000000001', '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c0000000-0000-4000-8000-000000000001', true, repeat('ab', 32)),
  'accepted/extracting', 'a resubmit is answered by its id, even after leaving the household');
insert into public.household_members (household_id, user_id, role, position, joined_at) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'owner', 1, now() - interval '2 days');

select is(pg_temp.ingest('0192f0c4-7b1a-7c3d-8e4f-000000000002', '11111111-1111-4111-8111-111111111111',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'c0000000-0000-4000-8000-000000000003', true, repeat('ab', 32)),
  'not_a_member', 'a household the user isn''t in');
select is(pg_temp.ingest('0192f0c4-7b1a-7c3d-8e4f-000000000003', '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c0000000-0000-4000-8000-000000000003', true, repeat('ab', 32)),
  'invalid_list', 'a list of another household');
select is(pg_temp.ingest('0192f0c4-7b1a-7c3d-8e4f-000000000004', '11111111-1111-4111-8111-111111111111',
    null, 'c0000000-0000-4000-8000-0000000000ff', true, repeat('ab', 32)),
  'invalid_list', 'an unknown list');
select is((select count(*)::int from public.share_imports where id in
  ('0192f0c4-7b1a-7c3d-8e4f-000000000002', '0192f0c4-7b1a-7c3d-8e4f-000000000003', '0192f0c4-7b1a-7c3d-8e4f-000000000004')), 0,
  'refusals record nothing');

select is(pg_temp.ingest('0192f0c4-7b1a-7c3d-8e4f-000000000005', '11111111-1111-4111-8111-111111111111',
    null, 'c0000000-0000-4000-8000-000000000002', true, repeat('ab', 32)),
  'accepted/received', 'an archived list is accepted (the worker falls back)');
select is((select household_id from pg_temp.job('0192f0c4-7b1a-7c3d-8e4f-000000000005')), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
  'with no household given, the list''s');
select is(pg_temp.ingest('0192f0c4-7b1a-7c3d-8e4f-000000000006', '11111111-1111-4111-8111-111111111111',
    null, null, true, repeat('ab', 32)), 'accepted/received', 'neither household nor list (an older extension)');
select is((select household_id from pg_temp.job('0192f0c4-7b1a-7c3d-8e4f-000000000006')), 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
  'goes to the default list''s household');
update public.user_settings set default_list_id = null where user_id = '11111111-1111-4111-8111-111111111111';
select is(pg_temp.ingest('0192f0c4-7b1a-7c3d-8e4f-000000000007', '11111111-1111-4111-8111-111111111111',
    null, null, false, repeat('ab', 32)) || ' ' ||
  (select household_id::text from pg_temp.job('0192f0c4-7b1a-7c3d-8e4f-000000000007')),
  'accepted/received aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'with no default list, the user''s first household');
select is(pg_temp.ingest('0192f0c4-7b1a-7c3d-8e4f-000000000008', '33333333-3333-4333-8333-333333333333',
    null, null, true, repeat('ab', 32)), 'not_a_member', 'a user in no household');

select throws_ok($$ select pg_temp.ingest('0192f0c4-7b1a-7c3d-8e4f-000000000009', '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null, false, 'AB') $$, '22023', 'invalid payload hash',
  'a hash that isn''t 64 hex digits is refused');

select * from finish();
rollback;
