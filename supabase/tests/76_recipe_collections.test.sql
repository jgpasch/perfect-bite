-- Recipe collections (tasks.md): recipe_collections and recipe_collection_recipes read by every member
-- of their household, written only through apply_mutations (name and deleted_at, and deleted_at on
-- memberships, as LWW fields), created_by set by the server, and a membership's collection and recipe
-- in its own household.
begin;
create extension if not exists pgtap with schema extensions;
select plan(35);

-- Fixtures (as postgres) ----------------------------------------------------------------------------
-- Alex owns Home, Sam is a member. Pat is only in Other. Home has Tacos and Soup, Other has Stew.
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
insert into public.recipes (id, household_id, name) values
  ('a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tacos'),
  ('a1000000-0000-7000-8000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Soup'),
  ('b1000000-0000-7000-8000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Stew');

-- Helpers ------------------------------------------------------------------------------------------
create function pg_temp.push(p_mutation jsonb) returns jsonb language sql as $$
  select public.apply_mutations(jsonb_build_array(p_mutation)) -> 0
$$;
create function pg_temp.push_collection(p_hlc text, p_id text, p_fields jsonb) returns jsonb language sql as $$
  select pg_temp.push(jsonb_build_object('table', 'recipe_collections', 'id', p_id, 'fields', p_fields, 'hlc', p_hlc))
$$;
create function pg_temp.push_member(p_hlc text, p_collection text, p_recipe text, p_fields jsonb) returns jsonb language sql as $$
  select pg_temp.push(jsonb_build_object('table', 'recipe_collection_recipes',
    'key', jsonb_build_object('collection_id', p_collection, 'recipe_id', p_recipe), 'fields', p_fields, 'hlc', p_hlc))
$$;
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_id, 'role', 'authenticated')::text, true);
$$;

-- Schema and privileges ------------------------------------------------------------------------------
select ok(has_table_privilege('authenticated', 'public.recipe_collections', 'select')
  and not has_table_privilege('authenticated', 'public.recipe_collections', 'insert')
  and not has_table_privilege('authenticated', 'public.recipe_collections', 'update')
  and not has_table_privilege('authenticated', 'public.recipe_collections', 'delete'),
  'clients only read recipe_collections');
select ok(has_table_privilege('authenticated', 'public.recipe_collection_recipes', 'select')
  and not has_table_privilege('authenticated', 'public.recipe_collection_recipes', 'insert')
  and not has_table_privilege('authenticated', 'public.recipe_collection_recipes', 'update')
  and not has_table_privilege('authenticated', 'public.recipe_collection_recipes', 'delete'),
  'clients only read recipe_collection_recipes');
select ok(not has_table_privilege('anon', 'public.recipe_collections', 'select')
  and not has_table_privilege('anon', 'public.recipe_collection_recipes', 'select'), 'anon can''t read them');
select col_is_pk('public', 'recipe_collection_recipes', array['collection_id', 'recipe_id'],
  'a membership is keyed by collection and recipe');

-- Collections -----------------------------------------------------------------------------------------
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is(pg_temp.push_collection('1760000000001-0000-sam', 'c1000000-0000-7000-8000-000000000001',
    jsonb_build_object('household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'name', 'Mom''s cookbook',
      'created_by', '11111111-1111-1111-1111-111111111111')),
  '{"status": "applied"}'::jsonb, 'a member creates a collection');
select is((select jsonb_build_object('household_id', household_id, 'name', name, 'created_by', created_by, 'deleted_at', deleted_at)
    from public.recipe_collections where id = 'c1000000-0000-7000-8000-000000000001'),
  '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Mom''s cookbook", "created_by": "22222222-2222-2222-2222-222222222222", "deleted_at": null}'::jsonb,
  'the server sets created_by to the caller, ignoring the client''s');
select is((select field_clock from public.recipe_collections where id = 'c1000000-0000-7000-8000-000000000001'),
  '{"household_id": "1760000000001-0000-sam", "name": "1760000000001-0000-sam"}'::jsonb, 'created_by has no clock');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is(pg_temp.push_collection('1760000000003-0000-alex', 'c1000000-0000-7000-8000-000000000001',
    jsonb_build_object('name', 'Grandma')),
  '{"status": "applied"}'::jsonb, 'another member renames it');
select is(pg_temp.push_collection('1760000000002-0000-sam', 'c1000000-0000-7000-8000-000000000001',
    jsonb_build_object('name', 'Older name')),
  '{"status": "unchanged"}'::jsonb, 'an older rename loses');
select is((select name from public.recipe_collections where id = 'c1000000-0000-7000-8000-000000000001'),
  'Grandma', 'the newer name stays');
select is(pg_temp.push_collection('1760000000004-0000-alex', 'c1000000-0000-7000-8000-000000000001',
    jsonb_build_object('created_by', '11111111-1111-1111-1111-111111111111')),
  '{"status": "unchanged"}'::jsonb, 'created_by can''t be changed');

select is(pg_temp.push_collection('1760000000004-0001-alex', 'c1000000-0000-7000-8000-000000000002',
    jsonb_build_object('household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'name', 'grandma')),
  '{"status": "applied"}'::jsonb, 'a same name in another case is the app''s to refuse: the server keeps both');
select is(pg_temp.push_collection('1760000000004-0002-alex', 'c1000000-0000-7000-8000-000000000003',
    jsonb_build_object('household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'name', '')) ->> 'code',
  '23514', 'an empty name is refused');
select is(pg_temp.push_collection('1760000000004-0003-alex', 'c1000000-0000-7000-8000-000000000003',
    jsonb_build_object('household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'name', repeat('x', 41))) ->> 'code',
  '23514', 'a name over 40 characters is refused');
select is(pg_temp.push_collection('1760000000004-0004-alex', 'c1000000-0000-7000-8000-000000000003',
    jsonb_build_object('household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'name', ' Soups')) ->> 'code',
  '23514', 'an untrimmed name is refused');
select is(pg_temp.push_collection('1760000000004-0005-alex', 'c1000000-0000-7000-8000-000000000003',
    jsonb_build_object('household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'name', repeat('é', 40))),
  '{"status": "applied"}'::jsonb, 'a 40-character name is fine');

-- Memberships -----------------------------------------------------------------------------------------
select is(pg_temp.push_member('1760000000005-0000-alex', 'c1000000-0000-7000-8000-000000000001', 'a1000000-0000-7000-8000-000000000001',
    jsonb_build_object('household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'added_at', '2026-10-22T10:00:00Z')),
  '{"status": "applied"}'::jsonb, 'a member adds a recipe to a collection');
select is(pg_temp.push_member('1760000000006-0000-alex', 'c1000000-0000-7000-8000-000000000001', 'a1000000-0000-7000-8000-000000000001',
    jsonb_build_object('deleted_at', '2026-10-22T11:00:00Z', 'added_at', '2026-10-23T10:00:00Z')),
  '{"status": "applied"}'::jsonb, 'removing it sets deleted_at');
select is((select jsonb_build_object('added_at', added_at, 'deleted_at', deleted_at, 'field_clock', field_clock)
    from public.recipe_collection_recipes where collection_id = 'c1000000-0000-7000-8000-000000000001'),
  '{"added_at": "2026-10-22T10:00:00+00:00", "deleted_at": "2026-10-22T11:00:00+00:00", "field_clock": {"household_id": "1760000000005-0000-alex", "added_at": "1760000000005-0000-alex", "deleted_at": "1760000000006-0000-alex"}}'::jsonb,
  'deleted_at carries its HLC and added_at is kept from the insert');
select is(pg_temp.push_member('1760000000005-0001-sam', 'c1000000-0000-7000-8000-000000000001', 'a1000000-0000-7000-8000-000000000001',
    jsonb_build_object('deleted_at', null)),
  '{"status": "unchanged"}'::jsonb, 'an older add loses to the newer remove');
select is(pg_temp.push_member('1760000000007-0000-sam', 'c1000000-0000-7000-8000-000000000001', 'a1000000-0000-7000-8000-000000000001',
    jsonb_build_object('deleted_at', null)),
  '{"status": "applied"}'::jsonb, 'adding again at a later HLC restores it');

select is(pg_temp.push_member('1760000000008-0000-alex', 'c1000000-0000-7000-8000-000000000001', 'b1000000-0000-7000-8000-000000000001',
    jsonb_build_object('household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')) - 'status',
  '{"code": "22023", "message": "recipe and collection must be in household aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}'::jsonb,
  'another household''s recipe can''t go in the collection');
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select is(pg_temp.push_member('1760000000008-0001-pat', 'c1000000-0000-7000-8000-000000000001', 'b1000000-0000-7000-8000-000000000001',
    jsonb_build_object('household_id', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')) ->> 'message',
  'recipe and collection must be in household bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'a recipe can''t go in another household''s collection');
select is(pg_temp.push_member('1760000000008-0002-pat', 'c1000000-0000-7000-8000-000000000001', 'a1000000-0000-7000-8000-000000000002',
    jsonb_build_object('household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')) ->> 'message',
  'not a member of household aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a non-member can''t add to the collection');
select is(pg_temp.push_member('1760000000008-0003-pat', 'c1000000-0000-7000-8000-000000000001', 'a1000000-0000-7000-8000-000000000001',
    jsonb_build_object('deleted_at', '2026-10-24T10:00:00Z')) ->> 'message',
  'not a member of household aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a non-member can''t remove from it');
select is(pg_temp.push_collection('1760000000008-0004-pat', 'c1000000-0000-7000-8000-000000000001',
    jsonb_build_object('name', 'Mine now')) ->> 'message',
  'not a member of household aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a non-member can''t rename it');
select is(pg_temp.push_collection('1760000000008-0005-pat', 'c1000000-0000-7000-8000-000000000001',
    jsonb_build_object('household_id', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')) ->> 'message',
  'not a member of household aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nor move it to their household');
select is((select jsonb_build_object('name', name, 'household_id', household_id) from public.recipe_collections
    where id = 'c1000000-0000-7000-8000-000000000001'),
  '{"name": "Grandma", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}'::jsonb, 'refused writes leave it as it was');
select is((select count(*)::int from public.recipe_collection_recipes), 1, 'refused memberships left no row');

-- Deleting ---------------------------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is(pg_temp.push_collection('1760000000009-0000-alex', 'c1000000-0000-7000-8000-000000000001',
    jsonb_build_object('deleted_at', '2026-10-24T12:00:00Z')),
  '{"status": "applied"}'::jsonb, 'deleting a collection sets deleted_at');
select is((select deleted_at from public.recipe_collection_recipes where collection_id = 'c1000000-0000-7000-8000-000000000001'),
  null, 'its memberships are left as they are');

-- Reads ---------------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is((select count(*)::int from public.recipe_collections), 3, 'a member reads the household''s collections');
select is((select count(*)::int from public.recipe_collection_recipes), 1, 'and their memberships');
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select is((select count(*)::int from public.recipe_collections) + (select count(*)::int from public.recipe_collection_recipes),
  0, 'a non-member reads none');
select throws_ok($$ insert into public.recipe_collections (id, household_id, name) values
    ('c1000000-0000-7000-8000-000000000009', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Direct') $$,
  '42501', null, 'clients can''t insert directly');
reset role;

select * from finish();
rollback;
