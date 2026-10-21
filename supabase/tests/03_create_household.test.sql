-- create_household and get_household_members (spec 4.7, 4.12, 5).
begin;
create extension if not exists pgtap with schema extensions;
select plan(36);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex has no household yet; Pat already has two (positions 1 and 3.5).
insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated', '{"full_name":"Alex Rivera","avatar_url":"https://img.test/alex.png"}'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated', '{}'),
  ('33333333-3333-3333-3333-333333333333', 'pat@test.local', 'authenticated', 'authenticated', '{}'),
  ('44444444-4444-4444-4444-444444444444', 'zoe@test.local', 'authenticated', 'authenticated', '{"full_name":"Zoe"}'),
  ('55555555-5555-5555-5555-555555555555', 'bea@test.local', 'authenticated', 'authenticated', '{"full_name":"Bea"}');

insert into public.households (id, name, created_by) values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Pat''s household', '33333333-3333-3333-3333-333333333333'),
  ('b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2', 'Pat''s cabin', '33333333-3333-3333-3333-333333333333');
insert into public.household_members (household_id, user_id, role, position) values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '33333333-3333-3333-3333-333333333333', 'owner', 1),
  ('b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2', '33333333-3333-3333-3333-333333333333', 'owner', 3.5);

-- Founding is the default here (the seed makes unlimited the default locally).
update public.plans set is_default = false where is_default;
update public.plans set is_default = true where id = 'founding';

-- create_household as Alex ----------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select lives_ok($$ select public.create_household('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household') $$,
  'Alex creates a household');
select results_eq($$ select id, name, created_by from public.households $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'Alex''s household', '11111111-1111-1111-1111-111111111111'::uuid) $$,
  'the household is stored with created_by = caller');
select results_eq($$ select household_id, user_id, role, position from public.household_members $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, '11111111-1111-1111-1111-111111111111'::uuid, 'owner', 1::double precision) $$,
  'the caller is its owner at position 1 (first household)');

select lives_ok($$ select public.create_household('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household') $$,
  'calling it again for the same id succeeds');
select lives_ok($$ select public.create_household('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Another name') $$,
  'calling it again with a different name succeeds');
select results_eq($$ select name from public.households $$,
  $$ values ('Alex''s household') $$, 'repeat calls change nothing on the household');
select results_eq($$ select count(*)::int, max(position) from public.household_members $$,
  $$ values (1, 1::double precision) $$, 'repeat calls add no membership');

-- One household per new user: a caller already in a household can't make another.
select throws_ok($$ select public.create_household('a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2', 'Alex''s cabin') $$,
  'P0001', 'already in a household', 'Alex, already in a household, can''t create a second');
select is_empty($$ select 1 from public.households where id = 'a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2' $$,
  'the refused household isn''t created');

select throws_ok($$ select public.create_household('cccccccc-cccc-cccc-cccc-cccccccccccc', '') $$,
  '22023', 'household name cannot be blank', 'empty name raises');
select throws_ok($$ select public.create_household('cccccccc-cccc-cccc-cccc-cccccccccccc', '   ') $$,
  '22023', 'household name cannot be blank', 'whitespace-only name raises');
select throws_ok($$ select public.create_household('cccccccc-cccc-cccc-cccc-cccccccccccc', null) $$,
  '22023', 'household name cannot be blank', 'null name raises');
select throws_ok($$ select public.create_household(null, 'No id') $$,
  '22023', 'household id is required', 'null id raises');
select is_empty($$ select 1 from public.households where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc' $$,
  'a blank name creates nothing');

-- Pat, in two households already, is refused too ------------------------------
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select throws_ok($$ select public.create_household('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Pat''s office') $$,
  'P0001', 'already in a household', 'Pat, in two households, can''t create a third');
select is_empty($$ select 1 from public.household_members where household_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd' $$,
  'the refused call adds no membership');

-- Sam can't take over Alex's id --------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select throws_ok($$ select public.create_household('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Sam''s now') $$,
  '42501', null, 'another user creating an existing id raises');

-- No user in the token ----------------------------------------------------------
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.create_household('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Nobody''s') $$,
  '42501', 'not authenticated', 'a call without a user raises');

-- Check side effects as postgres --------------------------------------------------
reset role;
select is_empty($$ select 1 from public.household_members
  where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and user_id = '22222222-2222-2222-2222-222222222222' $$,
  'Sam did not join Alex''s household');
select results_eq($$ select name from public.households where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' $$,
  $$ values ('Alex''s household') $$, 'Sam did not rename Alex''s household');
select is_empty($$ select 1 from public.households where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' $$,
  'a call without a user creates nothing');

-- Plans (spec 4.12): a new household gets the default plan's row ------------------
select results_eq($$ select household_id, plan_id from public.household_plans
  where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'founding') $$,
  'Alex''s new household is on the default plan (founding)');
select is_empty($$ select 1 from public.household_plans
  where household_id in ('a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2', 'dddddddd-dddd-dddd-dddd-dddddddddddd') $$,
  'refused households have no plan row');

-- Changing the default moves no existing household; the next new one starts on it.
update public.plans set is_default = false where is_default;
update public.plans set is_default = true where id = 'free';
select is((select plan_id from public.household_plans where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'founding', 'a new default leaves Alex''s household on founding');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}', true);
select lives_ok($$ select public.create_household('5b5b5b5b-5b5b-5b5b-5b5b-5b5b5b5b5b5b', 'Bea''s') $$,
  'Bea, in no household, creates one');
reset role;
select is((select plan_id from public.household_plans where household_id = '5b5b5b5b-5b5b-5b5b-5b5b-5b5b5b5b5b5b'),
  'free', 'Bea''s household starts on the new default (free)');

-- No default plan: the household is made with no row (so no features).
update public.plans set is_default = false where is_default;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
select lives_ok($$ select public.create_household('4d4d4d4d-4d4d-4d4d-4d4d-4d4d4d4d4d4d', 'Zoe''s') $$,
  'Zoe creates a household while no plan is the default');
reset role;
select is_empty($$ select 1 from public.household_plans where household_id = '4d4d4d4d-4d4d-4d4d-4d4d-4d4d4d4d4d4d' $$,
  'with no default plan the household gets no row');

-- Deleting a household deletes its row.
delete from public.households where id = '5b5b5b5b-5b5b-5b5b-5b5b-5b5b5b5b5b5b';
select is_empty($$ select 1 from public.household_plans where household_id = '5b5b5b5b-5b5b-5b5b-5b5b-5b5b5b5b5b5b' $$,
  'deleting a household deletes its plan row');

-- get_household_members ---------------------------------------------------------
-- Alex's cabin (made directly: Alex can't make a second), then Alex's household gets Zoe
-- (owner), Sam and Bea (members).
insert into public.households (id, name, created_by) values
  ('a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2', 'Alex''s cabin', '11111111-1111-1111-1111-111111111111');
insert into public.household_members (household_id, user_id, role, position) values
  ('a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2', '11111111-1111-1111-1111-111111111111', 'owner', 2);
insert into public.household_members (household_id, user_id, role, position, joined_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44444444-4444-4444-4444-444444444444', 'owner', 1, '2026-01-02T00:00:00Z'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'member', 1, '2026-01-03T00:00:00Z'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55555555-5555-5555-5555-555555555555', 'member', 1, '2026-01-04T00:00:00Z');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select results_eq($$ select * from public.get_household_members('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
  $$ values
    ('11111111-1111-1111-1111-111111111111'::uuid, 'Alex Rivera', 'https://img.test/alex.png', 'owner', now()),
    ('44444444-4444-4444-4444-444444444444'::uuid, 'Zoe', null::text, 'owner', '2026-01-02T00:00:00Z'::timestamptz),
    ('55555555-5555-5555-5555-555555555555'::uuid, 'Bea', null::text, 'member', '2026-01-04T00:00:00Z'::timestamptz),
    ('22222222-2222-2222-2222-222222222222'::uuid, 'sam', null::text, 'member', '2026-01-03T00:00:00Z'::timestamptz) $$,
  'a member gets every member, owners first, then by display name');
select throws_ok($$ select * from public.get_household_members('a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2') $$,
  '42501', null, 'membership is checked per household: Sam can''t read Alex''s cabin');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select results_eq($$ select user_id, display_name, role from public.get_household_members('a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2') $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid, 'Alex Rivera', 'owner') $$,
  'a household with only you returns just your row');

select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select throws_ok($$ select * from public.get_household_members('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
  '42501', null, 'a non-member raises');
select throws_ok($$ select * from public.get_household_members('ffffffff-ffff-ffff-ffff-ffffffffffff') $$,
  '42501', null, 'an unknown household raises');

-- Anonymous -------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '', true);
select throws_ok($$ select public.create_household('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Anon') $$,
  '42501', 'permission denied for function create_household', 'anon cannot call create_household');
select throws_ok($$ select * from public.get_household_members('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
  '42501', 'permission denied for function get_household_members', 'anon cannot call get_household_members');

select * from finish();
rollback;
