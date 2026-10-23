-- Aisle order per household (spec 4.3.3, 5, 7.3, 4.12 User activity): household_category_order
-- through apply_mutations (category_ids as one LWW field), user_household_category_order written
-- directly under RLS, the shared 'invalid aisle order' check, leaving deletes the leaver's own order,
-- and the activity entries.
begin;
create extension if not exists pgtap with schema extensions;
select plan(57);

-- Fixtures (as postgres, no user, so nothing is logged) ------------------------------------------
-- Alex owns Home, Sam is a member. Pat is only in Other. Home and Other each have a custom aisle.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'pat@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Home'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Other');
insert into public.household_members (household_id, user_id, role, position, joined_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1, now() - interval '2 days'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'member', 1, now() - interval '1 day'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '33333333-3333-3333-3333-333333333333', 'owner', 1, now());
insert into public.categories (id, name, household_id) values
  ('cccccccc-0000-7000-8000-00000000000a', 'Home aisle', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('cccccccc-0000-7000-8000-00000000000b', 'Other aisle', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
delete from private.user_activity;

-- Helpers ------------------------------------------------------------------------------------------
-- One household order mutation for Home through apply_mutations, as whoever the claims name.
create function pg_temp.push_order(p_hlc text, p_fields jsonb, p_household text default 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
returns jsonb language sql as $$
  select public.apply_mutations(jsonb_build_array(jsonb_build_object(
    'table', 'household_category_order', 'key', jsonb_build_object('household_id', p_household),
    'fields', p_fields, 'hlc', p_hlc))) -> 0
$$;
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_id, 'role', 'authenticated')::text, true);
$$;
-- Takes the entries logged so far (oldest first) and clears them.
create function pg_temp.taken() returns jsonb language sql as $$
  with t as (delete from private.user_activity returning *)
  select coalesce(jsonb_agg(jsonb_build_object('user', user_id, 'area', area, 'action', action, 'data', data) order by id), '[]')
  from t
$$;

-- Schema and privileges ------------------------------------------------------------------------------
select is(to_regclass('public.user_category_order'), null, 'user_category_order is dropped');
select is(to_regprocedure('private.activity_user_category_order(public.user_category_order, public.user_category_order)'), null,
  'its activity function is gone');
select ok(has_table_privilege('authenticated', 'public.household_category_order', 'select')
  and not has_table_privilege('authenticated', 'public.household_category_order', 'insert')
  and not has_table_privilege('authenticated', 'public.household_category_order', 'update')
  and not has_table_privilege('authenticated', 'public.household_category_order', 'delete'),
  'clients only read household_category_order');
select ok(not has_table_privilege('anon', 'public.household_category_order', 'select')
  and not has_table_privilege('anon', 'public.user_household_category_order', 'select'),
  'anon reads neither order');
select ok(not has_function_privilege('authenticated', 'private.check_aisle_order(jsonb, uuid)', 'execute'),
  'clients can''t call the check');

-- The household order through apply_mutations ----------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is(pg_temp.push_order('1760000000001-0000-alex', jsonb_build_object('category_ids', jsonb_build_array(
    'cccccccc-0000-7000-8000-00000000000a', '019a4c10-0000-7000-8000-00000000ca02', '019a4c10-0000-7000-8000-00000000ca01'))),
  '{"status": "applied"}'::jsonb, 'a member saves the household order, with its own custom aisle');
select is((select category_ids from public.household_category_order where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  '["cccccccc-0000-7000-8000-00000000000a", "019a4c10-0000-7000-8000-00000000ca02", "019a4c10-0000-7000-8000-00000000ca01"]'::jsonb,
  'the whole order is stored, in order');
select is((select updated_by::text from public.household_category_order where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  '11111111-1111-1111-1111-111111111111', 'the server sets updated_by to the caller');
select is(pg_temp.taken(), $$[{"user": "11111111-1111-1111-1111-111111111111", "area": "aisles", "action": "aisle_order.saved",
  "data": {"household": "Home"}}]$$::jsonb, 'aisle_order.saved is logged');

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is(pg_temp.push_order('1760000000005-0000-sam', jsonb_build_object(
    'category_ids', jsonb_build_array('019a4c10-0000-7000-8000-00000000ca01'),
    'updated_by', '33333333-3333-3333-3333-333333333333')),
  '{"status": "applied"}'::jsonb, 'another member saves a later order');
select is((select category_ids from public.household_category_order where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  '["019a4c10-0000-7000-8000-00000000ca01"]'::jsonb, 'the later save replaces the whole order');
select is((select updated_by::text from public.household_category_order where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  '22222222-2222-2222-2222-222222222222', 'updated_by is the caller, whatever the client sent');
select is((select field_clock from public.household_category_order where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  '{"category_ids": "1760000000005-0000-sam"}'::jsonb, 'category_ids carries the winning HLC');
select is(jsonb_array_length(pg_temp.taken()), 1, 'each save that changes the order logs one entry');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is(pg_temp.push_order('1760000000003-0000-alex', jsonb_build_object('category_ids', jsonb_build_array(
    '019a4c10-0000-7000-8000-00000000ca02'))),
  '{"status": "unchanged"}'::jsonb, 'an older save loses');
select is((select category_ids from public.household_category_order where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  '["019a4c10-0000-7000-8000-00000000ca01"]'::jsonb, 'the newer order stays whole');
select is((select updated_by::text from public.household_category_order where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  '22222222-2222-2222-2222-222222222222', 'a losing save doesn''t change updated_by');
select is(pg_temp.taken(), '[]'::jsonb, 'a losing save logs nothing');

select is(pg_temp.push_order('1760000000005-0001-alex', jsonb_build_object('category_ids', jsonb_build_array(
    '019a4c10-0000-7000-8000-00000000ca03'))),
  '{"status": "applied"}'::jsonb, 'the same wall time with a higher counter wins');
delete from private.user_activity;

-- Validation
select is(pg_temp.push_order('1760000000010-0000-alex', jsonb_build_object('category_ids', jsonb_build_array(
    '019a4c10-0000-7000-8000-00000000ca01', '019a4c10-0000-7000-8000-00000000ca01'))) - 'status',
  '{"code": "22023", "message": "invalid aisle order"}'::jsonb, 'duplicates are refused');
select is(pg_temp.push_order('1760000000011-0000-alex', jsonb_build_object('category_ids', jsonb_build_array(
    '019a4c10-0000-7000-8000-00000000ca01', 'CCCCCCCC-0000-7000-8000-00000000000A', 'cccccccc-0000-7000-8000-00000000000a'))) ->> 'message',
  'invalid aisle order', 'the same id in another case is a duplicate');
select is(pg_temp.push_order('1760000000012-0000-alex', jsonb_build_object('category_ids', jsonb_build_array(
    'cccccccc-0000-7000-8000-00000000000b'))) ->> 'message',
  'invalid aisle order', 'another household''s custom aisle is refused');
select is(pg_temp.push_order('1760000000013-0000-alex', jsonb_build_object('category_ids',
    '{"0": "019a4c10-0000-7000-8000-00000000ca01"}'::jsonb)) ->> 'message',
  'invalid aisle order', 'an object is refused');
select is(pg_temp.push_order('1760000000014-0000-alex', jsonb_build_object('category_ids', 'produce')) ->> 'message',
  'invalid aisle order', 'a string is refused');
select is(pg_temp.push_order('1760000000015-0000-alex', jsonb_build_object('category_ids', jsonb_build_array('produce', 3))) ->> 'message',
  'invalid aisle order', 'elements that aren''t category ids are refused');
select is(pg_temp.push_order('1760000000016-0000-alex', jsonb_build_object('category_ids', jsonb_build_array(
    'dddddddd-0000-7000-8000-000000000000'))) ->> 'message',
  'invalid aisle order', 'an unknown id is refused');
select is(pg_temp.push_order('1760000000017-0000-alex', jsonb_build_object('category_ids', null)) ->> 'message',
  'invalid aisle order', 'null is refused');
select is(pg_temp.push_order('1760000000018-0000-alex', '{}'::jsonb, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') ->> 'code',
  '42501', 'a non-member can''t write another household''s order');
select is((select category_ids from public.household_category_order where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  '["019a4c10-0000-7000-8000-00000000ca03"]'::jsonb, 'refused saves change nothing');
select is(pg_temp.taken(), '[]'::jsonb, 'refused saves log nothing');

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select is(pg_temp.push_order('1760000000020-0000-pat', '{}'::jsonb, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') ->> 'message',
  'invalid aisle order', 'a new household order needs category_ids');
select is(pg_temp.push_order('1760000000021-0000-pat', jsonb_build_object('category_ids', jsonb_build_array(
    '019a4c10-0000-7000-8000-00000000ca01'))) ->> 'code',
  '42501', 'a non-member''s save to Home is refused');
select is(pg_temp.push_order('1760000000022-0000-pat', jsonb_build_object('category_ids', '[]'::jsonb), 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  '{"status": "applied"}'::jsonb, 'an empty order is an order');
select is(pg_temp.taken(), $$[{"user": "33333333-3333-3333-3333-333333333333", "area": "aisles", "action": "aisle_order.saved",
  "data": {"household": "Other"}}]$$::jsonb, 'the entry is the saver''s, with their household');

-- Direct access, as clients -------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select is((select array_agg(household_id::text) from public.household_category_order),
  array['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'], 'a non-member doesn''t read another household''s order');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is((select array_agg(household_id::text) from public.household_category_order),
  array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'], 'a member reads their household''s order');
select throws_ok($$ update public.household_category_order set category_ids = '[]' $$,
  '42501', null, 'members can''t write the household order directly');
select throws_ok($$ delete from public.household_category_order $$,
  '42501', null, 'the household order can''t be deleted');

-- Your own order ------------------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select lives_ok($$ insert into public.user_household_category_order (user_id, household_id, category_ids) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '["cccccccc-0000-7000-8000-00000000000a", "019a4c10-0000-7000-8000-00000000ca01"]') $$,
  'a member saves their own order for the household');
select lives_ok($$ insert into public.user_household_category_order (user_id, household_id, category_ids) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '["019a4c10-0000-7000-8000-00000000ca02"]')
  on conflict (user_id, household_id) do update set category_ids = excluded.category_ids $$,
  'saving again replaces it (upsert)');
select is((select category_ids from public.user_household_category_order),
  '["019a4c10-0000-7000-8000-00000000ca02"]'::jsonb, 'they read it back');
select throws_ok($$ insert into public.user_household_category_order (user_id, household_id, category_ids) values
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '[]') $$,
  '42501', null, 'no one writes another member''s order');
select throws_ok($$ insert into public.user_household_category_order (user_id, household_id, category_ids) values
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '[]') $$,
  '42501', null, 'no one keeps an order for a household they aren''t in');
select throws_ok($$ insert into public.user_household_category_order (user_id, household_id, category_ids) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '["019a4c10-0000-7000-8000-00000000ca01", "019a4c10-0000-7000-8000-00000000ca01"]')
  on conflict (user_id, household_id) do update set category_ids = excluded.category_ids $$,
  '22023', 'invalid aisle order', 'duplicates are refused');
select throws_ok($$ update public.user_household_category_order set category_ids = '["cccccccc-0000-7000-8000-00000000000b"]' $$,
  '22023', 'invalid aisle order', 'another household''s custom aisle is refused');
select throws_ok($$ update public.user_household_category_order set category_ids = '{"a": 1}' $$,
  '22023', 'invalid aisle order', 'a non-array is refused');

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is((select count(*)::int from public.user_household_category_order), 0, 'another member doesn''t read it');
update public.user_household_category_order set category_ids = '[]';
delete from public.user_household_category_order;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select category_ids from public.user_household_category_order),
  '["019a4c10-0000-7000-8000-00000000ca02"]'::jsonb, 'another member can''t change or delete it');
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select throws_ok($$ insert into public.user_household_category_order (user_id, household_id, category_ids) values
  ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '[]') $$,
  '42501', null, 'a non-member can''t keep an order for Home');
select lives_ok($$ insert into public.user_household_category_order (user_id, household_id, category_ids) values
  ('33333333-3333-3333-3333-333333333333', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '["cccccccc-0000-7000-8000-00000000000b"]') $$,
  'their own household''s custom aisle is fine');
reset role;

select is(pg_temp.taken(), $$[
  {"user": "11111111-1111-1111-1111-111111111111", "area": "settings", "action": "settings.aisle_order", "data": {"household": "Home", "removed": false}},
  {"user": "11111111-1111-1111-1111-111111111111", "area": "settings", "action": "settings.aisle_order", "data": {"household": "Home", "removed": false}},
  {"user": "33333333-3333-3333-3333-333333333333", "area": "settings", "action": "settings.aisle_order", "data": {"household": "Other", "removed": false}}
]$$::jsonb, 'settings.aisle_order for each save of your own order, nothing for refused writes');

set local role authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
update public.user_household_category_order set category_ids = category_ids;
select lives_ok($$ delete from public.user_household_category_order $$, 'Use household order deletes it');
select is((select count(*)::int from public.user_household_category_order), 0, 'it''s gone');
reset role;
select is(pg_temp.taken(), $$[
  {"user": "11111111-1111-1111-1111-111111111111", "area": "settings", "action": "settings.aisle_order", "data": {"household": "Home", "removed": true}}
]$$::jsonb, 'removing it logs removed true; an update that changes nothing logs nothing');

-- Leaving ---------------------------------------------------------------------------------------------
insert into public.user_household_category_order (user_id, household_id, category_ids) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '["019a4c10-0000-7000-8000-00000000ca01"]'),
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '["019a4c10-0000-7000-8000-00000000ca02"]');
delete from private.user_activity;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select public.leave_household('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select is((select array_agg(user_id::text) from public.user_household_category_order where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  array['11111111-1111-1111-1111-111111111111'], 'leaving deletes the leaver''s own order and keeps the others''');
select is((select array_agg(action) from private.user_activity), array['household.left'],
  'leaving logs only household.left');
select is((select count(*)::int from public.household_category_order where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 1,
  'the household order stays');

select * from finish();
rollback;
