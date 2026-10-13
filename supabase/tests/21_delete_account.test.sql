-- Self-service account deletion (spec 4.8, 5): public.delete_account acts only on the caller,
-- runs the shared core (private.delete_user_core) and writes an audit row with no email.
begin;
create extension if not exists pgtap with schema extensions;
select plan(37);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex is the sole member of P (personal), the only owner of S (shared with Pat, who joined
-- before Jamie), and one of two owners of T (with Sam).
insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated', '{"full_name": "Alex Doe"}'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated', '{}'),
  ('33333333-3333-3333-3333-333333333333', 'jamie@test.local', 'authenticated', 'authenticated', '{}'),
  ('44444444-4444-4444-4444-444444444444', 'pat@test.local', 'authenticated', 'authenticated', '{}');

insert into public.households (id, name) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Personal'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', 'Shared'),
  ('aaaaaaaa-0000-0000-0000-00000000000d', 'Two owners');
insert into public.household_members (household_id, user_id, role, position, joined_at) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner', 1, '2026-01-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', 'owner', 2, '2026-01-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', '33333333-3333-3333-3333-333333333333', 'member', 1, '2026-03-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', '44444444-4444-4444-4444-444444444444', 'member', 1, '2026-02-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000d', '11111111-1111-1111-1111-111111111111', 'owner', 3, '2026-02-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000d', '22222222-2222-2222-2222-222222222222', 'owner', 1, '2026-01-01');

insert into public.lists (id, household_id, name, position) values
  ('b1000000-0000-7000-8000-00000000000a', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Groceries', 1),
  ('b1000000-0000-7000-8000-00000000000b', 'aaaaaaaa-0000-0000-0000-00000000000b', 'Shared groceries', 1);
insert into public.list_items (id, list_id, household_id, ingredient_name, display_name, added_by, checked_by, checked_at) values
  ('b2000000-0000-7000-8000-00000000000a', 'b1000000-0000-7000-8000-00000000000a', 'aaaaaaaa-0000-0000-0000-00000000000a', 'egg', 'eggs', '11111111-1111-1111-1111-111111111111', null, null),
  ('b2000000-0000-7000-8000-00000000000b', 'b1000000-0000-7000-8000-00000000000b', 'aaaaaaaa-0000-0000-0000-00000000000b', 'milk', 'milk', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', now());
insert into public.list_item_contributions (id, list_item_id, household_id, quantity, added_by) values
  ('b6000000-0000-7000-8000-00000000000b', 'b2000000-0000-7000-8000-00000000000b', 'aaaaaaaa-0000-0000-0000-00000000000b', 2, '11111111-1111-1111-1111-111111111111');
insert into public.recipes (id, household_id, name) values
  ('b3000000-0000-7000-8000-00000000000a', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Omelette'),
  ('b3000000-0000-7000-8000-00000000000b', 'aaaaaaaa-0000-0000-0000-00000000000b', 'Pancakes');
insert into public.recipe_ingredients (id, recipe_id, household_id, ingredient_name, display_name, position) values
  ('b4000000-0000-7000-8000-00000000000a', 'b3000000-0000-7000-8000-00000000000a', 'aaaaaaaa-0000-0000-0000-00000000000a', 'egg', 'eggs', 1);
insert into public.household_invites (id, household_id, token_hash, created_by, expires_at) values
  ('b5000000-0000-7000-8000-00000000000b', 'aaaaaaaa-0000-0000-0000-00000000000b', 'hash-shared', '11111111-1111-1111-1111-111111111111', now() + interval '7 days');
insert into public.user_settings (user_id, default_list_id) values
  ('11111111-1111-1111-1111-111111111111', 'b1000000-0000-7000-8000-00000000000a');
insert into public.user_category_order (user_id, category_id, position)
select '11111111-1111-1111-1111-111111111111', c.id, 1
from public.categories c where c.household_id is null order by c.id limit 1;

-- Access ------------------------------------------------------------------------
select ok(has_function_privilege('authenticated', 'public.delete_account()', 'execute'),
  'authenticated can execute delete_account');
select ok(
  not has_function_privilege('anon', 'public.delete_account()', 'execute')
  and not has_function_privilege('public', 'public.delete_account()', 'execute'),
  'anon and public cannot execute delete_account');
select ok(
  not has_function_privilege('authenticated', 'private.delete_user_core(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.delete_user_core(uuid)', 'execute')
  and not has_function_privilege('service_role', 'private.delete_user_core(uuid)', 'execute')
  and not has_function_privilege('public', 'private.delete_user_core(uuid)', 'execute'),
  'nobody but postgres can run the core directly');
select is(
  (select prosecdef from pg_proc where oid = 'public.delete_account()'::regprocedure),
  true, 'delete_account is security definer');

set local role anon;
select throws_ok($$ select public.delete_account() $$, '42501', null, 'anon cannot call delete_account');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '', true);
select throws_ok($$ select public.delete_account() $$, '42501', 'not signed in', 'without auth.uid() it raises');
select throws_ok($$ select private.delete_user_core('11111111-1111-1111-1111-111111111111') $$,
  '42501', null, 'authenticated cannot call the core');
reset role;

select is((select count(*)::int from public.household_members where user_id = '11111111-1111-1111-1111-111111111111'),
  3, 'the refused calls changed nothing');
select is((select count(*)::int from admin.admin_actions), 0, 'and wrote no audit row');

-- Alex deletes their account ---------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is(
  public.delete_account(),
  jsonb_build_object('households', jsonb_build_array(
    jsonb_build_object('id', 'aaaaaaaa-0000-0000-0000-00000000000a', 'outcome', 'deleted'),
    jsonb_build_object('id', 'aaaaaaaa-0000-0000-0000-00000000000b', 'outcome', 'promoted'),
    jsonb_build_object('id', 'aaaaaaaa-0000-0000-0000-00000000000d', 'outcome', 'left'))),
  'delete_account returns each household''s outcome, in the user''s household order');
reset role;

-- The user is gone, with what's theirs
select is((select count(*)::int from auth.users where id = '11111111-1111-1111-1111-111111111111'), 0, 'the auth user is deleted');
select is((select count(*)::int from public.profiles where user_id = '11111111-1111-1111-1111-111111111111'), 0, 'their profile is deleted');
select is((select count(*)::int from public.user_settings where user_id = '11111111-1111-1111-1111-111111111111'), 0, 'their settings are deleted');
select is((select count(*)::int from public.user_category_order where user_id = '11111111-1111-1111-1111-111111111111'), 0, 'their aisle order is deleted');
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
select is((select count(*)::int from public.households where id = 'aaaaaaaa-0000-0000-0000-00000000000b'), 1, 'the shared household stays');
select is((select count(*)::int from public.lists where household_id = 'aaaaaaaa-0000-0000-0000-00000000000b'), 1, 'with its list');
select is((select count(*)::int from public.recipes where household_id = 'aaaaaaaa-0000-0000-0000-00000000000b'), 1, 'and its recipe');
select results_eq(
  $$ select added_by, checked_by, checked_at is not null from public.list_items where id = 'b2000000-0000-7000-8000-00000000000b' $$,
  $$ values (null::uuid, null::uuid, true) $$,
  'an item they added and checked stays, with added_by and checked_by null');
select results_eq(
  $$ select added_by, quantity from public.list_item_contributions where id = 'b6000000-0000-7000-8000-00000000000b' $$,
  $$ values (null::uuid, 2::numeric) $$,
  'their contribution stays, with added_by null');
select results_eq(
  $$ select created_by, used_at, revoked_at from public.household_invites where id = 'b5000000-0000-7000-8000-00000000000b' $$,
  $$ values (null::uuid, null::timestamptz, null::timestamptz) $$,
  'their open invite stays open, with created_by null');

-- One of several owners: they just leave, nobody is promoted
select results_eq(
  $$ select user_id, role from public.household_members where household_id = 'aaaaaaaa-0000-0000-0000-00000000000d' $$,
  $$ values ('22222222-2222-2222-2222-222222222222'::uuid, 'owner') $$,
  'the other owner stays the only member and owner');

-- The audit row
select is((select count(*)::int from admin.admin_actions), 1, 'one audit row');
select results_eq(
  $$ select action, target_user_id, target_household_id, note from admin.admin_actions $$,
  $$ values ('delete_account', '11111111-1111-1111-1111-111111111111'::uuid, null::uuid, null::text) $$,
  'the audit row names the action and the user');
select is(
  (select details from admin.admin_actions),
  jsonb_build_object('households', jsonb_build_array(
    jsonb_build_object('id', 'aaaaaaaa-0000-0000-0000-00000000000a', 'outcome', 'deleted'),
    jsonb_build_object('id', 'aaaaaaaa-0000-0000-0000-00000000000b', 'outcome', 'promoted',
      'promoted_user_id', '44444444-4444-4444-4444-444444444444'),
    jsonb_build_object('id', 'aaaaaaaa-0000-0000-0000-00000000000d', 'outcome', 'left'))),
  'the audit details have each household''s outcome and promoted user');
select ok(
  not (select details::text from admin.admin_actions) ilike '%alex%'
  and not (select details ? 'email' or details ? 'display_name' from admin.admin_actions),
  'the audit row has no email or display name');

-- A retry with the same (now deleted) user's token does nothing
set local role authenticated;
select is(public.delete_account(), '{"households": []}'::jsonb,
  'a retry after the account is gone returns no households');
reset role;
select is((select count(*)::int from admin.admin_actions), 1, 'and writes no second audit row');

-- Another user, in no household, deletes their account
delete from public.household_members where user_id = '33333333-3333-3333-3333-333333333333';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is(public.delete_account() -> 'households', '[]'::jsonb, 'a user in no household still deletes');
reset role;
select is((select count(*)::int from auth.users where id = '33333333-3333-3333-3333-333333333333'), 0, 'and their auth user is gone');
select is((select count(*)::int from auth.users where id in ('22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444')),
  2, 'other users are untouched');

select * from finish();
rollback;
