-- Push notifications (spec 4.13, 5): push_tokens through register/unregister_push_token,
-- notification_settings with own-row RLS, and private.push_recipients for the worker.
begin;
create extension if not exists pgtap with schema extensions;
select plan(56);

-- Fixtures (as postgres) ------------------------------------------------------
-- Household H: Alex (the actor in most cases), Sam (no settings row: the defaults), Jamie
-- (added items off; quiet 22:00–07:00 New York, two devices), Robin (no token) and Kim
-- (quiet 09:00–17:00 Tokyo). Pat left H and is only in P, but still has a token.
insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated', '{}'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated', '{}'),
  ('33333333-3333-3333-3333-333333333333', 'jamie@test.local', 'authenticated', 'authenticated', '{}'),
  ('44444444-4444-4444-4444-444444444444', 'pat@test.local', 'authenticated', 'authenticated', '{}'),
  ('55555555-5555-5555-5555-555555555555', 'robin@test.local', 'authenticated', 'authenticated', '{}'),
  ('66666666-6666-6666-6666-666666666666', 'kim@test.local', 'authenticated', 'authenticated', '{}');

insert into public.households (id, name) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Home'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', 'Pat''s household');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222', 'member', 1),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333', 'member', 1),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '55555555-5555-5555-5555-555555555555', 'member', 1),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '66666666-6666-6666-6666-666666666666', 'member', 1),
  ('aaaaaaaa-0000-0000-0000-00000000000b', '44444444-4444-4444-4444-444444444444', 'owner', 1);

insert into public.push_tokens (token, user_id, platform) values
  ('ExponentPushToken[alex]', '11111111-1111-1111-1111-111111111111', 'ios'),
  ('ExponentPushToken[sam]', '22222222-2222-2222-2222-222222222222', 'ios'),
  ('ExponentPushToken[jamie-1]', '33333333-3333-3333-3333-333333333333', 'ios'),
  ('ExponentPushToken[jamie-2]', '33333333-3333-3333-3333-333333333333', 'android'),
  ('ExponentPushToken[pat]', '44444444-4444-4444-4444-444444444444', 'ios'),
  ('ExponentPushToken[kim]', '66666666-6666-6666-6666-666666666666', 'ios');

insert into public.notification_settings (user_id, items_added, quiet_hours_start, quiet_hours_end, time_zone) values
  ('33333333-3333-3333-3333-333333333333', false, '22:00', '07:00', 'America/New_York'),
  ('66666666-6666-6666-6666-666666666666', true, '09:00', '17:00', 'Asia/Tokyo');

-- Access ------------------------------------------------------------------------
select ok(
  has_function_privilege('authenticated', 'public.register_push_token(text, text)', 'execute')
  and has_function_privilege('authenticated', 'public.unregister_push_token(text)', 'execute'),
  'authenticated can register and unregister tokens');
select ok(
  not has_function_privilege('anon', 'public.register_push_token(text, text)', 'execute')
  and not has_function_privilege('anon', 'public.unregister_push_token(text)', 'execute'),
  'anon cannot register or unregister tokens');
select ok(
  has_function_privilege('service_role', 'private.push_recipients(uuid, uuid, text, timestamptz)', 'execute'),
  'service_role can run push_recipients');
select ok(
  not has_function_privilege('authenticated', 'private.push_recipients(uuid, uuid, text, timestamptz)', 'execute')
  and not has_function_privilege('anon', 'private.push_recipients(uuid, uuid, text, timestamptz)', 'execute')
  and not has_function_privilege('public', 'private.push_recipients(uuid, uuid, text, timestamptz)', 'execute'),
  'nobody else can run push_recipients');
select ok(
  not has_table_privilege('authenticated', 'public.push_tokens', 'select')
  and not has_table_privilege('authenticated', 'public.push_tokens', 'insert')
  and not has_table_privilege('authenticated', 'public.push_tokens', 'update')
  and not has_table_privilege('authenticated', 'public.push_tokens', 'delete')
  and not has_table_privilege('anon', 'public.push_tokens', 'select'),
  'clients have no direct access to push_tokens');
select ok(
  not has_table_privilege('authenticated', 'public.notification_settings', 'delete')
  and not has_table_privilege('anon', 'public.notification_settings', 'select'),
  'clients cannot delete settings, and anon cannot read them');

-- register_push_token ---------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}', true);

select lives_ok($$ select public.register_push_token('ExponentPushToken[robin_A-1]', 'ios') $$,
  'Robin registers a token');
select throws_ok($$ select * from public.push_tokens $$, '42501', null, 'Robin cannot read push_tokens directly');
select throws_ok(
  $$ insert into public.push_tokens (token, user_id, platform) values ('ExponentPushToken[x]', '55555555-5555-5555-5555-555555555555', 'ios') $$,
  '42501', null, 'Robin cannot insert a token directly');
select throws_ok($$ delete from public.push_tokens $$, '42501', null, 'Robin cannot delete tokens directly');

select throws_ok($$ select public.register_push_token('robin', 'ios') $$,
  '22023', 'invalid token', 'a token without the Expo shape is refused');
select throws_ok($$ select public.register_push_token('ExponentPushToken[]', 'ios') $$,
  '22023', 'invalid token', 'an empty Expo token is refused');
select throws_ok($$ select public.register_push_token('ExponentPushToken[a b]', 'ios') $$,
  '22023', 'invalid token', 'a token with a space is refused');
select throws_ok($$ select public.register_push_token('ExponentPushToken[abc]x', 'ios') $$,
  '22023', 'invalid token', 'trailing text after the bracket is refused');
select throws_ok($$ select public.register_push_token(null, 'ios') $$,
  '22023', 'invalid token', 'a null token is refused');
select throws_ok(format('select public.register_push_token(%L, %L)', 'ExponentPushToken[' || repeat('a', 200) || ']', 'ios'),
  '22023', 'invalid token', 'a token over 200 characters is refused');
select throws_ok($$ select public.register_push_token('ExponentPushToken[robin2]', 'web') $$,
  '22023', 'invalid platform', 'a platform other than ios or android is refused');
select lives_ok($$ select public.register_push_token('ExpoPushToken[robin2]', 'android') $$,
  'the newer ExpoPushToken[…] shape is accepted');

-- Not signed in
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.register_push_token('ExponentPushToken[nobody]', 'ios') $$,
  '42501', 'not signed in', 'registering without a user raises');
select throws_ok($$ select public.unregister_push_token('ExponentPushToken[sam]') $$,
  '42501', 'not signed in', 'unregistering without a user raises');
reset role;

select results_eq(
  $$ select token, platform from public.push_tokens where user_id = '55555555-5555-5555-5555-555555555555' order by platform $$,
  $$ values ('ExpoPushToken[robin2]', 'android'), ('ExponentPushToken[robin_A-1]', 'ios') $$,
  'Robin holds the two tokens that passed, and nothing the refused calls sent');
select is((select count(*)::int from public.push_tokens), 8, 'the refused calls stored nothing');

-- Re-register: the same user bumps updated_at; another user takes the token over.
update public.push_tokens set created_at = '2026-01-01', updated_at = '2026-01-01'
where token = 'ExponentPushToken[robin_A-1]';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}', true);
select lives_ok($$ select public.register_push_token('ExponentPushToken[robin_A-1]', 'ios') $$,
  'Robin registers the same token again');
reset role;
select ok(
  (select updated_at > '2026-01-01' and created_at = '2026-01-01' from public.push_tokens where token = 'ExponentPushToken[robin_A-1]'),
  're-registering bumps updated_at and keeps created_at');

update public.push_tokens set updated_at = '2026-01-01' where token = 'ExponentPushToken[robin_A-1]';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
select lives_ok($$ select public.register_push_token('ExponentPushToken[robin_A-1]', 'android') $$,
  'Pat signs in on Robin''s old device and registers its token');
reset role;
select results_eq(
  $$ select user_id, platform, updated_at > '2026-01-01', created_at = '2026-01-01'
     from public.push_tokens where token = 'ExponentPushToken[robin_A-1]' $$,
  $$ values ('44444444-4444-4444-4444-444444444444'::uuid, 'android', true, true) $$,
  'the token moves to Pat, with the new platform and a bumped updated_at');
select is((select count(*)::int from public.push_tokens where token = 'ExponentPushToken[robin_A-1]'), 1,
  'there is still one row for the token');

-- unregister_push_token
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}', true);
select lives_ok($$ select public.unregister_push_token('ExponentPushToken[robin_A-1]') $$,
  'Robin unregistering the token Pat now holds doesn''t raise');
select lives_ok($$ select public.unregister_push_token('ExponentPushToken[unknown]') $$,
  'unregistering an unknown token doesn''t raise');
select lives_ok($$ select public.unregister_push_token('ExpoPushToken[robin2]') $$,
  'Robin unregisters their own token');
reset role;
select is((select user_id from public.push_tokens where token = 'ExponentPushToken[robin_A-1]'),
  '44444444-4444-4444-4444-444444444444'::uuid, 'someone else''s token is untouched');
select is((select count(*)::int from public.push_tokens where token = 'ExpoPushToken[robin2]'), 0,
  'the caller''s own token is deleted');
select is((select count(*)::int from public.push_tokens where user_id = '55555555-5555-5555-5555-555555555555'), 0,
  'Robin has no tokens left');

-- notification_settings ---------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is((select count(*)::int from public.notification_settings), 0,
  'Sam sees no settings rows: not their own (none yet) and not anyone else''s');
select throws_ok(
  $$ insert into public.notification_settings (user_id) values ('33333333-3333-3333-3333-333333333333') $$,
  '42501', null, 'Sam cannot insert a row for Jamie');
select throws_ok(
  $$ insert into public.notification_settings (user_id, time_zone) values ('22222222-2222-2222-2222-222222222222', 'Mars/Olympus') $$,
  '22023', 'invalid time zone', 'a time zone Postgres doesn''t know is refused');
select throws_ok(
  $$ insert into public.notification_settings (user_id, quiet_hours_start) values ('22222222-2222-2222-2222-222222222222', '22:00') $$,
  '23514', null, 'quiet hours need both a start and an end');
select throws_ok(
  $$ insert into public.notification_settings (user_id, quiet_hours_start, quiet_hours_end) values ('22222222-2222-2222-2222-222222222222', '22:00', '22:00') $$,
  '23514', null, 'quiet hours cannot start and end at the same time');
select lives_ok(
  $$ insert into public.notification_settings (user_id) values ('22222222-2222-2222-2222-222222222222') $$,
  'Sam inserts their own row');
select results_eq(
  $$ select items_added, shopping, quiet_hours_start, quiet_hours_end, time_zone from public.notification_settings $$,
  $$ values (true, true, null::time, null::time, 'UTC') $$,
  'a new row has the defaults: both kinds on, no quiet hours, UTC');
select lives_ok(
  $$ update public.notification_settings set shopping = false, time_zone = 'Europe/Madrid'
     where user_id = '22222222-2222-2222-2222-222222222222' $$,
  'Sam updates their own row');
select throws_ok(
  $$ update public.notification_settings set time_zone = 'Nowhere' where user_id = '22222222-2222-2222-2222-222222222222' $$,
  '22023', 'invalid time zone', 'an update to an unknown time zone is refused');
update public.notification_settings set items_added = true where user_id = '33333333-3333-3333-3333-333333333333';
select throws_ok($$ delete from public.notification_settings $$, '42501', null, 'Sam cannot delete settings');
reset role;
select results_eq(
  $$ select user_id, items_added, shopping, time_zone from public.notification_settings order by user_id $$,
  $$ values ('22222222-2222-2222-2222-222222222222'::uuid, true, false, 'Europe/Madrid'),
            ('33333333-3333-3333-3333-333333333333'::uuid, false, true, 'America/New_York'),
            ('66666666-6666-6666-6666-666666666666'::uuid, true, true, 'Asia/Tokyo') $$,
  'Sam''s update landed, and their update of Jamie''s row changed nothing');

-- Back to the defaults for Sam, so the recipient tests below cover a user with no row.
delete from public.notification_settings where user_id = '22222222-2222-2222-2222-222222222222';

-- push_recipients ----------------------------------------------------------------------
-- 2026-10-17 is EDT (UTC−4) in New York; Tokyo is UTC+9.
set local role service_role;

-- 12:00Z: New York 08:00, Tokyo 21:00. Nobody is in quiet hours; Jamie has added items off.
select results_eq(
  $$ select user_id, token from private.push_recipients('aaaaaaaa-0000-0000-0000-00000000000a',
       '11111111-1111-1111-1111-111111111111', 'items_added', '2026-10-17 12:00Z') $$,
  $$ values ('22222222-2222-2222-2222-222222222222'::uuid, 'ExponentPushToken[sam]'),
            ('66666666-6666-6666-6666-666666666666'::uuid, 'ExponentPushToken[kim]') $$,
  'added items: the actor, a kind switched off, a former member and a user with no token are left out');
select results_eq(
  $$ select user_id, token, platform from private.push_recipients('aaaaaaaa-0000-0000-0000-00000000000a',
       '11111111-1111-1111-1111-111111111111', 'shopping', '2026-10-17 12:00Z') $$,
  $$ values ('22222222-2222-2222-2222-222222222222'::uuid, 'ExponentPushToken[sam]', 'ios'),
            ('33333333-3333-3333-3333-333333333333'::uuid, 'ExponentPushToken[jamie-1]', 'ios'),
            ('33333333-3333-3333-3333-333333333333'::uuid, 'ExponentPushToken[jamie-2]', 'android'),
            ('66666666-6666-6666-6666-666666666666'::uuid, 'ExponentPushToken[kim]', 'ios') $$,
  'shopping: everyone with it on, one row per device');
select results_eq(
  $$ select token from private.push_recipients('aaaaaaaa-0000-0000-0000-00000000000a',
       '22222222-2222-2222-2222-222222222222', 'shopping', '2026-10-17 12:00Z') $$,
  $$ values ('ExponentPushToken[alex]'), ('ExponentPushToken[jamie-1]'), ('ExponentPushToken[jamie-2]'), ('ExponentPushToken[kim]') $$,
  'with Sam as the actor, Alex hears and Sam doesn''t');

-- 03:00Z next day: New York 23:00 (inside 22:00–07:00, past midnight's start), Tokyo 12:00 (inside 09:00–17:00).
select results_eq(
  $$ select token from private.push_recipients('aaaaaaaa-0000-0000-0000-00000000000a',
       '11111111-1111-1111-1111-111111111111', 'shopping', '2026-10-18 03:00Z') $$,
  $$ values ('ExponentPushToken[sam]') $$,
  'quiet hours inside: late evening in a window that wraps midnight, and midday in a daytime window');
-- 10:30Z: New York 06:30 (inside the wrapped window, after midnight), Tokyo 19:30 (outside).
select results_eq(
  $$ select token from private.push_recipients('aaaaaaaa-0000-0000-0000-00000000000a',
       '11111111-1111-1111-1111-111111111111', 'shopping', '2026-10-17 10:30Z') $$,
  $$ values ('ExponentPushToken[sam]'), ('ExponentPushToken[kim]') $$,
  'quiet hours wrapping midnight still hold in the early morning');
-- 11:00Z: New York 07:00 exactly, the end of the window: no longer quiet.
select results_eq(
  $$ select token from private.push_recipients('aaaaaaaa-0000-0000-0000-00000000000a',
       '11111111-1111-1111-1111-111111111111', 'shopping', '2026-10-17 11:00Z') $$,
  $$ values ('ExponentPushToken[sam]'), ('ExponentPushToken[jamie-1]'), ('ExponentPushToken[jamie-2]'), ('ExponentPushToken[kim]') $$,
  'quiet hours end at their end time');
-- 00:00Z: Tokyo 09:00 exactly, the start of the window: quiet. New York 20:00: not yet.
select results_eq(
  $$ select token from private.push_recipients('aaaaaaaa-0000-0000-0000-00000000000a',
       '11111111-1111-1111-1111-111111111111', 'shopping', '2026-10-17 00:00Z') $$,
  $$ values ('ExponentPushToken[sam]'), ('ExponentPushToken[jamie-1]'), ('ExponentPushToken[jamie-2]') $$,
  'quiet hours begin at their start time, in each user''s own time zone');

select is((select count(*)::int from private.push_recipients('aaaaaaaa-0000-0000-0000-00000000000b',
    '11111111-1111-1111-1111-111111111111', 'shopping', '2026-10-17 12:00Z')), 2,
  'in Pat''s household, only Pat hears, on both their devices (one moved from Robin)');
select throws_ok(
  $$ select * from private.push_recipients('aaaaaaaa-0000-0000-0000-00000000000a',
       '11111111-1111-1111-1111-111111111111', 'checked', '2026-10-17 12:00Z') $$,
  '22023', 'invalid kind', 'an unknown kind raises');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select throws_ok(
  $$ select * from private.push_recipients('aaaaaaaa-0000-0000-0000-00000000000a',
       '11111111-1111-1111-1111-111111111111', 'shopping', '2026-10-17 12:00Z') $$,
  '42501', null, 'authenticated cannot run push_recipients');
reset role;

-- Deleting a user cascades -------------------------------------------------------------
select lives_ok($$ select admin.delete_user('33333333-3333-3333-3333-333333333333', 'test') $$,
  'admin.delete_user works with the new foreign keys');
select ok(
  not exists (select 1 from public.push_tokens where user_id = '33333333-3333-3333-3333-333333333333')
  and not exists (select 1 from public.notification_settings where user_id = '33333333-3333-3333-3333-333333333333'),
  'the deleted user''s tokens and settings go with them');

select * from finish();
rollback;
