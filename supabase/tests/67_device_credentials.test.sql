-- Device credentials (spec 6.12, 4.12): the table and its privileges, register_device_credential's
-- replacement with a 24 h grace, authenticate_device_credential's checks, revoke_my_device_credential,
-- admin_revoke_device_credentials with its audit row, and the cascade when the user is deleted.
-- now() is fixed within the transaction, so "now" and "now + 24 h" are exact.
begin;
create extension if not exists pgtap with schema extensions;
select plan(54);

-- Fixtures (as postgres) ------------------------------------------------------
-- boss is the admin; ann has two installations, ben one, cy isn't an admin.
insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'boss@creds.test', 'authenticated', 'authenticated'),
  ('11111111-1111-1111-1111-111111111111', 'ann@creds.test', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'ben@creds.test', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'cy@creds.test', 'authenticated', 'authenticated');
insert into private.admins (user_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- Hashes are 64 hex characters; repeat() keeps them readable.
create temporary table h (name text primary key, hash text) on commit drop;
insert into h values
  ('ann1', repeat('a1', 32)), ('ann2', repeat('a2', 32)), ('ann3', repeat('a3', 32)),
  ('annphone', repeat('a9', 32)), ('ben', repeat('b1', 32)), ('old', repeat('0d', 32)),
  ('gone', repeat('9e', 32)), ('unknown', repeat('ff', 32));
grant select on h to service_role, authenticated;

-- The table ---------------------------------------------------------------------
select has_table('public', 'device_credentials', 'device_credentials exists');
select col_type_is('public', 'device_credentials', 'token_hash', 'bytea', 'token_hash is bytea');
select col_default_is('public', 'device_credentials', 'scopes', '{share.ingest}'::text, 'scopes default to share.ingest');
select ok((select relrowsecurity from pg_class where oid = 'public.device_credentials'::regclass), 'RLS is on');
select ok(
  not has_table_privilege('anon', 'public.device_credentials', 'select, insert, update, delete')
  and not has_table_privilege('authenticated', 'public.device_credentials', 'select, insert, update, delete'),
  'clients have no privileges on the table');
select ok(
  has_function_privilege('service_role', 'public.register_device_credential(uuid, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.register_device_credential(uuid, uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.register_device_credential(uuid, uuid, text)', 'execute'),
  'only the service role registers');
select ok(
  has_function_privilege('service_role', 'public.authenticate_device_credential(text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.authenticate_device_credential(text, text)', 'execute')
  and not has_function_privilege('anon', 'public.authenticate_device_credential(text, text)', 'execute'),
  'only the service role verifies');
select ok(
  has_function_privilege('authenticated', 'public.revoke_my_device_credential(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.revoke_my_device_credential(uuid)', 'execute'),
  'signed-in users revoke their own');
select ok(
  has_function_privilege('authenticated', 'public.admin_revoke_device_credentials(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.admin_revoke_device_credentials(uuid, text)', 'execute')
  and not has_function_privilege('service_role', 'public.admin_revoke_device_credentials(uuid, text)', 'execute'),
  'only authenticated can execute admin_revoke_device_credentials');

-- Registering -------------------------------------------------------------------
set local role service_role;
select is(
  public.register_device_credential('11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001',
    (select hash from h where name = 'ann1')),
  now() + interval '90 days', 'a new credential is valid for 90 days');
reset role;

select results_eq(
  $$ select user_id, installation_id, encode(token_hash, 'hex'), scopes, created_at, last_used_at, expires_at, revoked_at, revoked_reason
     from public.device_credentials $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid, 'c0000000-0000-0000-0000-000000000001'::uuid, repeat('a1', 32),
             '{share.ingest}'::text[], now(), null::timestamptz, now() + interval '90 days', null::timestamptz, null::text) $$,
  'it is stored by its hash, live and in scope share.ingest');

set local role service_role;
select is(
  public.register_device_credential('11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001',
    (select hash from h where name = 'ann2')),
  now() + interval '90 days', 'registering again for that installation makes a new one');
reset role;

select results_eq(
  $$ select expires_at, revoked_at, revoked_reason from public.device_credentials where token_hash = decode(repeat('a1', 32), 'hex') $$,
  $$ values (now() + interval '24 hours', now() + interval '24 hours', 'replaced') $$,
  'the old one is replaced with a 24 h grace');
select results_eq(
  $$ select encode(token_hash, 'hex') from public.device_credentials
     where user_id = '11111111-1111-1111-1111-111111111111' and revoked_at is null $$,
  $$ values (repeat('a2', 32)) $$,
  'only the new one is live');

-- One that's already near its end keeps that end, not a longer grace.
insert into public.device_credentials (user_id, installation_id, token_hash, expires_at)
values ('22222222-2222-2222-2222-222222222222', 'c0000000-0000-0000-0000-000000000003',
        decode(repeat('0d', 32), 'hex'), now() + interval '2 hours');
set local role service_role;
select public.register_device_credential('22222222-2222-2222-2222-222222222222', 'c0000000-0000-0000-0000-000000000003',
  (select hash from h where name = 'ben'));
reset role;
select results_eq(
  $$ select expires_at, revoked_at, revoked_reason from public.device_credentials where token_hash = decode(repeat('0d', 32), 'hex') $$,
  $$ values (now() + interval '2 hours', now() + interval '2 hours', 'replaced') $$,
  'a replaced credential never gains time');

-- A second installation of ann's is separate.
set local role service_role;
select public.register_device_credential('11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000002',
  (select hash from h where name = 'annphone'));
reset role;
select is(
  (select count(*)::int from public.device_credentials where user_id = '11111111-1111-1111-1111-111111111111' and revoked_at is null),
  2, 'one live credential per installation');

set local role service_role;
select throws_ok(
  $$ select public.register_device_credential('11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001', 'abc') $$,
  '22023', 'invalid credential', 'a hash that isn''t 64 hex characters is refused');
select throws_ok(
  $$ select public.register_device_credential('11111111-1111-1111-1111-111111111111', null, repeat('a5', 32)) $$,
  '22023', 'invalid credential', 'so is a missing installation');
select throws_ok(
  $$ select public.register_device_credential('22222222-2222-2222-2222-222222222222', 'c0000000-0000-0000-0000-000000000009', repeat('a2', 32)) $$,
  '23505', null, 'a token hash is unique');
select throws_ok(
  $$ select public.register_device_credential('99999999-9999-9999-9999-999999999999', 'c0000000-0000-0000-0000-000000000009', repeat('a5', 32)) $$,
  '23503', null, 'an unknown user is refused');
reset role;

select throws_ok(
  $$ insert into public.device_credentials (user_id, installation_id, token_hash)
     values ('11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001', decode(repeat('a6', 32), 'hex')) $$,
  '23505', null, 'a second live credential for one installation is refused by the index');

-- Verifying -------------------------------------------------------------------------
-- Expired, and revoked in the past, for the null cases.
insert into public.device_credentials (user_id, installation_id, token_hash, created_at, expires_at, revoked_at, revoked_reason) values
  ('22222222-2222-2222-2222-222222222222', 'c0000000-0000-0000-0000-000000000004', decode(repeat('9e', 32), 'hex'),
   now() - interval '91 days', now() - interval '1 day', null, null),
  ('22222222-2222-2222-2222-222222222222', 'c0000000-0000-0000-0000-000000000005', decode(repeat('9f', 32), 'hex'),
   now() - interval '10 days', now() + interval '80 days', now() - interval '1 hour', 'sign_out');

set local role service_role;
select is((select user_id from public.authenticate_device_credential(repeat('a2', 32), 'share.ingest')), '11111111-1111-1111-1111-111111111111'::uuid,
  'a live credential gives its user');
select is((select user_id from public.authenticate_device_credential(repeat('a1', 32), 'share.ingest')), '11111111-1111-1111-1111-111111111111'::uuid,
  'one in its grace still works');
select is((select user_id from public.authenticate_device_credential(repeat('a2', 32), 'siri.add')), null, 'out of scope is null');
select is((select user_id from public.authenticate_device_credential(repeat('ff', 32), 'share.ingest')), null, 'unknown is null');
select is((select user_id from public.authenticate_device_credential(repeat('9e', 32), 'share.ingest')), null, 'expired is null');
select is((select user_id from public.authenticate_device_credential(repeat('9f', 32), 'share.ingest')), null, 'revoked is null');
reset role;

select results_eq(
  $$ select encode(token_hash, 'hex'), last_used_at from public.device_credentials
     where last_used_at is not null order by 1 $$,
  $$ values (repeat('a1', 32), now()), (repeat('a2', 32), now()) $$,
  'last_used_at is set on the credentials that verified, and only those');

update public.device_credentials set scopes = '{share.ingest,siri.add}' where token_hash = decode(repeat('a2', 32), 'hex');
set local role service_role;
select is((select user_id from public.authenticate_device_credential(repeat('a2', 32), 'siri.add')), '11111111-1111-1111-1111-111111111111'::uuid,
  'a credential with the scope is accepted for it');
reset role;

-- Clients can't reach the table -------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select * from public.device_credentials $$, '42501', null, 'a user can''t read credentials');
select throws_ok($$ select * from public.authenticate_device_credential(repeat('a2', 32), 'share.ingest') $$, '42501', null,
  'nor verify a token');
select throws_ok(
  $$ select public.register_device_credential('11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001', repeat('a7', 32)) $$,
  '42501', null, 'nor register one directly');

-- Sign-out ----------------------------------------------------------------------------
-- ben can't revoke ann's.
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select lives_ok($$ select public.revoke_my_device_credential('c0000000-0000-0000-0000-000000000001') $$,
  'revoking another user''s installation is a no-op');
reset role;
select is(
  (select count(*)::int from public.device_credentials
   where installation_id = 'c0000000-0000-0000-0000-000000000001' and revoked_reason = 'sign_out'),
  0, 'nothing of ann''s was revoked');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select lives_ok($$ select public.revoke_my_device_credential('c0000000-0000-0000-0000-000000000001') $$,
  'ann signs out on that installation');
select lives_ok($$ select public.revoke_my_device_credential('c0000000-0000-0000-0000-000000000099') $$,
  'an installation with no credential is a no-op');
reset role;

select results_eq(
  $$ select encode(token_hash, 'hex'), revoked_at, revoked_reason from public.device_credentials
     where installation_id = 'c0000000-0000-0000-0000-000000000001' order by 1 $$,
  $$ values (repeat('a1', 32), now(), 'sign_out'), (repeat('a2', 32), now(), 'sign_out') $$,
  'its live credential and the one in its grace are revoked now');
select results_eq(
  $$ select revoked_at from public.device_credentials where installation_id = 'c0000000-0000-0000-0000-000000000002' $$,
  $$ values (null::timestamptz) $$,
  'her other installation is untouched');

set local role service_role;
select is((select user_id from public.authenticate_device_credential(repeat('a2', 32), 'share.ingest')), null, 'a signed-out credential is refused');
select is((select user_id from public.authenticate_device_credential(repeat('a1', 32), 'share.ingest')), null, 'and so is its predecessor');
reset role;

-- Signing in again on that installation registers a new one; the revoked ones don't count.
set local role service_role;
select lives_ok(
  $$ select public.register_device_credential('11111111-1111-1111-1111-111111111111', 'c0000000-0000-0000-0000-000000000001', repeat('a3', 32)) $$,
  'signing in again registers a new credential');
reset role;
select results_eq(
  $$ select encode(token_hash, 'hex'), revoked_reason from public.device_credentials
     where installation_id = 'c0000000-0000-0000-0000-000000000001' order by 1 $$,
  $$ values (repeat('a1', 32), 'sign_out'), (repeat('a2', 32), 'sign_out'), (repeat('a3', 32), null) $$,
  'the signed-out ones keep their reason');

-- Admin revocation --------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select throws_ok($$ select public.admin_revoke_device_credentials('11111111-1111-1111-1111-111111111111', 'lost phone') $$,
  '42501', 'not authorized', 'a non-admin can''t revoke');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);
select throws_ok($$ select public.admin_revoke_device_credentials('11111111-1111-1111-1111-111111111111', '  ') $$,
  '22023', 'note required', 'a blank note is refused');
select throws_ok($$ select public.admin_revoke_device_credentials('11111111-1111-1111-1111-111111111111', null) $$,
  '22023', 'note required', 'so is no note');
reset role;
select is((select count(*)::int from public.device_credentials where revoked_reason = 'admin'), 0, 'nothing revoked yet');
select is((select count(*)::int from admin.admin_actions where action = 'revoke_device_credentials'), 0, 'nor audited');

-- ben: one live, one in its grace (`0d`), one expired, one signed out.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);
select is(public.admin_revoke_device_credentials('22222222-2222-2222-2222-222222222222', 'Lost phone, asked by email'),
  '{"revoked": 2}'::jsonb, 'the admin revokes the user''s two valid credentials');
reset role;

select results_eq(
  $$ select encode(token_hash, 'hex'), revoked_at, revoked_reason from public.device_credentials
     where user_id = '22222222-2222-2222-2222-222222222222' order by 1 $$,
  $$ values (repeat('0d', 32), now(), 'admin'), (repeat('9e', 32), null, null),
            (repeat('9f', 32), now() - interval '1 hour', 'sign_out'), (repeat('b1', 32), now(), 'admin') $$,
  'the live one and the one in its grace are revoked now; expired and signed-out ones are left');
select results_eq(
  $$ select action, target_user_id, details, note, performed_by from admin.admin_actions where action = 'revoke_device_credentials' $$,
  $$ values ('revoke_device_credentials', '22222222-2222-2222-2222-222222222222'::uuid, '{"revoked": 2}'::jsonb,
             'Lost phone, asked by email', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
  'one audit row with the count, the note and the admin');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}', true);
select is(public.admin_revoke_device_credentials('22222222-2222-2222-2222-222222222222', 'Again'),
  '{"revoked": 0}'::jsonb, 'with none left it revokes nothing');
reset role;
select is((select count(*)::int from admin.admin_actions where action = 'revoke_device_credentials'), 2,
  'and is still audited');

-- Account deletion -------------------------------------------------------------------
delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
select is((select count(*)::int from public.device_credentials where user_id = '11111111-1111-1111-1111-111111111111'), 0,
  'deleting the user deletes their credentials');
select is((select count(*)::int from public.device_credentials where user_id = '22222222-2222-2222-2222-222222222222'), 4,
  'and leaves other users'' alone');

select * from finish();
rollback;
