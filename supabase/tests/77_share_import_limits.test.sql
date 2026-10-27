-- Share import limits (spec 6.12): Try again refuses a charged permanent failure and a fourth
-- retry; the `share_ingest` limit per user for session uploads; at most 5 live device credentials
-- per user. now() is fixed within the transaction.
begin;
create extension if not exists pgtap with schema extensions;
select plan(35);

-- Fixtures (as postgres) ---------------------------------------------------------------------------
-- Alex shares into Home; Sam is another user.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-4111-8111-111111111111', 'alex@limits.test', 'authenticated', 'authenticated'),
  ('22222222-2222-4222-8222-222222222222', 'sam@limits.test', 'authenticated', 'authenticated');
insert into public.households (id, name) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Home');

-- Failed jobs: A failed permanently after the charge, B permanently before it (a limit), C
-- transiently after the charge, D is still received.
insert into public.share_imports (id, user_id, household_id, add_to_list, url, url_key, payload_hash, status,
                                  error_kind, error_code, resets_at, metered_at) values
  ('a0000000-0000-4000-8000-00000000000a', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   false, 'https://a.test/a', 'a.test/a', '\x0a', 'failed', 'permanent', 'not_a_recipe', null, now()),
  ('a0000000-0000-4000-8000-00000000000b', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   false, 'https://a.test/b', 'a.test/b', '\x0b', 'failed', 'permanent', 'daily_limit', now() + interval '1 hour', null),
  ('a0000000-0000-4000-8000-00000000000c', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   false, 'https://a.test/c', 'a.test/c', '\x0c', 'failed', 'transient', 'fetch_failed', null, now()),
  ('a0000000-0000-4000-8000-00000000000d', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   false, 'https://a.test/d', 'a.test/d', '\x0d', 'received', null, null, null, null);

create function pg_temp.job(p_id uuid) returns public.share_imports language sql as $$
  select * from public.share_imports where id = p_id
$$;
-- Fails job C again, as the worker would after a retry.
create function pg_temp.fail_c() returns void language sql as $$
  update public.share_imports
  set status = 'failed', error_kind = 'transient', error_code = 'fetch_failed', attempts = 8
  where id = 'a0000000-0000-4000-8000-00000000000c'
$$;

-- Try again ----------------------------------------------------------------------------------------
select col_default_is('public', 'share_imports', 'retries', '0', 'retries starts at 0');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$ select public.retry_share_import('a0000000-0000-4000-8000-00000000000a') $$, '55000', 'retry_refused',
  'Try again on a charged permanent failure is refused');
select is(public.retry_share_import('a0000000-0000-4000-8000-00000000000b'), 'received',
  'a permanent failure before the charge (a limit) can be tried again');
select is(public.retry_share_import('a0000000-0000-4000-8000-00000000000c'), 'received', 'a transient failure: the first retry');
select is(public.retry_share_import('a0000000-0000-4000-8000-00000000000d'), 'received',
  'Try again on a job that hasn''t failed leaves it as it is');
reset role;

select is(
  (select array[status, error_kind, error_code, retries::text] from pg_temp.job('a0000000-0000-4000-8000-00000000000a')),
  array['failed', 'permanent', 'not_a_recipe', '0'],
  'the refused job is unchanged');
select is(
  (select array[status, coalesce(error_kind, 'null'), retries::text, coalesce(metered_at::text, 'null')]
   from pg_temp.job('a0000000-0000-4000-8000-00000000000b')),
  array['received', 'null', '1', 'null'],
  'the limit job is received again, uncharged (the worker charges it like a new import), one retry counted');
select is((select retries from pg_temp.job('a0000000-0000-4000-8000-00000000000d')), 0,
  'a job that hasn''t failed counts no retry');
select is(
  (select array[status, attempts::text, retries::text] from pg_temp.job('a0000000-0000-4000-8000-00000000000c')),
  array['received', '0', '1'],
  'the transient job is received with attempts reset and one retry counted');

select pg_temp.fail_c();
set local role authenticated;
select is(public.retry_share_import('a0000000-0000-4000-8000-00000000000c'), 'received', 'the second retry');
reset role;
select pg_temp.fail_c();
set local role authenticated;
select is(public.retry_share_import('a0000000-0000-4000-8000-00000000000c'), 'received', 'the third retry');
reset role;
select pg_temp.fail_c();
set local role authenticated;
select throws_ok($$ select public.retry_share_import('a0000000-0000-4000-8000-00000000000c') $$, '55000', 'retry_refused',
  'a fourth is refused');
reset role;
select is(
  (select array[status, attempts::text, retries::text] from pg_temp.job('a0000000-0000-4000-8000-00000000000c')),
  array['failed', '8', '3'],
  'and changes nothing');

select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$ select public.retry_share_import('a0000000-0000-4000-8000-00000000000a') $$, 'P0002', 'not found',
  'another user''s job is still not found, not refused');
reset role;
select set_config('request.jwt.claims', '', true);

-- The share_ingest limit per user ------------------------------------------------------------------
select ok(
  has_function_privilege('service_role', 'public.check_share_ingest_user_limit(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.check_share_ingest_user_limit(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.check_share_ingest_user_limit(uuid)', 'execute'),
  'check_share_ingest_user_limit: service role only');
select ok(
  not has_table_privilege('authenticated', 'private.share_ingest_user_usage', 'select, insert, update, delete')
  and not has_table_privilege('anon', 'private.share_ingest_user_usage', 'select, insert, update, delete'),
  'clients have no privileges on the usage table');

set local role service_role;
select is((select count(*)::int from generate_series(1, 30) g
           where public.check_share_ingest_user_limit('11111111-1111-4111-8111-111111111111') = 'ok'), 30,
  '30 session uploads in a minute pass');
select is(public.check_share_ingest_user_limit('11111111-1111-4111-8111-111111111111'), 'user_limit', 'the 31st is refused');
select is(public.check_share_ingest_user_limit('22222222-2222-4222-8222-222222222222'), 'ok', 'another user has their own count');
select throws_ok($$ select public.check_share_ingest_user_limit(null) $$, '22023', 'p_user_id is required', 'a user is required');
reset role;
select is((select requests_this_minute from private.share_ingest_user_usage where user_id = '11111111-1111-4111-8111-111111111111'), 30,
  'a refusal isn''t counted');
update private.share_ingest_user_usage set minute_start = minute_start - interval '1 minute'
where user_id = '11111111-1111-4111-8111-111111111111';
set local role service_role;
select is(public.check_share_ingest_user_limit('11111111-1111-4111-8111-111111111111'), 'ok', 'the next minute starts again');
reset role;
select is((select requests_this_minute from private.share_ingest_user_usage where user_id = '11111111-1111-4111-8111-111111111111'), 1,
  'from one');
update public.ai_safety_limits set per_minute = 1 where key = 'share_ingest';
set local role service_role;
select is(public.check_share_ingest_user_limit('11111111-1111-4111-8111-111111111111'), 'user_limit', 'a lowered limit applies at once');
reset role;
update public.ai_safety_limits set per_minute = 30 where key = 'share_ingest';

-- At most 5 live device credentials per user -------------------------------------------------------
delete from public.device_credentials
where user_id in ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
-- Sam's one credential, and an expired one of Alex's that doesn't count.
insert into public.device_credentials (user_id, installation_id, token_hash, created_at, expires_at) values
  ('22222222-2222-4222-8222-222222222222', 'e0000000-0000-4000-8000-0000000000ff', decode(repeat('5a', 32), 'hex'),
   now() - interval '1 day', now() + interval '89 days'),
  ('11111111-1111-4111-8111-111111111111', 'e0000000-0000-4000-8000-0000000000ee', decode(repeat('ee', 32), 'hex'),
   now() - interval '100 days', now() - interval '10 days');

create function pg_temp.live(p_user uuid) returns bigint language sql as $$
  select count(*) from public.device_credentials
  where user_id = p_user and revoked_at is null and expires_at > now()
$$;
-- Alex registers installation e…0n with this hash. Each registration is its own transaction in
-- real use (a later created_at); here, in one, Alex's earlier credentials are made a minute older.
create function pg_temp.register(p_n int, p_hash text) returns void language sql as $$
  update public.device_credentials set created_at = created_at - interval '1 minute'
  where user_id = '11111111-1111-4111-8111-111111111111';
  select public.register_device_credential('11111111-1111-4111-8111-111111111111',
                                           ('e0000000-0000-4000-8000-00000000000' || p_n)::uuid, p_hash);
$$;

-- Five installations, e…01 to e…05, with hashes 01…, 02…, …
select pg_temp.register(n, repeat('0' || n, 32)) from generate_series(1, 5) n;
select is(pg_temp.live('11111111-1111-4111-8111-111111111111'), 5::bigint, 'five installations: five live credentials');
select is((select count(*)::int from public.device_credentials where revoked_reason = 'limit'), 0, 'none revoked');

-- Registering one of them again replaces it (a 24 h grace), so there are still five: none revoked.
select pg_temp.register(3, repeat('3b', 32));
select is(pg_temp.live('11111111-1111-4111-8111-111111111111'), 5::bigint, 'a re-registration keeps five live');
select is((select count(*)::int from public.device_credentials where revoked_reason = 'limit'), 0,
  'and revokes none for the limit');

-- A sixth installation revokes the oldest live one, e…01's.
select pg_temp.register(6, repeat('06', 32));
select is(pg_temp.live('11111111-1111-4111-8111-111111111111'), 5::bigint, 'a sixth installation: still five live');
select is(
  array(select installation_id::text || ' ' || (revoked_at = now())::text from public.device_credentials
        where revoked_reason = 'limit'),
  array['e0000000-0000-4000-8000-000000000001 true'],
  'the oldest live credential is revoked now, revoked_reason limit');
set local role service_role;
select is(public.use_device_credential(repeat('01', 32), 'share.ingest'), null, 'its token no longer works');
select is(public.use_device_credential(repeat('06', 32), 'share.ingest'), '11111111-1111-4111-8111-111111111111'::uuid,
  'the new one does');
select is(public.use_device_credential(repeat('03', 32), 'share.ingest'), '11111111-1111-4111-8111-111111111111'::uuid,
  'and a replaced one is still in its grace');
reset role;

-- A seventh: e…02's goes next.
select pg_temp.register(7, repeat('07', 32));
select is(
  array(select installation_id::text from public.device_credentials
        where user_id = '11111111-1111-4111-8111-111111111111' and revoked_at is null and expires_at > now()
        order by installation_id),
  array['e0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000005',
        'e0000000-0000-4000-8000-000000000006', 'e0000000-0000-4000-8000-000000000007'],
  'a seventh revokes the next oldest: the newest five stay live');
select is(pg_temp.live('22222222-2222-4222-8222-222222222222'), 1::bigint, 'another user''s credential is untouched');

select * from finish();
rollback;
