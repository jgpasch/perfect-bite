-- household_invites, create_invite, preview_invite and accept_invite (spec 4.7, 5).
begin;
create extension if not exists pgtap with schema extensions;
select plan(39);

-- Fixtures (as postgres) ------------------------------------------------------
-- Sam owns "Test home" (and has a personal household); Alex is a member of Test home.
-- Kim, Lee and Max belong to nothing in it. Kim already has a household at position 2.
insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated', '{"full_name":"Alex"}'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated', '{"full_name":"Sam"}'),
  ('33333333-3333-3333-3333-333333333333', 'kim@test.local', 'authenticated', 'authenticated', '{"full_name":"Kim"}'),
  ('44444444-4444-4444-4444-444444444444', 'lee@test.local', 'authenticated', 'authenticated', '{"full_name":"Lee"}'),
  ('55555555-5555-5555-5555-555555555555', 'max@test.local', 'authenticated', 'authenticated', '{"full_name":"Max"}');

insert into public.households (id, name, created_by) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Test home', '22222222-2222-2222-2222-222222222222'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Kim''s household', '33333333-3333-3333-3333-333333333333');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'owner', 1),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'member', 1),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '33333333-3333-3333-3333-333333333333', 'owner', 2);

-- Tokens only exist in clear as create_invite's result, so keep them here.
create temp table tokens (name text primary key, token text not null);
grant all on tokens to authenticated, anon;

-- create_invite ---------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);

select lives_ok($$ insert into tokens select 'one', public.create_invite('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
  'an owner creates an invite');
select lives_ok($$ insert into tokens select 'two', public.create_invite('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
  'and another');
select ok((select length(token) = 32 and token ~ '^[A-Za-z0-9_-]+$' from tokens where name = 'one'),
  'the token is 32 URL-safe characters');
select isnt((select token from tokens where name = 'one'), (select token from tokens where name = 'two'),
  'each invite gets its own token');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select lives_ok($$ insert into tokens select 'three', public.create_invite('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
  'a plain member can invite too (Q16)');

select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select throws_ok($$ select public.create_invite('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
  '42501', 'not a member of household aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a non-member cannot invite');
select throws_ok($$ select public.create_invite('dddddddd-dddd-dddd-dddd-dddddddddddd') $$,
  '42501', null, 'an unknown household raises');

select throws_ok($$ select * from public.household_invites $$, '42501', null,
  'the invites table cannot be read directly');
select throws_ok($$ insert into public.household_invites (household_id, token_hash, expires_at)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'x', now() + interval '1 day') $$, '42501', null,
  'nor written');

reset role;
select results_eq($$ select count(*)::int from public.household_invites $$, $$ values (3) $$,
  'three invites are stored');
select results_eq($$ select count(*)::int from public.household_invites i
  join tokens t on i.token_hash = encode(extensions.digest(t.token, 'sha256'), 'hex') $$,
  $$ values (3) $$, 'each invite stores its token''s SHA-256');
select is_empty($$ select 1 from public.household_invites i join tokens t on i.token_hash = t.token $$,
  'and never the token itself');
select results_eq($$ select count(*)::int from public.household_invites
  where expires_at between now() + interval '7 days' - interval '1 minute' and now() + interval '7 days' $$,
  $$ values (3) $$, 'invites expire in 7 days');
select results_eq($$ select created_by from public.household_invites i join tokens t
  on i.token_hash = encode(extensions.digest(t.token, 'sha256'), 'hex') where t.name = 'three' $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid) $$, 'created_by is the caller');

-- preview_invite --------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select results_eq($$ select household_id, household_name, invited_by, status
  from public.preview_invite((select token from tokens where name = 'one')) $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'Test home', 'Sam', 'valid') $$,
  'a non-member sees the household name and who invited');
select throws_ok($$ select * from public.preview_invite('not-a-token') $$, 'P0002', 'invite not found',
  'an unknown token raises');
select throws_ok($$ select * from public.preview_invite(null) $$, 'P0002', 'invite not found',
  'a null token raises');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select results_eq($$ select status from public.preview_invite((select token from tokens where name = 'one')) $$,
  $$ values ('member') $$, 'a member previewing is told so');

-- accept_invite ---------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is_empty($$ select 1 from public.households where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' $$,
  'before accepting, Kim cannot read Test home');
select results_eq($$ select household_id, household_name, already_member
  from public.accept_invite((select token from tokens where name = 'one')) $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'Test home', false) $$,
  'Kim accepts the invite');
select results_eq($$ select role, position from public.household_members
  where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and user_id = '33333333-3333-3333-3333-333333333333' $$,
  $$ values ('member', 3::double precision) $$, 'Kim is a member, after their own households');
select results_eq($$ select name from public.households where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' $$,
  $$ values ('Test home') $$, 'Kim can now read Test home');
select results_eq($$ select role from public.household_members
  where household_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc' and user_id = '33333333-3333-3333-3333-333333333333' $$,
  $$ values ('owner') $$, 'Kim''s other household is not affected');
select results_eq($$ select household_name, already_member
  from public.accept_invite((select token from tokens where name = 'one')) $$,
  $$ values ('Test home', true) $$, 'accepting again says already a member');
select results_eq($$ select count(*)::int from public.household_members where user_id = '33333333-3333-3333-3333-333333333333' $$,
  $$ values (2) $$, 'and adds no second membership');
select results_eq($$ select household_name, already_member
  from public.accept_invite((select token from tokens where name = 'two')) $$,
  $$ values ('Test home', true) $$, 'a member opening another invite is told so');

select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
select results_eq($$ select status from public.preview_invite((select token from tokens where name = 'one')) $$,
  $$ values ('used') $$, 'a used invite previews as used');
select throws_ok($$ select * from public.accept_invite((select token from tokens where name = 'one')) $$,
  '22023', 'invite already used', 'an invite is single use');
select throws_ok($$ select * from public.accept_invite('not-a-token') $$, 'P0002', 'invite not found',
  'an unknown token raises');
select is_empty($$ select 1 from public.household_members where user_id = '44444444-4444-4444-4444-444444444444' $$,
  'a failed accept adds no membership');
select results_eq($$ select household_name, already_member
  from public.accept_invite((select token from tokens where name = 'two')) $$,
  $$ values ('Test home', false) $$, 'an unused invite still works after a member opened it');
select results_eq($$ select position from public.household_members where user_id = '44444444-4444-4444-4444-444444444444' $$,
  $$ values (1::double precision) $$, 'a user with no households gets position 1');

reset role;
select results_eq($$ select used_by from public.household_invites i join tokens t
  on i.token_hash = encode(extensions.digest(t.token, 'sha256'), 'hex') where t.name = 'one' $$,
  $$ values ('33333333-3333-3333-3333-333333333333'::uuid) $$, 'the invite records who used it');
select ok((select used_at is not null from public.household_invites i join tokens t
  on i.token_hash = encode(extensions.digest(t.token, 'sha256'), 'hex') where t.name = 'one'),
  'and when');

-- Expiry: make "three" a day past its 7 days.
update public.household_invites i set expires_at = now() - interval '1 day'
from tokens t where t.name = 'three' and i.token_hash = encode(extensions.digest(t.token, 'sha256'), 'hex');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}', true);
select results_eq($$ select status from public.preview_invite((select token from tokens where name = 'three')) $$,
  $$ values ('expired') $$, 'an expired invite previews as expired');
select throws_ok($$ select * from public.accept_invite((select token from tokens where name = 'three')) $$,
  '22023', 'invite expired', 'an expired invite cannot be accepted');
select is_empty($$ select 1 from public.household_members where user_id = '55555555-5555-5555-5555-555555555555' $$,
  'so Max did not join');

-- Signed out ------------------------------------------------------------------
reset role;
set local role anon;
select throws_ok($$ select public.create_invite('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$, '42501', null,
  'anon cannot create invites');
select throws_ok($$ select * from public.accept_invite((select token from tokens where name = 'two')) $$, '42501', null,
  'anon cannot accept invites');

select * from finish();
rollback;
