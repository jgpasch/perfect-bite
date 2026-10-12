-- Admin (spec 4.7, 4.12, 5): the admin schema is only for the dashboard (postgres), the shared
-- leaving rules, and admin.delete_user with its audit row.
begin;
create extension if not exists pgtap with schema extensions;
select plan(40);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex is the sole member of P (personal), the only owner of S (shared with Pat, who joined
-- before Jamie), and a plain member of J (Jamie's). T has two owners, Sam and Robin, for the
-- helper's "one of several owners" case.
insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated', '{"full_name": "Alex Doe"}'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated', '{}'),
  ('33333333-3333-3333-3333-333333333333', 'jamie@test.local', 'authenticated', 'authenticated', '{}'),
  ('44444444-4444-4444-4444-444444444444', 'pat@test.local', 'authenticated', 'authenticated', '{}'),
  ('55555555-5555-5555-5555-555555555555', 'robin@test.local', 'authenticated', 'authenticated', '{}');

insert into public.households (id, name) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Alex''s household'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', 'Shared'),
  ('aaaaaaaa-0000-0000-0000-00000000000c', 'Jamie''s household'),
  ('aaaaaaaa-0000-0000-0000-00000000000d', 'Two owners');
insert into public.household_members (household_id, user_id, role, position, joined_at) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner', 1, '2026-01-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', 'owner', 2, '2026-01-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', '33333333-3333-3333-3333-333333333333', 'member', 2, '2026-03-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', '44444444-4444-4444-4444-444444444444', 'member', 1, '2026-02-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000c', '33333333-3333-3333-3333-333333333333', 'owner', 1, '2026-01-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000c', '11111111-1111-1111-1111-111111111111', 'member', 3, '2026-02-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000d', '22222222-2222-2222-2222-222222222222', 'owner', 1, '2026-01-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000d', '55555555-5555-5555-5555-555555555555', 'owner', 1, '2026-02-01');

insert into public.lists (id, household_id, name, position) values
  ('b1000000-0000-7000-8000-00000000000a', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Groceries', 1),
  ('b1000000-0000-7000-8000-00000000000b', 'aaaaaaaa-0000-0000-0000-00000000000b', 'Shared groceries', 1),
  ('b1000000-0000-7000-8000-00000000000c', 'aaaaaaaa-0000-0000-0000-00000000000c', 'Jamie''s list', 1);
insert into public.list_items (id, list_id, household_id, ingredient_name, display_name, added_by, checked_by, checked_at) values
  ('b2000000-0000-7000-8000-00000000000a', 'b1000000-0000-7000-8000-00000000000a', 'aaaaaaaa-0000-0000-0000-00000000000a', 'egg', 'eggs', '11111111-1111-1111-1111-111111111111', null, null),
  ('b2000000-0000-7000-8000-00000000000b', 'b1000000-0000-7000-8000-00000000000b', 'aaaaaaaa-0000-0000-0000-00000000000b', 'milk', 'milk', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', now()),
  ('b2000000-0000-7000-8000-00000000000c', 'b1000000-0000-7000-8000-00000000000c', 'aaaaaaaa-0000-0000-0000-00000000000c', 'bread', 'bread', '33333333-3333-3333-3333-333333333333', null, null);
insert into public.recipes (id, household_id, name) values
  ('b3000000-0000-7000-8000-00000000000a', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Omelette'),
  ('b3000000-0000-7000-8000-00000000000b', 'aaaaaaaa-0000-0000-0000-00000000000b', 'Pancakes');
insert into public.recipe_ingredients (id, recipe_id, household_id, ingredient_name, display_name, position) values
  ('b4000000-0000-7000-8000-00000000000a', 'b3000000-0000-7000-8000-00000000000a', 'aaaaaaaa-0000-0000-0000-00000000000a', 'egg', 'eggs', 1),
  ('b4000000-0000-7000-8000-00000000000b', 'b3000000-0000-7000-8000-00000000000b', 'aaaaaaaa-0000-0000-0000-00000000000b', 'milk', 'milk', 1);
insert into public.household_invites (id, household_id, token_hash, created_by, expires_at) values
  ('b5000000-0000-7000-8000-00000000000b', 'aaaaaaaa-0000-0000-0000-00000000000b', 'hash-shared', '11111111-1111-1111-1111-111111111111', now() + interval '7 days');
insert into public.user_settings (user_id, default_list_id) values
  ('11111111-1111-1111-1111-111111111111', 'b1000000-0000-7000-8000-00000000000a'),
  ('44444444-4444-4444-4444-444444444444', 'b1000000-0000-7000-8000-00000000000b');

-- Access ------------------------------------------------------------------------
select ok(
  not has_function_privilege('authenticated', 'admin.delete_user(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'admin.delete_user(uuid, text)', 'execute')
  and not has_function_privilege('service_role', 'admin.delete_user(uuid, text)', 'execute')
  and not has_function_privilege('public', 'admin.delete_user(uuid, text)', 'execute'),
  'nobody but postgres can execute admin.delete_user');
select ok(
  not has_table_privilege('authenticated', 'admin.admin_actions', 'select')
  and not has_table_privilege('anon', 'admin.admin_actions', 'select')
  and not has_table_privilege('service_role', 'admin.admin_actions', 'select'),
  'nobody but postgres can read admin.admin_actions');
select ok(
  not has_schema_privilege('authenticated', 'admin', 'usage')
  and not has_schema_privilege('anon', 'admin', 'usage')
  and not has_schema_privilege('service_role', 'admin', 'usage'),
  'the admin schema is not usable by API roles');
select ok(
  not has_function_privilege('authenticated', 'private.remove_member_from_household(uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'private.remove_member_from_household(uuid, uuid)', 'execute')
  and not has_function_privilege('service_role', 'private.remove_member_from_household(uuid, uuid)', 'execute'),
  'nobody but postgres can run the leaving rules directly');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select throws_ok($$ select admin.delete_user('11111111-1111-1111-1111-111111111111') $$,
  '42501', null, 'authenticated cannot call admin.delete_user');
select throws_ok($$ select * from admin.admin_actions $$, '42501', null, 'authenticated cannot read admin_actions');
reset role;

set local role anon;
select throws_ok($$ select admin.delete_user('11111111-1111-1111-1111-111111111111') $$,
  '42501', null, 'anon cannot call admin.delete_user');
select throws_ok($$ select * from admin.admin_actions $$, '42501', null, 'anon cannot read admin_actions');
reset role;

select is((select count(*)::int from public.household_members where user_id = '11111111-1111-1111-1111-111111111111'),
  3, 'the refused calls changed nothing');

-- The leaving rules on their own ----------------------------------------------------
select is(private.remove_member_from_household('aaaaaaaa-0000-0000-0000-00000000000d', '22222222-2222-2222-2222-222222222222'),
  'left', 'one of several owners leaving just leaves');
select results_eq(
  $$ select user_id, role from public.household_members where household_id = 'aaaaaaaa-0000-0000-0000-00000000000d' $$,
  $$ values ('55555555-5555-5555-5555-555555555555'::uuid, 'owner') $$,
  'the other owner stays the only owner');
select throws_ok(
  $$ select private.remove_member_from_household('aaaaaaaa-0000-0000-0000-00000000000d', '22222222-2222-2222-2222-222222222222') $$,
  '42501', 'not a member', 'removing someone who isn''t a member raises');
select is(private.remove_member_from_household('aaaaaaaa-0000-0000-0000-00000000000d', '55555555-5555-5555-5555-555555555555'),
  'deleted', 'the last member leaving deletes the household');
select is((select count(*)::int from public.households where id = 'aaaaaaaa-0000-0000-0000-00000000000d'),
  0, 'the household is gone');

-- admin.delete_user ---------------------------------------------------------------------
select throws_ok($$ select admin.delete_user('99999999-9999-9999-9999-999999999999', 'typo') $$,
  'P0002', 'user not found', 'an unknown id raises');
select is((select count(*)::int from admin.admin_actions), 0, 'a failed call writes no audit row');

select is(
  admin.delete_user('11111111-1111-1111-1111-111111111111', 'Asked by email on 2026-10-12'),
  jsonb_build_object(
    'email', 'alex@test.local',
    'display_name', 'Alex Doe',
    'households', jsonb_build_array(
      jsonb_build_object('id', 'aaaaaaaa-0000-0000-0000-00000000000a', 'name', 'Alex''s household', 'outcome', 'deleted'),
      jsonb_build_object('id', 'aaaaaaaa-0000-0000-0000-00000000000b', 'name', 'Shared', 'outcome', 'promoted',
        'promoted_user_id', '44444444-4444-4444-4444-444444444444'),
      jsonb_build_object('id', 'aaaaaaaa-0000-0000-0000-00000000000c', 'name', 'Jamie''s household', 'outcome', 'left'))),
  'delete_user returns each household''s outcome, in the user''s household order');

-- The user is gone, with what's theirs
select is((select count(*)::int from auth.users where id = '11111111-1111-1111-1111-111111111111'), 0, 'the auth user is deleted');
select is((select count(*)::int from public.profiles where user_id = '11111111-1111-1111-1111-111111111111'), 0, 'their profile is deleted');
select is((select count(*)::int from public.user_settings where user_id = '11111111-1111-1111-1111-111111111111'), 0, 'their settings are deleted');
select is((select count(*)::int from public.household_members where user_id = '11111111-1111-1111-1111-111111111111'), 0, 'they are in no household');

-- Sole member: the household and its data are deleted
select is((select count(*)::int from public.households where id = 'aaaaaaaa-0000-0000-0000-00000000000a'), 0, 'their personal household is deleted');
select is((select count(*)::int from public.lists where household_id = 'aaaaaaaa-0000-0000-0000-00000000000a'), 0, 'with its lists');
select is((select count(*)::int from public.list_items where household_id = 'aaaaaaaa-0000-0000-0000-00000000000a'), 0, 'its items');
select is((select count(*)::int from public.recipes where household_id = 'aaaaaaaa-0000-0000-0000-00000000000a'), 0, 'its recipes');
select is((select count(*)::int from public.recipe_ingredients where household_id = 'aaaaaaaa-0000-0000-0000-00000000000a'), 0, 'and its recipe ingredients');

-- Last owner of a shared household: the earliest-joined member is promoted, the data stays
select results_eq(
  $$ select user_id, role from public.household_members where household_id = 'aaaaaaaa-0000-0000-0000-00000000000b' order by joined_at $$,
  $$ values ('44444444-4444-4444-4444-444444444444'::uuid, 'owner'), ('33333333-3333-3333-3333-333333333333'::uuid, 'member') $$,
  'Pat, who joined before Jamie, becomes the owner');
select is((select count(*)::int from public.lists where household_id = 'aaaaaaaa-0000-0000-0000-00000000000b'), 1, 'the shared list stays');
select is((select count(*)::int from public.recipe_ingredients where household_id = 'aaaaaaaa-0000-0000-0000-00000000000b'), 1, 'the shared recipe stays');
select results_eq(
  $$ select added_by, checked_by, checked_at is not null from public.list_items where id = 'b2000000-0000-7000-8000-00000000000b' $$,
  $$ values (null::uuid, null::uuid, true) $$,
  'an item they added and checked stays, with added_by and checked_by null');
select results_eq(
  $$ select created_by, used_at, revoked_at from public.household_invites where id = 'b5000000-0000-7000-8000-00000000000b' $$,
  $$ values (null::uuid, null::timestamptz, null::timestamptz) $$,
  'their open invite stays open, with created_by null');
select is((select default_list_id from public.user_settings where user_id = '44444444-4444-4444-4444-444444444444'),
  'b1000000-0000-7000-8000-00000000000b'::uuid, 'another member''s default list in the shared household is untouched');

-- Plain member: the household and its data are unchanged
select results_eq(
  $$ select user_id, role from public.household_members where household_id = 'aaaaaaaa-0000-0000-0000-00000000000c' $$,
  $$ values ('33333333-3333-3333-3333-333333333333'::uuid, 'owner') $$,
  'Jamie''s household keeps its owner');
select results_eq(
  $$ select l.name, i.display_name, i.added_by from public.lists l join public.list_items i on i.list_id = l.id
     where l.household_id = 'aaaaaaaa-0000-0000-0000-00000000000c' $$,
  $$ values ('Jamie''s list', 'bread', '33333333-3333-3333-3333-333333333333'::uuid) $$,
  'and its list and items');

-- The audit row
select is((select count(*)::int from admin.admin_actions), 1, 'one audit row per call');
select results_eq(
  $$ select action, target_user_id, target_household_id, note, performed_by from admin.admin_actions $$,
  $$ values ('delete_user', '11111111-1111-1111-1111-111111111111'::uuid, null::uuid, 'Asked by email on 2026-10-12', 'postgres') $$,
  'the audit row names the action, the user, the note and who ran it');
select is(
  (select details from admin.admin_actions),
  jsonb_build_object(
    'email', 'alex@test.local',
    'display_name', 'Alex Doe',
    'households', jsonb_build_array(
      jsonb_build_object('id', 'aaaaaaaa-0000-0000-0000-00000000000a', 'name', 'Alex''s household', 'outcome', 'deleted'),
      jsonb_build_object('id', 'aaaaaaaa-0000-0000-0000-00000000000b', 'name', 'Shared', 'outcome', 'promoted',
        'promoted_user_id', '44444444-4444-4444-4444-444444444444'),
      jsonb_build_object('id', 'aaaaaaaa-0000-0000-0000-00000000000c', 'name', 'Jamie''s household', 'outcome', 'left'))),
  'the audit details record the email, display name and each household''s outcome');

-- A user in no household still gets deleted and audited, with no note
select is(
  admin.delete_user('55555555-5555-5555-5555-555555555555') -> 'households',
  '[]'::jsonb, 'a user in no household has no household outcomes');
select results_eq(
  $$ select note, details ->> 'email' from admin.admin_actions where target_user_id = '55555555-5555-5555-5555-555555555555' $$,
  $$ values (null::text, 'robin@test.local') $$,
  'and one audit row, without a note');
select is((select count(*)::int from admin.admin_actions), 2, 'two calls, two audit rows');

select * from finish();
rollback;
