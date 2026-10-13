-- Owner actions (spec 4.7, 5): set_member_role (make owner, step back to member) and
-- delete_household.
begin;
create extension if not exists pgtap with schema extensions;
select plan(49);

-- Fixtures (as postgres) ------------------------------------------------------
-- R (roles): Alex owns it; Pat and Robin are members. D (to delete): Jamie owns it and Pat is a
-- member; it's Jamie's only household, Pat also has R. X: Alex alone. Sam is in only their own.
-- Jamie's and Pat's Siri default list is D's list.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'jamie@test.local', 'authenticated', 'authenticated'),
  ('44444444-4444-4444-4444-444444444444', 'pat@test.local', 'authenticated', 'authenticated'),
  ('55555555-5555-5555-5555-555555555555', 'robin@test.local', 'authenticated', 'authenticated');

insert into public.households (id, name) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Roles'),
  ('aaaaaaaa-0000-0000-0000-00000000000d', 'Doomed'),
  ('aaaaaaaa-0000-0000-0000-00000000000e', 'Alex extra'),
  ('aaaaaaaa-0000-0000-0000-00000000000f', 'Sam''s household');
insert into public.household_members (household_id, user_id, role, position, joined_at) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner', 1, '2026-01-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '44444444-4444-4444-4444-444444444444', 'member', 1, '2026-02-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '55555555-5555-5555-5555-555555555555', 'member', 1, '2026-03-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000d', '33333333-3333-3333-3333-333333333333', 'owner', 1, '2026-01-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000d', '44444444-4444-4444-4444-444444444444', 'member', 2, '2026-02-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000e', '11111111-1111-1111-1111-111111111111', 'owner', 2, '2026-01-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000f', '22222222-2222-2222-2222-222222222222', 'owner', 1, '2026-01-01');

insert into public.lists (id, household_id, name, position) values
  ('b1000000-0000-7000-8000-00000000000d', 'aaaaaaaa-0000-0000-0000-00000000000d', 'Doomed list', 1),
  ('b1000000-0000-7000-8000-00000000000e', 'aaaaaaaa-0000-0000-0000-00000000000e', 'Extra list', 1);
insert into public.list_items (id, list_id, household_id, ingredient_name, display_name) values
  ('b2000000-0000-7000-8000-00000000000d', 'b1000000-0000-7000-8000-00000000000d', 'aaaaaaaa-0000-0000-0000-00000000000d', 'milk', 'milk');
insert into public.recipes (id, household_id, name) values
  ('b3000000-0000-7000-8000-00000000000d', 'aaaaaaaa-0000-0000-0000-00000000000d', 'Pancakes');
insert into public.categories (id, name, household_id) values
  ('cccccccc-0000-7000-8000-00000000000d', 'Doomed aisle', 'aaaaaaaa-0000-0000-0000-00000000000d');
insert into public.household_category_overrides (household_id, ingredient_name, category_id) values
  ('aaaaaaaa-0000-0000-0000-00000000000d', 'banana', 'cccccccc-0000-7000-8000-00000000000d');
insert into public.household_invites (household_id, token_hash, expires_at) values
  ('aaaaaaaa-0000-0000-0000-00000000000d', 'doomed-invite', now() + interval '7 days');
insert into public.user_settings (user_id, default_list_id) values
  ('33333333-3333-3333-3333-333333333333', 'b1000000-0000-7000-8000-00000000000d'),
  ('44444444-4444-4444-4444-444444444444', 'b1000000-0000-7000-8000-00000000000d');

create temp table results (step text primary key, result jsonb);
grant all on results to authenticated;
insert into results select 'households_before', to_jsonb(count(*)) from public.households;
insert into results select 'admin_actions_before', to_jsonb(count(*)) from admin.admin_actions;

-- Access ------------------------------------------------------------------------
select ok(
  has_function_privilege('authenticated', 'public.set_member_role(uuid, uuid, text)', 'execute')
  and has_function_privilege('authenticated', 'public.delete_household(uuid)', 'execute'),
  'signed-in users can call set_member_role and delete_household');
select ok(
  not has_function_privilege('anon', 'public.set_member_role(uuid, uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.delete_household(uuid)', 'execute')
  and not has_function_privilege('public', 'public.set_member_role(uuid, uuid, text)', 'execute')
  and not has_function_privilege('public', 'public.delete_household(uuid)', 'execute'),
  'anon and public can call neither');

-- Refused role changes ------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.set_member_role('aaaaaaaa-0000-0000-0000-00000000000a', '44444444-4444-4444-4444-444444444444', 'owner') $$,
  '42501', 'not authenticated', 'changing a role needs a signed-in user');
select throws_ok($$ select public.delete_household('aaaaaaaa-0000-0000-0000-00000000000a') $$,
  '42501', 'not authenticated', 'deleting a household needs a signed-in user');

select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select throws_ok($$ select public.set_member_role('aaaaaaaa-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222', 'owner') $$,
  '42501', 'not an owner', 'a non-member can''t make themselves an owner');
select throws_ok($$ select public.delete_household('aaaaaaaa-0000-0000-0000-00000000000a') $$,
  '42501', 'not an owner', 'a non-member can''t delete a household');
select throws_ok($$ select public.delete_household('aaaaaaaa-0000-0000-0000-0000000000ff') $$,
  '42501', 'not an owner', 'deleting a household that doesn''t exist raises not an owner');

select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}', true);
select throws_ok($$ select public.set_member_role('aaaaaaaa-0000-0000-0000-00000000000a', '55555555-5555-5555-5555-555555555555', 'owner') $$,
  '42501', 'not an owner', 'a plain member can''t make themselves an owner');
select throws_ok($$ select public.set_member_role('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'member') $$,
  '42501', 'not an owner', 'a plain member can''t demote an owner');
select throws_ok($$ select public.delete_household('aaaaaaaa-0000-0000-0000-00000000000a') $$,
  '42501', 'not an owner', 'a plain member can''t delete the household');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select public.set_member_role('aaaaaaaa-0000-0000-0000-00000000000a', '44444444-4444-4444-4444-444444444444', 'admin') $$,
  '22023', 'invalid role', 'a role other than owner or member is refused');
select throws_ok($$ select public.set_member_role('aaaaaaaa-0000-0000-0000-00000000000a', '44444444-4444-4444-4444-444444444444', null) $$,
  '22023', 'invalid role', 'a null role is refused');
select throws_ok($$ select public.set_member_role('aaaaaaaa-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222', 'owner') $$,
  '42501', 'not a member', 'an owner can''t give a role to someone who isn''t a member');
select throws_ok($$ select public.set_member_role('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'member') $$,
  'P0001', 'last owner', 'the only owner can''t step down');

reset role;
select results_eq(
  $$ select user_id, role from public.household_members where household_id = 'aaaaaaaa-0000-0000-0000-00000000000a' order by user_id $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid, 'owner'), ('44444444-4444-4444-4444-444444444444'::uuid, 'member'),
            ('55555555-5555-5555-5555-555555555555'::uuid, 'member') $$,
  'the refused calls changed no roles');
select is((select count(*)::int from public.households),
  (select (result #>> '{}')::int from results where step = 'households_before'), 'the refused calls deleted no households');

-- Make owner, no-ops, stepping down ------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select lives_ok($$ select public.set_member_role('aaaaaaaa-0000-0000-0000-00000000000a', '44444444-4444-4444-4444-444444444444', 'owner') $$,
  'Alex makes Pat an owner');
select results_eq($$ select role from public.household_members where household_id = 'aaaaaaaa-0000-0000-0000-00000000000a' and user_id = '44444444-4444-4444-4444-444444444444' $$,
  $$ values ('owner') $$, 'Pat is now an owner, as Alex reads it');
select lives_ok($$ select public.set_member_role('aaaaaaaa-0000-0000-0000-00000000000a', '44444444-4444-4444-4444-444444444444', 'owner') $$,
  'making an owner an owner again is accepted');
select lives_ok($$ select public.set_member_role('aaaaaaaa-0000-0000-0000-00000000000a', '55555555-5555-5555-5555-555555555555', 'member') $$,
  'making a member a member is accepted');
reset role;
select results_eq(
  $$ select user_id, role from public.household_members where household_id = 'aaaaaaaa-0000-0000-0000-00000000000a' order by user_id $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid, 'owner'), ('44444444-4444-4444-4444-444444444444'::uuid, 'owner'),
            ('55555555-5555-5555-5555-555555555555'::uuid, 'member') $$,
  'setting the role someone already has changes nothing');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select lives_ok($$ select public.set_member_role('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'member') $$,
  'Alex steps down while Pat is still an owner');
select results_eq($$ select role from public.household_members where household_id = 'aaaaaaaa-0000-0000-0000-00000000000a' and user_id = '11111111-1111-1111-1111-111111111111' $$,
  $$ values ('member') $$, 'Alex is now a member');
select throws_ok($$ select public.set_member_role('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner') $$,
  '42501', 'not an owner', 'having stepped down, Alex can''t make themselves an owner again');

select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
select throws_ok($$ select public.set_member_role('aaaaaaaa-0000-0000-0000-00000000000a', '44444444-4444-4444-4444-444444444444', 'member') $$,
  'P0001', 'last owner', 'Pat, now the only owner, can''t step down');
select lives_ok($$ select public.set_member_role('aaaaaaaa-0000-0000-0000-00000000000a', '55555555-5555-5555-5555-555555555555', 'owner') $$,
  'Pat makes Robin an owner');
select lives_ok($$ select public.set_member_role('aaaaaaaa-0000-0000-0000-00000000000a', '55555555-5555-5555-5555-555555555555', 'member') $$,
  'Pat demotes Robin, another owner');

reset role;
select results_eq(
  $$ select user_id, role from public.household_members where household_id = 'aaaaaaaa-0000-0000-0000-00000000000a' order by user_id $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid, 'member'), ('44444444-4444-4444-4444-444444444444'::uuid, 'owner'),
            ('55555555-5555-5555-5555-555555555555'::uuid, 'member') $$,
  'Pat is the one owner left; Alex and Robin are members');

-- Jamie deletes D, their only household; Pat is also in R ----------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
select throws_ok($$ select public.delete_household('aaaaaaaa-0000-0000-0000-00000000000d') $$,
  '42501', 'not an owner', 'Pat, a plain member of D, can''t delete it');

select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
insert into results select 'jamie_deletes', public.delete_household('aaaaaaaa-0000-0000-0000-00000000000d');
select results_eq($$ select name from public.households $$, $$ values ('Personal') $$,
  'Jamie reads only the new "Personal" household');
select results_eq($$ select name from public.lists $$, $$ values ('Groceries') $$,
  'and only its "Groceries" list');

reset role;
select results_eq(
  $$ select h.id, h.name, hm.role from public.household_members hm
     join public.households h on h.id = hm.household_id where hm.user_id = '33333333-3333-3333-3333-333333333333' $$,
  $$ select (result ->> 'new_household_id')::uuid, 'Personal'::text, 'owner'::text from results where step = 'jamie_deletes' $$,
  'the caller, left with no household, owns a new "Personal" whose id is returned');
select is(
  (select default_list_id from public.user_settings where user_id = '33333333-3333-3333-3333-333333333333'),
  (select l.id from public.lists l
   where l.household_id = (select (result ->> 'new_household_id')::uuid from results where step = 'jamie_deletes')),
  'Jamie''s default list, which was in D, now points at the new Groceries list');
select is((select default_list_id from public.user_settings where user_id = '44444444-4444-4444-4444-444444444444'),
  null::uuid, 'Pat''s default list, which was in D, is cleared');
select results_eq(
  $$ select household_id from public.household_members where user_id = '44444444-4444-4444-4444-444444444444' $$,
  $$ values ('aaaaaaaa-0000-0000-0000-00000000000a'::uuid) $$,
  'Pat, who still has R, is left alone and gets no new household');

select is_empty($$ select 1 from public.households where id = 'aaaaaaaa-0000-0000-0000-00000000000d' $$, 'D is deleted');
select is_empty($$ select 1 from public.household_members where household_id = 'aaaaaaaa-0000-0000-0000-00000000000d' $$,
  'with every membership, so each member''s devices hear the delete and purge it');
select is_empty($$ select 1 from public.lists where household_id = 'aaaaaaaa-0000-0000-0000-00000000000d' $$, 'and its lists');
select is_empty($$ select 1 from public.list_items where household_id = 'aaaaaaaa-0000-0000-0000-00000000000d' $$, 'and its items');
select is_empty($$ select 1 from public.recipes where household_id = 'aaaaaaaa-0000-0000-0000-00000000000d' $$, 'and its recipes');
select is_empty($$ select 1 from public.household_category_overrides where household_id = 'aaaaaaaa-0000-0000-0000-00000000000d' $$,
  'and its overrides');
select is_empty($$ select 1 from public.categories where household_id = 'aaaaaaaa-0000-0000-0000-00000000000d' $$,
  'and its custom aisles');
select is_empty($$ select 1 from public.household_invites where household_id = 'aaaaaaaa-0000-0000-0000-00000000000d' $$,
  'and its invites');
select ok(
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'household_members'),
  'membership deletes are published to Realtime');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
select results_eq($$ select household_id from public.household_members where user_id = '44444444-4444-4444-4444-444444444444' $$,
  $$ values ('aaaaaaaa-0000-0000-0000-00000000000a'::uuid) $$,
  'a pull of Pat''s memberships no longer lists D');
select is(
  public.apply_mutations($$ [{ "table": "list_items", "id": "b2000000-0000-7000-8000-0000000000ff", "hlc": "1760000000000-0001-pat1",
    "fields": { "list_id": "b1000000-0000-7000-8000-00000000000d", "household_id": "aaaaaaaa-0000-0000-0000-00000000000d", "ingredient_name": "egg", "display_name": "eggs" } }] $$) -> 0 ->> 'code',
  '42501', 'a queued add to D from Pat is refused');

-- Alex deletes X, keeping R: no new household ------------------------------------------
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is(public.delete_household('aaaaaaaa-0000-0000-0000-00000000000e'), '{"new_household_id": null}'::jsonb,
  'an owner who still has another household gets null back');
select results_eq($$ select name from public.households $$, $$ values ('Roles') $$,
  'and is left with only that household');

reset role;
select is((select count(*)::int from admin.admin_actions),
  (select (result #>> '{}')::int from results where step = 'admin_actions_before'), 'none of this writes an admin_actions row');

select * from finish();
rollback;
