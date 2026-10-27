-- First and last name on profiles (spec 5, 4.7, 4.13): the split, sign-up, the checks, updates,
-- the push actor's name and the inviter's name.
begin;
create extension if not exists pgtap with schema extensions;
select plan(40);

-- The split (the backfill from display_name uses it) ---------------------------
select results_eq($$ select * from private.split_name('Alex') $$,
  $$ values ('Alex'::text, null::text) $$, 'one word: the first name, no last name');
select results_eq($$ select * from private.split_name('Alex Rivera') $$,
  $$ values ('Alex'::text, 'Rivera'::text) $$, 'two words');
select results_eq($$ select * from private.split_name('  Alex   Rivera  Diaz ') $$,
  $$ values ('Alex'::text, 'Rivera Diaz'::text) $$, 'three words: the rest is the last name, spaces made one');
select results_eq($$ select * from private.split_name('   ') $$,
  $$ values (null::text, null::text) $$, 'blank: neither');
select results_eq($$ select * from private.split_name(repeat('a', 60) || ' ' || repeat('b', 60)) $$,
  $$ values (repeat('a', 50), repeat('b', 50)) $$, 'each part cut to 50 characters');

select is(private.full_name('Alex', 'Rivera'), 'Alex Rivera', 'full name with a last name');
select is(private.full_name('Alex', null), 'Alex', 'full name without one');

-- The backfill, as the migration ran it on display_name (since dropped), on rows whose names were wiped.
insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('b0000000-0000-0000-0000-000000000001', 'b1@test.local', 'authenticated', 'authenticated', '{}'),
  ('b0000000-0000-0000-0000-000000000002', 'b2@test.local', 'authenticated', 'authenticated', '{}'),
  ('b0000000-0000-0000-0000-000000000003', 'b3@test.local', 'authenticated', 'authenticated', '{}');
update public.profiles p
set first_name = coalesce((private.split_name(v.d)).first_name, 'Someone'),
    last_name  = (private.split_name(v.d)).last_name
from (values ('b0000000-0000-0000-0000-000000000001'::uuid, 'Cher'),
             ('b0000000-0000-0000-0000-000000000002'::uuid, 'Ada Lovelace'),
             ('b0000000-0000-0000-0000-000000000003'::uuid, 'Gabriel García Márquez')) v(id, d)
where p.user_id = v.id;
select results_eq(
  $$ select first_name, last_name from public.profiles where user_id::text like 'b0000000-%' order by user_id $$,
  $$ values ('Cher'::text, null::text), ('Ada', 'Lovelace'), ('Gabriel', 'García Márquez') $$,
  'backfill: one, two and three words');

-- Sign-up ---------------------------------------------------------------------
insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('c0000000-0000-0000-0000-000000000001', 'given@test.local', 'authenticated', 'authenticated',
   '{"given_name": " Mary Ann ", "family_name": "Smith", "full_name": "Someone Else", "name": "Other",
     "avatar_url": "https://example.com/mary.png"}'),
  ('c0000000-0000-0000-0000-000000000002', 'nofamily@test.local', 'authenticated', 'authenticated',
   '{"given_name": "Prince", "family_name": "  ", "full_name": "Prince Rogers"}'),
  ('c0000000-0000-0000-0000-000000000003', 'full@test.local', 'authenticated', 'authenticated',
   '{"full_name": "Alex  Rivera Diaz"}'),
  ('c0000000-0000-0000-0000-000000000004', 'one@test.local', 'authenticated', 'authenticated',
   '{"full_name": "Madonna"}'),
  ('c0000000-0000-0000-0000-000000000005', 'name@test.local', 'authenticated', 'authenticated',
   '{"full_name": " ", "given_name": "", "name": "Sam Lee"}'),
  ('c0000000-0000-0000-0000-000000000006', 'sam.lee@test.local', 'authenticated', 'authenticated', '{}'),
  ('c0000000-0000-0000-0000-000000000007', null, 'authenticated', 'authenticated', null);
select results_eq(
  $$ select first_name, last_name from public.profiles where user_id::text like 'c0000000-%' order by user_id $$,
  $$ values ('Mary Ann'::text, 'Smith'::text), ('Prince', null), ('Alex', 'Rivera Diaz'), ('Madonna', null),
            ('Sam', 'Lee'), ('sam.lee', null), ('Someone', null) $$,
  'given/family name, a blank family name, only full_name (three and one words), name, only an email, nothing');
select is((select avatar_url from public.profiles where user_id = 'c0000000-0000-0000-0000-000000000001'),
  'https://example.com/mary.png', 'the avatar is still filled as before');

-- The checks ------------------------------------------------------------------
select throws_ok($$ update public.profiles set first_name = '' where user_id = 'c0000000-0000-0000-0000-000000000003' $$,
  '23514', null, 'blank first name');
select throws_ok($$ update public.profiles set first_name = null where user_id = 'c0000000-0000-0000-0000-000000000003' $$,
  '23502', null, 'null first name');
select throws_ok($$ update public.profiles set first_name = repeat('a', 51) where user_id = 'c0000000-0000-0000-0000-000000000003' $$,
  '23514', null, '51-character first name');
select throws_ok($$ update public.profiles set first_name = ' Alex' where user_id = 'c0000000-0000-0000-0000-000000000003' $$,
  '23514', null, 'untrimmed first name (leading)');
select throws_ok($$ update public.profiles set first_name = 'Alex ' where user_id = 'c0000000-0000-0000-0000-000000000003' $$,
  '23514', null, 'untrimmed first name (trailing)');
select throws_ok($$ update public.profiles set last_name = '' where user_id = 'c0000000-0000-0000-0000-000000000003' $$,
  '23514', null, 'blank last name (null instead)');
select throws_ok($$ update public.profiles set last_name = repeat('b', 51) where user_id = 'c0000000-0000-0000-0000-000000000003' $$,
  '23514', null, '51-character last name');
select throws_ok($$ update public.profiles set last_name = E'Rivera\t' where user_id = 'c0000000-0000-0000-0000-000000000003' $$,
  '23514', null, 'untrimmed last name');
select lives_ok($$ update public.profiles set first_name = repeat('a', 50), last_name = repeat('b', 50)
                   where user_id = 'c0000000-0000-0000-0000-000000000003' $$, '50 characters each are fine');

-- Updates by users ------------------------------------------------------------
select ok(
  has_column_privilege('authenticated', 'public.profiles', 'first_name', 'update')
  and has_column_privilege('authenticated', 'public.profiles', 'last_name', 'update'),
  'clients can update first_name and last_name');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0000000-0000-0000-0000-000000000004"}', true);
update public.profiles set first_name = 'Louise', last_name = 'Ciccone'
where user_id = 'c0000000-0000-0000-0000-000000000004';
select results_eq($$ select first_name, last_name from public.profiles where user_id = 'c0000000-0000-0000-0000-000000000004' $$,
  $$ values ('Louise'::text, 'Ciccone'::text) $$, 'a user sets their own first and last name');
update public.profiles set last_name = null where user_id = 'c0000000-0000-0000-0000-000000000004';
select is((select last_name from public.profiles where user_id = 'c0000000-0000-0000-0000-000000000004'),
  null, 'and clears their last name');
select throws_ok($$ update public.profiles set first_name = ' ' where user_id = 'c0000000-0000-0000-0000-000000000004' $$,
  '23514', null, 'but can''t blank their first name');
update public.profiles set first_name = 'Hacked', last_name = 'Hacked'
where user_id = 'c0000000-0000-0000-0000-000000000003';
reset role;
select results_eq($$ select first_name, last_name from public.profiles where user_id = 'c0000000-0000-0000-0000-000000000003' $$,
  $$ values (repeat('a', 50), repeat('b', 50)) $$, 'nor someone else''s');

-- The push actor's name ---------------------------------------------------------
-- Household H: Alex Rivera (actor), Sam. Household O: another Alex. List G on H, D on H (deleted).
insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('d0000000-0000-0000-0000-000000000001', 'alex@test.local', 'authenticated', 'authenticated', '{"given_name": "Alex", "family_name": "rivera"}'),
  ('d0000000-0000-0000-0000-000000000002', 'sam@test.local', 'authenticated', 'authenticated', '{"full_name": "Sam Lee"}'),
  ('d0000000-0000-0000-0000-000000000003', 'alex2@test.local', 'authenticated', 'authenticated', '{"full_name": "ALEX Moreno"}'),
  ('d0000000-0000-0000-0000-000000000004', 'solo@test.local', 'authenticated', 'authenticated', '{"full_name": "Sam"}');
insert into public.households (id, name) values
  ('dddddddd-0000-0000-0000-000000000001', 'H'),
  ('dddddddd-0000-0000-0000-000000000002', 'O');
insert into public.household_members (household_id, user_id, role, position) values
  ('dddddddd-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'owner', 1),
  ('dddddddd-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002', 'member', 2),
  ('dddddddd-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000003', 'owner', 1);
insert into public.lists (id, household_id, name, position, deleted_at) values
  ('d1000000-0000-7000-8000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'G', 1, null),
  ('d1000000-0000-7000-8000-000000000002', 'dddddddd-0000-0000-0000-000000000001', 'D', 2, now());

create function pg_temp.actor(p_actor uuid, p_list uuid default 'd1000000-0000-7000-8000-000000000001')
returns text language sql as $$
  select public.notification_group('items_added', p_list, p_actor, '{}') ->> 'actor_name';
$$;

select is(pg_temp.actor('d0000000-0000-0000-0000-000000000001'), 'Alex',
  'no clash: the first name (an Alex in another household doesn''t count)');
insert into public.household_members (household_id, user_id, role, position) values
  ('dddddddd-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000003', 'member', 3);
select is(pg_temp.actor('d0000000-0000-0000-0000-000000000001'), 'Alex R.',
  'a clash (case-insensitive): plus the last name''s initial, uppercased');
select is(pg_temp.actor('d0000000-0000-0000-0000-000000000003'), 'ALEX M.', 'both sides of the clash get it');
select is(pg_temp.actor('d0000000-0000-0000-0000-000000000001', 'd1000000-0000-7000-8000-000000000002'), 'Alex R.',
  'a deleted list still finds its household');
update public.profiles set last_name = null where user_id = 'd0000000-0000-0000-0000-000000000001';
select is(pg_temp.actor('d0000000-0000-0000-0000-000000000001'), 'Alex', 'a clash with no last name: the first name');
update public.profiles set last_name = 'Rivera' where user_id = 'd0000000-0000-0000-0000-000000000001';
delete from public.household_members
where household_id = 'dddddddd-0000-0000-0000-000000000001' and user_id = 'd0000000-0000-0000-0000-000000000003';
select is(pg_temp.actor('d0000000-0000-0000-0000-000000000001'), 'Alex', 'a member who left doesn''t clash');
select is(pg_temp.actor('d0000000-0000-0000-0000-000000000002'), 'Sam',
  'Sam: no other Sam in the household (the Sam elsewhere doesn''t count)');
select is(pg_temp.actor('99999999-9999-9999-9999-999999999999'), null, 'no profile: null');

-- The inviter's name ------------------------------------------------------------
insert into public.household_invites (household_id, token_hash, created_by, expires_at, invited_email) values
  ('dddddddd-0000-0000-0000-000000000001', private.invite_token_hash('tok-alex'),
   'd0000000-0000-0000-0000-000000000001', now() + interval '7 days', 'solo@test.local'),
  ('dddddddd-0000-0000-0000-000000000002', private.invite_token_hash('tok-alex2'),
   'd0000000-0000-0000-0000-000000000003', now() + interval '7 days', null);
update public.profiles set last_name = null where user_id = 'd0000000-0000-0000-0000-000000000003';
-- my_invites only matches a confirmed email.
update auth.users set email_confirmed_at = now() where id = 'd0000000-0000-0000-0000-000000000004';

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "d0000000-0000-0000-0000-000000000004", "email": "solo@test.local"}', true);
select is((select invited_by from public.preview_invite('tok-alex')), 'Alex Rivera', 'preview_invite: the full name');
select is((select invited_by from public.preview_invite('tok-alex2')), 'ALEX', 'preview_invite: no last name');
select is((select invited_by from public.my_invites()), 'Alex Rivera', 'my_invites: the full name');
select set_config('request.jwt.claims', '{"sub": "d0000000-0000-0000-0000-000000000002"}', true);
select is((select invited_by from public.list_household_invites('dddddddd-0000-0000-0000-000000000001')),
  'Alex Rivera', 'list_household_invites: the full name');
reset role;

select is(
  (select array_agg(a.name order by a.ord) from pg_proc p,
     unnest(p.proargnames, p.proargmodes) with ordinality a(name, mode, ord)
   where p.oid = 'public.preview_invite(text)'::regprocedure and a.mode = 't'),
  array['household_id', 'household_name', 'invited_by', 'status']::text[], 'preview_invite keeps its columns');
select is(
  (select array_agg(a.name order by a.ord) from pg_proc p,
     unnest(p.proargnames, p.proargmodes) with ordinality a(name, mode, ord)
   where p.oid = 'public.list_household_invites(uuid)'::regprocedure and a.mode = 't'),
  array['id', 'invited_email', 'invited_by', 'created_at', 'expires_at']::text[], 'list_household_invites keeps its columns');
select is(
  (select array_agg(a.name order by a.ord) from pg_proc p,
     unnest(p.proargnames, p.proargmodes) with ordinality a(name, mode, ord)
   where p.oid = 'public.my_invites()'::regprocedure and a.mode = 't'),
  array['id', 'household_id', 'household_name', 'invited_by', 'member_count']::text[], 'my_invites keeps its columns');

-- Privileges --------------------------------------------------------------------
select ok(
  not has_function_privilege('authenticated', 'private.full_name(text, text)', 'execute')
  and not has_function_privilege('authenticated', 'private.split_name(text)', 'execute')
  and not has_function_privilege('authenticated', 'private.clean_name(text)', 'execute'),
  'clients can''t call the name helpers');

select * from finish();
rollback;
