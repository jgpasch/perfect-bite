-- Email invites: create_invite with an email, list_household_invites, revoke_invite, my_invites,
-- accept_invite_by_id and decline_invite (spec 4.7, 5).
begin;
create extension if not exists pgtap with schema extensions;
select plan(62);

-- Fixtures (as postgres) ------------------------------------------------------
-- Test home: Sam (owner) and Alex. Sam's place: Sam. Pat's flat: Alex. Kim's household: Kim.
-- Lee and Max belong to nothing.
insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated', '{"full_name":"Alex"}'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated', '{"full_name":"Sam"}'),
  ('33333333-3333-3333-3333-333333333333', 'kim@test.local', 'authenticated', 'authenticated', '{"full_name":"Kim"}'),
  ('44444444-4444-4444-4444-444444444444', 'lee@test.local', 'authenticated', 'authenticated', '{"full_name":"Lee"}'),
  ('55555555-5555-5555-5555-555555555555', 'max@test.local', 'authenticated', 'authenticated', '{"full_name":"Max"}');

insert into public.households (id, name, created_by) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Test home', '22222222-2222-2222-2222-222222222222'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sam''s place', '22222222-2222-2222-2222-222222222222'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Kim''s household', '33333333-3333-3333-3333-333333333333'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Pat''s flat', '11111111-1111-1111-1111-111111111111');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'owner', 1),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'member', 1),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner', 2),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '33333333-3333-3333-3333-333333333333', 'owner', 1),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111', 'owner', 2);

-- Tokens only exist in clear as create_invite's result, so keep them here, and the invite ids
-- (looked up as postgres) next to them.
create temp table tokens (name text primary key, token text not null);
create temp table ids (name text primary key, id uuid not null);
grant all on tokens, ids to authenticated, anon;

-- create_invite ---------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","email":"sam@test.local"}', true);

select lives_ok($$ insert into tokens select 'link', public.create_invite('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
  'a link-only invite still works without an email');
select lives_ok($$ insert into tokens select 'kim1', public.create_invite('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '  Kim@Test.LOCAL ') $$,
  'an invite to an email');
select throws_ok($$ select public.create_invite('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', ' ALEX@test.local') $$,
  '23505', 'already a member', 'inviting a member''s email raises');
select throws_ok($$ select public.create_invite('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'not-an-email') $$,
  '22023', 'invalid email', 'an invalid email raises');
select throws_ok($$ select public.create_invite('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '') $$,
  '22023', 'invalid email', 'a blank email raises');
select lives_ok($$ insert into tokens select 'kim2', public.create_invite('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'kim@test.local') $$,
  'inviting the same email again');
select lives_ok($$ insert into tokens select 'lee', public.create_invite('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'lee@test.local') $$,
  'an invite to Lee');
select lives_ok($$ insert into tokens select 'max', public.create_invite('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'max@test.local') $$,
  'an invite to Max');
select lives_ok($$ insert into tokens select 'nobody', public.create_invite('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nobody@test.local') $$,
  'an email with no account is invited the same way');
select lives_ok($$ insert into tokens select 'kimB', public.create_invite('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'kim@test.local') $$,
  'the same email can be invited to another household');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","email":"alex@test.local"}', true);
select lives_ok($$ insert into tokens select 'kimE', public.create_invite('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'kim@test.local') $$,
  'Alex invites Kim to Pat''s flat');

select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","email":"kim@test.local"}', true);
select throws_ok($$ select public.create_invite('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'lee@test.local') $$,
  '42501', 'not a member of household aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a non-member cannot invite an email');

reset role;
insert into ids select t.name, i.id from public.household_invites i
  join tokens t on i.token_hash = encode(extensions.digest(t.token, 'sha256'), 'hex');

select results_eq($$ select invited_email from public.household_invites i join ids using (id) where ids.name = 'kim1' $$,
  $$ values ('kim@test.local') $$, 'the email is stored trimmed and lower-cased');
select results_eq($$ select invited_email from public.household_invites i join ids using (id) where ids.name = 'link' $$,
  $$ values (null::text) $$, 'a link-only invite has no email');
select ok((select revoked_at is not null from public.household_invites join ids using (id) where ids.name = 'kim1'),
  're-inviting the same email revoked the first invite');
select ok((select revoked_at is null and used_at is null and declined_at is null
  from public.household_invites join ids using (id) where ids.name = 'kim2'), 'and the new one is open');
select ok((select revoked_at is null from public.household_invites join ids using (id) where ids.name = 'kimB'),
  'an invite to another household is left alone');
select throws_ok($$ insert into public.household_invites (household_id, token_hash, expires_at, invited_email)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'x1', now() + interval '1 day', 'Pat@test.local') $$,
  '23514', null, 'the table only takes lower-case emails');
select throws_ok($$ insert into public.household_invites (household_id, token_hash, expires_at, invited_email)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'x2', now() + interval '1 day', 'pat') $$,
  '23514', null, 'that look like an email');
select throws_ok($$ insert into public.household_invites (household_id, token_hash, expires_at, invited_email)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'x3', now() + interval '1 day', 'kim@test.local') $$,
  '23505', null, 'and one open invite per household and email');

-- list_household_invites ------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","email":"alex@test.local"}', true);
select set_eq($$ select invited_email, invited_by from public.list_household_invites('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
  $$ values (null::text, 'Sam'), ('kim@test.local', 'Sam'), ('lee@test.local', 'Sam'), ('max@test.local', 'Sam'),
    ('nobody@test.local', 'Sam') $$,
  'a member sees the open invites, link-only ones included, with who sent them');
select set_eq($$ select id from public.list_household_invites('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  where invited_email = 'kim@test.local' $$, $$ select id from ids where name = 'kim2' $$,
  'the revoked invite is not listed');
select ok((select bool_and(expires_at > created_at + interval '6 days')
  from public.list_household_invites('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')), 'with when they were sent and expire');

select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","email":"kim@test.local"}', true);
select throws_ok($$ select * from public.list_household_invites('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
  '42501', 'not a member of household aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a non-member cannot list invites');

-- revoke_invite ---------------------------------------------------------------
select throws_ok($$ select public.revoke_invite((select id from ids where name = 'max')) $$,
  '42501', 'not a member of household aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a non-member cannot revoke an invite');
select throws_ok($$ select public.revoke_invite('dddddddd-dddd-dddd-dddd-dddddddddddd') $$,
  'P0002', 'invite not found', 'an unknown invite raises');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","email":"alex@test.local"}', true);
select lives_ok($$ select public.revoke_invite((select id from ids where name = 'max')) $$,
  'a member revokes an invite someone else sent');
select is_empty($$ select 1 from public.list_household_invites('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  where invited_email = 'max@test.local' $$, 'and it is no longer listed');

-- my_invites ------------------------------------------------------------------
reset role;
-- Pat's flat's invite to Kim has expired.
update public.household_invites set expires_at = now() - interval '1 day'
where id = (select id from ids where name = 'kimE');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","email":"KIM@Test.local"}', true);
select set_eq($$ select id, household_id, household_name, invited_by, member_count from public.my_invites() $$,
  $$ values ((select id from ids where name = 'kim2'), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'Test home', 'Sam', 2),
    ((select id from ids where name = 'kimB'), 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 'Sam''s place', 'Sam', 1) $$,
  'Kim sees the open invites to their email, matched case-insensitively, without the revoked or expired ones');

-- The email doesn't lock the link: Max joins Sam's place with the link sent to Kim.
select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated","email":"max@test.local"}', true);
select results_eq($$ select household_name, already_member from public.accept_invite((select token from tokens where name = 'kimB')) $$,
  $$ values ('Sam''s place', false) $$, 'someone else can join with the link sent to an email');
select is_empty($$ select * from public.my_invites() $$, 'a revoked invite is not shown to its email');

select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","email":"kim@test.local"}', true);
select results_eq($$ select id from public.my_invites() $$, $$ select id from ids where name = 'kim2' $$,
  'a used invite is no longer shown');

select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","email":"lee@test.local"}', true);
select results_eq($$ select id from public.my_invites() $$, $$ select id from ids where name = 'lee' $$,
  'Lee sees their invite');
select results_eq($$ select already_member from public.accept_invite((select token from tokens where name = 'link')) $$,
  $$ values (false) $$, 'Lee joins Test home through a link-only invite');
select is_empty($$ select * from public.my_invites() $$, 'an invite to a household the caller is in is not shown');

select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
select is_empty($$ select * from public.my_invites() $$, 'a caller with no email has no invites');

-- accept_invite_by_id ---------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","email":"lee@test.local"}', true);
select throws_ok($$ select * from public.accept_invite_by_id((select id from ids where name = 'kim2')) $$,
  'P0002', 'invite not found', 'accepting by id needs the invite''s email');
select throws_ok($$ select public.decline_invite((select id from ids where name = 'kim2')) $$,
  'P0002', 'invite not found', 'so does declining');
select throws_ok($$ select * from public.accept_invite_by_id('dddddddd-dddd-dddd-dddd-dddddddddddd') $$,
  'P0002', 'invite not found', 'an unknown id raises');

select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","email":"Kim@test.local"}', true);
select throws_ok($$ select * from public.accept_invite_by_id((select id from ids where name = 'kimE')) $$,
  '22023', 'invite expired', 'an expired invite cannot be accepted by id');
select results_eq($$ select household_id, household_name, already_member
  from public.accept_invite_by_id((select id from ids where name = 'kim2')) $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'Test home', false) $$,
  'Kim accepts their invite by id');
select results_eq($$ select role, position from public.household_members
  where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and user_id = '33333333-3333-3333-3333-333333333333' $$,
  $$ values ('member', 2::double precision) $$, 'Kim is a member, after their own households');
select is_empty($$ select * from public.my_invites() $$, 'and the invite is gone from my_invites');
select results_eq($$ select already_member from public.accept_invite_by_id((select id from ids where name = 'kim2')) $$,
  $$ values (true) $$, 'accepting again says already a member');

select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated","email":"max@test.local"}', true);
select throws_ok($$ select * from public.accept_invite_by_id((select id from ids where name = 'max')) $$,
  '22023', 'invite already used', 'a revoked invite cannot be accepted by id');

reset role;
select results_eq($$ select used_by from public.household_invites where id = (select id from ids where name = 'kim2') $$,
  $$ values ('33333333-3333-3333-3333-333333333333'::uuid) $$, 'the invite records who used it');

-- decline_invite --------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","email":"sam@test.local"}', true);
select lives_ok($$ insert into tokens select 'kimB2', public.create_invite('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'kim@test.local') $$,
  'Sam invites Kim to Sam''s place again');
reset role;
insert into ids select t.name, i.id from public.household_invites i
  join tokens t on i.token_hash = encode(extensions.digest(t.token, 'sha256'), 'hex') where t.name = 'kimB2';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","email":"kim@test.local"}', true);
select results_eq($$ select id from public.my_invites() $$, $$ select id from ids where name = 'kimB2' $$,
  'Kim sees the new invite');
select lives_ok($$ select public.decline_invite((select id from ids where name = 'kimB2')) $$, 'Kim declines it');
select is_empty($$ select * from public.my_invites() $$, 'a declined invite is not shown');
select throws_ok($$ select public.decline_invite((select id from ids where name = 'kimB2')) $$,
  '22023', 'invite already used', 'declining twice raises');
select throws_ok($$ select * from public.accept_invite_by_id((select id from ids where name = 'kimB2')) $$,
  '22023', 'invite already used', 'a declined invite cannot be accepted by id');
select is_empty($$ select 1 from public.household_members
  where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' and user_id = '33333333-3333-3333-3333-333333333333' $$,
  'declining adds no membership');

select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","email":"sam@test.local"}', true);
select is_empty($$ select * from public.list_household_invites('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') $$,
  'a declined invite is not listed for the household');

-- Revoked and declined links --------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","email":"lee@test.local"}', true);
select results_eq($$ select status from public.preview_invite((select token from tokens where name = 'kimB2')) $$,
  $$ values ('used') $$, 'a declined link previews as used');
select throws_ok($$ select * from public.accept_invite((select token from tokens where name = 'kimB2')) $$,
  '22023', 'invite already used', 'and cannot be accepted');

select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated","email":"max@test.local"}', true);
select results_eq($$ select status from public.preview_invite((select token from tokens where name = 'kim1')) $$,
  $$ values ('used') $$, 'a revoked link previews as used');
select throws_ok($$ select * from public.accept_invite((select token from tokens where name = 'kim1')) $$,
  '22023', 'invite already used', 'the old link of a re-sent invite cannot be accepted');
select throws_ok($$ select * from public.accept_invite((select token from tokens where name = 'max')) $$,
  '22023', 'invite already used', 'nor the link of a cancelled invite');
select is_empty($$ select 1 from public.household_members
  where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and user_id = '55555555-5555-5555-5555-555555555555' $$,
  'so Max did not join Test home');

-- Signed out ------------------------------------------------------------------
reset role;
set local role anon;
select throws_ok($$ select * from public.my_invites() $$, '42501', null, 'anon cannot read invites');
select throws_ok($$ select * from public.list_household_invites('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$, '42501', null,
  'nor list a household''s');

select * from finish();
rollback;
