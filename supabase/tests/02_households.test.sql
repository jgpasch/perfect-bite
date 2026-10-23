-- Households and members: readable by members only, no direct writes (spec 4.7, 5).
begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex (owner) and Sam share household A; Pat is alone in household P.
insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated', '{"full_name":"Alex Rivera"}'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated', '{}'),
  ('33333333-3333-3333-3333-333333333333', 'pat@test.local', 'authenticated', 'authenticated', '{}');

insert into public.households (id, name, created_by) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Pat''s household', '33333333-3333-3333-3333-333333333333');

insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'member', 1),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '33333333-3333-3333-3333-333333333333', 'owner', 1);

select has_trigger('public', 'households', 'households_set_updated_at', 'households keep updated_at current');
select throws_ok($$ insert into public.household_members (household_id, user_id, role, position)
  values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 'admin', 2) $$,
  '23514', null, 'role must be owner or member');

-- Act as Alex -----------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select results_eq($$ select private.my_household_ids() $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid) $$, 'my_household_ids returns Alex''s households');
select results_eq($$ select id, name from public.households $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'Alex''s household') $$,
  'Alex sees the shared household only');
select is_empty($$ select 1 from public.households where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' $$,
  'Alex cannot see Pat''s household');
select results_eq($$ select household_id, user_id, role from public.household_members order by user_id $$,
  $$ values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, '11111111-1111-1111-1111-111111111111'::uuid, 'owner'),
            ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, '22222222-2222-2222-2222-222222222222'::uuid, 'member') $$,
  'Alex sees both member rows of the shared household and nothing else');
select is_empty($$ select 1 from public.household_members where user_id = '33333333-3333-3333-3333-333333333333' $$,
  'Alex cannot see Pat''s membership');

select results_eq($$ select user_id, first_name, last_name from public.profiles order by user_id $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid, 'Alex', 'Rivera'),
            ('22222222-2222-2222-2222-222222222222'::uuid, 'sam', null::text) $$,
  'Alex reads own and Sam''s profiles');
select is_empty($$ select 1 from public.profiles where user_id = '33333333-3333-3333-3333-333333333333' $$,
  'Alex cannot read Pat''s profile');

select throws_ok($$ insert into public.households (id, name) values ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Mine') $$,
  '42501', null, 'clients cannot insert households');
select throws_ok($$ insert into public.household_members (household_id, user_id, position)
  values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 2) $$,
  '42501', null, 'clients cannot add themselves to a household');
select throws_ok($$ update public.households set name = 'Renamed' $$,
  '42501', null, 'clients cannot update households directly');
select throws_ok($$ update public.household_members set role = 'owner' $$,
  '42501', null, 'clients cannot change roles directly');
select throws_ok($$ delete from public.household_members $$,
  '42501', null, 'clients cannot delete memberships directly');

-- Act as Pat ------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);

select results_eq($$ select user_id from public.household_members $$,
  $$ values ('33333333-3333-3333-3333-333333333333'::uuid) $$, 'Pat sees only own household''s members');

-- Anonymous -------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '', true);
select throws_ok($$ select * from public.households $$, '42501', null, 'anon cannot read households');
select throws_ok($$ select * from public.household_members $$, '42501', null, 'anon cannot read household members');
select throws_ok($$ select private.my_household_ids() $$, '42501', null, 'anon cannot call my_household_ids');

select * from finish();
rollback;
