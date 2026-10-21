-- Leaving a household and removing a member (spec 4.7, 5): leave_household, remove_member and
-- the personal household made for someone left with none.
begin;
create extension if not exists pgtap with schema extensions;
select plan(46);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex owns S (shared), which Pat, Robin and Jamie joined in that order. Alex also owns X and
-- Pat owns P, so S isn't their only household; Robin and Jamie are only in S. Sam is in none
-- of these. Pat's and Jamie's default list is S's list.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'jamie@test.local', 'authenticated', 'authenticated'),
  ('44444444-4444-4444-4444-444444444444', 'pat@test.local', 'authenticated', 'authenticated'),
  ('55555555-5555-5555-5555-555555555555', 'robin@test.local', 'authenticated', 'authenticated');

insert into public.households (id, name) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Shared'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', 'Alex''s household'),
  ('aaaaaaaa-0000-0000-0000-00000000000c', 'Pat''s household'),
  ('aaaaaaaa-0000-0000-0000-00000000000d', 'Sam''s household');
insert into public.household_members (household_id, user_id, role, position, joined_at) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner', 2, '2026-01-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '44444444-4444-4444-4444-444444444444', 'member', 2, '2026-02-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '55555555-5555-5555-5555-555555555555', 'member', 1, '2026-02-15'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333', 'member', 1, '2026-03-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', 'owner', 1, '2026-01-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000c', '44444444-4444-4444-4444-444444444444', 'owner', 1, '2026-01-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000d', '22222222-2222-2222-2222-222222222222', 'owner', 1, '2026-01-01');

insert into public.lists (id, household_id, name, position) values
  ('b1000000-0000-7000-8000-00000000000a', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Shared groceries', 1),
  ('b1000000-0000-7000-8000-00000000000c', 'aaaaaaaa-0000-0000-0000-00000000000c', 'Pat''s list', 1);
insert into public.list_items (id, list_id, household_id, ingredient_name, display_name) values
  ('b2000000-0000-7000-8000-00000000000a', 'b1000000-0000-7000-8000-00000000000a', 'aaaaaaaa-0000-0000-0000-00000000000a', 'milk', 'milk');
insert into public.recipes (id, household_id, name) values
  ('b3000000-0000-7000-8000-00000000000a', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Pancakes');
insert into public.user_settings (user_id, default_list_id) values
  ('44444444-4444-4444-4444-444444444444', 'b1000000-0000-7000-8000-00000000000a'),
  ('33333333-3333-3333-3333-333333333333', 'b1000000-0000-7000-8000-00000000000a');

-- What each call returned, for checks after the fact.
create temp table results (step text primary key, result jsonb);
grant all on results to authenticated;
insert into results select 'households_before', to_jsonb(count(*)) from public.households;

-- Access ------------------------------------------------------------------------
select ok(
  has_function_privilege('authenticated', 'public.leave_household(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.remove_member(uuid, uuid)', 'execute'),
  'signed-in users can call leave_household and remove_member');
select ok(
  not has_function_privilege('anon', 'public.leave_household(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.remove_member(uuid, uuid)', 'execute')
  and not has_function_privilege('public', 'public.leave_household(uuid)', 'execute')
  and not has_function_privilege('public', 'public.remove_member(uuid, uuid)', 'execute'),
  'anon and public can''t call leave_household or remove_member');
select ok(
  not has_function_privilege('authenticated', 'private.create_personal_household(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.create_personal_household(uuid)', 'execute')
  and not has_function_privilege('service_role', 'private.create_personal_household(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.leave_and_rehome(uuid, uuid)', 'execute')
  and not has_function_privilege('service_role', 'private.leave_and_rehome(uuid, uuid)', 'execute'),
  'nobody but postgres can call the private helpers directly');

-- Refused calls -------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select throws_ok($$ select public.leave_household('aaaaaaaa-0000-0000-0000-00000000000a') $$,
  '42501', 'not a member', 'a non-member can''t leave');
select throws_ok($$ select public.leave_household('aaaaaaaa-0000-0000-0000-0000000000ff') $$,
  '42501', 'not a member', 'leaving a household that doesn''t exist raises not a member');
select throws_ok($$ select public.remove_member('aaaaaaaa-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333') $$,
  '42501', 'not an owner', 'a non-member can''t remove anyone');

select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select throws_ok($$ select public.remove_member('aaaaaaaa-0000-0000-0000-00000000000a', '44444444-4444-4444-4444-444444444444') $$,
  '42501', 'not an owner', 'a plain member can''t remove anyone');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select public.remove_member('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111') $$,
  '22023', 'cannot remove yourself; use leave_household', 'an owner can''t remove themselves');
select throws_ok($$ select public.remove_member('aaaaaaaa-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222') $$,
  '42501', 'not a member', 'an owner can''t remove someone who isn''t a member');

select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.leave_household('aaaaaaaa-0000-0000-0000-00000000000a') $$,
  '42501', 'not authenticated', 'leaving needs a signed-in user');

reset role;
select is((select count(*)::int from public.household_members where household_id = 'aaaaaaaa-0000-0000-0000-00000000000a'), 4,
  'the refused calls changed no memberships');
select is((select count(*)::int from public.households),
  (select (result #>> '{}')::int from results where step = 'households_before'), 'the refused calls made no households');

-- Pat leaves S (a plain member, with another household) ---------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
select results_eq($$ select name from public.lists order by name $$,
  $$ values ('Pat''s list'), ('Shared groceries') $$, 'before leaving, Pat reads S''s list');
insert into results select 'pat_leaves', public.leave_household('aaaaaaaa-0000-0000-0000-00000000000a');
select is((select result from results where step = 'pat_leaves'),
  '{"outcome": "left", "new_household_id": null}'::jsonb, 'a plain member leaving reports left, with no new household');
select results_eq($$ select name from public.lists $$,
  $$ values ('Pat''s list') $$, 'after leaving, Pat can''t read S''s lists');
select is_empty($$ select 1 from public.list_items $$, 'after leaving, Pat can''t read S''s items');
select is_empty($$ select 1 from public.households where id = 'aaaaaaaa-0000-0000-0000-00000000000a' $$,
  'after leaving, Pat can''t read S');
select is(
  public.apply_mutations($$ [{ "table": "lists", "id": "b1000000-0000-7000-8000-00000000000a", "hlc": "1760000000000-0000-pat1", "fields": { "name": "Mine now" } }] $$) -> 0 ->> 'code',
  '42501', 'after leaving, Pat can''t change S''s list');
select is(
  public.apply_mutations($$ [{ "table": "list_items", "id": "b2000000-0000-7000-8000-0000000000ff", "hlc": "1760000000000-0001-pat1",
    "fields": { "list_id": "b1000000-0000-7000-8000-00000000000a", "household_id": "aaaaaaaa-0000-0000-0000-00000000000a", "ingredient_name": "egg", "display_name": "eggs" } }] $$) -> 0 ->> 'code',
  '42501', 'after leaving, Pat can''t add to S''s list');
select is((select default_list_id from public.user_settings), null::uuid,
  'Pat''s default list, which was in S, is cleared');
select throws_ok($$ select public.leave_household('aaaaaaaa-0000-0000-0000-00000000000a') $$,
  '42501', 'not a member', 'Pat can''t leave S twice');

reset role;
select results_eq($$ select name from public.lists where id = 'b1000000-0000-7000-8000-00000000000a' $$,
  $$ values ('Shared groceries') $$, 'S''s list stays with the household, unchanged');
select is((select count(*)::int from public.household_members where user_id = '44444444-4444-4444-4444-444444444444'), 1,
  'Pat is left with only their own household, and gets no new one');

-- Alex, S's last owner, leaves: Robin joined earliest of those left -----------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
insert into results select 'alex_leaves', public.leave_household('aaaaaaaa-0000-0000-0000-00000000000a');
select is((select result from results where step = 'alex_leaves'),
  '{"outcome": "promoted", "new_household_id": null}'::jsonb, 'the last owner leaving reports promoted');

reset role;
select results_eq(
  $$ select user_id, role from public.household_members where household_id = 'aaaaaaaa-0000-0000-0000-00000000000a' order by user_id $$,
  $$ values ('33333333-3333-3333-3333-333333333333'::uuid, 'member'), ('55555555-5555-5555-5555-555555555555'::uuid, 'owner') $$,
  'the earliest-joined remaining member (Robin) becomes the owner; Jamie stays a member');

-- Robin, now an owner, removes Jamie, whose only household is S ---------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}', true);
insert into results select 'jamie_removed',
  public.remove_member('aaaaaaaa-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333');

reset role;
select is((select result ->> 'outcome' from results where step = 'jamie_removed'), 'left',
  'removing a member reports left');
select results_eq(
  $$ select h.id, h.name, h.created_by, hm.role, hm.position from public.household_members hm
     join public.households h on h.id = hm.household_id where hm.user_id = '33333333-3333-3333-3333-333333333333' $$,
  $$ select (result ->> 'new_household_id')::uuid, 'Personal'::text, '33333333-3333-3333-3333-333333333333'::uuid, 'owner'::text, 1::double precision
     from results where step = 'jamie_removed' $$,
  'Jamie, removed from their only household, is the owner of a new "Personal" household, whose id is returned');
select results_eq(
  $$ select l.name, l.position, l.archived_at, l.deleted_at from public.lists l
     where l.household_id = (select (result ->> 'new_household_id')::uuid from results where step = 'jamie_removed') $$,
  $$ values ('Groceries'::text, 1::double precision, null::timestamptz, null::timestamptz) $$,
  'the new household has one "Groceries" list at position 1');
select is(
  (select default_list_id from public.user_settings where user_id = '33333333-3333-3333-3333-333333333333'),
  (select l.id from public.lists l
   where l.household_id = (select (result ->> 'new_household_id')::uuid from results where step = 'jamie_removed')),
  'Jamie''s default list, which was in S, now points at the new Groceries list');
select results_eq(
  $$ select hp.plan_id from public.household_plans hp
     where hp.household_id = (select (result ->> 'new_household_id')::uuid from results where step = 'jamie_removed') $$,
  $$ select p.id from public.plans p where p.is_default $$,
  'the new household gets the default plan''s row (spec 4.12)');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select results_eq($$ select name from public.lists $$, $$ values ('Groceries') $$,
  'Jamie reads only the new list, not S''s');
select results_eq($$ select name from public.households $$, $$ values ('Personal') $$,
  'Jamie reads only the new household');
select is(
  public.apply_mutations($$ [{ "table": "lists", "id": "b1000000-0000-7000-8000-00000000000a", "hlc": "1760000000000-0000-jami", "fields": { "name": "Still mine" } }] $$) -> 0 ->> 'code',
  '42501', 'after removal, Jamie can''t change S''s list');
select throws_ok($$ select public.remove_member('aaaaaaaa-0000-0000-0000-00000000000a', '55555555-5555-5555-5555-555555555555') $$,
  '42501', 'not an owner', 'after removal, Jamie can''t remove anyone from S');

-- Robin, the last member, leaves S, their only household ------------------------
select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}', true);
insert into results select 'robin_leaves', public.leave_household('aaaaaaaa-0000-0000-0000-00000000000a');
select is((select result ->> 'outcome' from results where step = 'robin_leaves'), 'deleted',
  'the last member leaving reports deleted');
select isnt((select result ->> 'new_household_id' from results where step = 'robin_leaves'), null,
  'and returns the new household''s id');
select results_eq($$ select name from public.households $$, $$ values ('Personal') $$,
  'Robin is left with one household, the new "Personal" one');
select results_eq($$ select name, position from public.lists $$, $$ values ('Groceries'::text, 1::double precision) $$,
  'with a "Groceries" list at position 1');
select is(
  (select default_list_id from public.user_settings),
  (select id from public.lists),
  'Robin''s default list is the new Groceries list, created for them');

reset role;
select is_empty($$ select 1 from public.households where id = 'aaaaaaaa-0000-0000-0000-00000000000a' $$,
  'the last member leaving deletes the household');
select is_empty($$ select 1 from public.lists where household_id = 'aaaaaaaa-0000-0000-0000-00000000000a' $$,
  'and its lists');
select is_empty($$ select 1 from public.list_items where household_id = 'aaaaaaaa-0000-0000-0000-00000000000a' $$,
  'and its items');
select is_empty($$ select 1 from public.recipes where household_id = 'aaaaaaaa-0000-0000-0000-00000000000a' $$,
  'and its recipes');
select is(
  (select default_list_id from public.user_settings where user_id = '44444444-4444-4444-4444-444444444444'),
  null::uuid, 'Pat''s default list stays cleared');

-- The new household's position comes after the user's others --------------------
-- (Only reachable through the helper: leaving never leaves someone with others and a new one.)
insert into results select 'alex_personal', to_jsonb(private.create_personal_household('11111111-1111-1111-1111-111111111111'));
select is(
  (select hm.position from public.household_members hm
   where hm.household_id = (select (result #>> '{}')::uuid from results where step = 'alex_personal')
     and hm.user_id = '11111111-1111-1111-1111-111111111111'),
  2::double precision, 'create_personal_household puts the new household after the user''s others');
select is(
  (select count(*)::int from public.user_settings us join public.lists l on l.id = us.default_list_id
   where us.user_id = '11111111-1111-1111-1111-111111111111' and l.name = 'Groceries'),
  1, 'create_personal_household makes a settings row pointing at the new list when there was none');

select * from finish();
rollback;
