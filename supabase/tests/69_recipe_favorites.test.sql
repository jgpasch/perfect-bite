-- Favorites per person (spec 4.14 Favorites, 5, 7.1, 4.12 User activity): recipe_favorites read by
-- every member of its household, written only through apply_mutations for the caller's own row in
-- the recipe's household (deleted_at as one LWW field), leaving deletes the leaver's rows, and the
-- recipe.favorited / recipe.unfavorited entries.
begin;
create extension if not exists pgtap with schema extensions;
select plan(32);

-- Fixtures (as postgres, no user, so nothing is logged) ------------------------------------------
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
delete from private.user_activity;

-- Helpers ------------------------------------------------------------------------------------------
-- One favorite mutation through apply_mutations, as whoever the claims name.
create function pg_temp.push_fav(p_hlc text, p_recipe text, p_user text, p_fields jsonb)
returns jsonb language sql as $$
  select public.apply_mutations(jsonb_build_array(jsonb_build_object(
    'table', 'recipe_favorites', 'key', jsonb_build_object('recipe_id', p_recipe, 'user_id', p_user),
    'fields', p_fields, 'hlc', p_hlc))) -> 0
$$;
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_id, 'role', 'authenticated')::text, true);
$$;
-- Takes the entries logged so far (oldest first) and clears them.
create function pg_temp.taken() returns jsonb language sql as $$
  with t as (delete from private.user_activity returning *)
  select coalesce(jsonb_agg(jsonb_build_object('user', user_id, 'area', area, 'action', action, 'entity', entity_id, 'data', data) order by id), '[]')
  from t
$$;

-- Schema and privileges ------------------------------------------------------------------------------
select ok(has_table_privilege('authenticated', 'public.recipe_favorites', 'select')
  and not has_table_privilege('authenticated', 'public.recipe_favorites', 'insert')
  and not has_table_privilege('authenticated', 'public.recipe_favorites', 'update')
  and not has_table_privilege('authenticated', 'public.recipe_favorites', 'delete'),
  'clients only read recipe_favorites');
select ok(not has_table_privilege('anon', 'public.recipe_favorites', 'select'), 'anon can''t read it');
select ok(exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'recipe_favorites'),
  'recipe_favorites is in the realtime publication');
select ok(not has_function_privilege('authenticated',
  'private.activity_recipe_favorites(public.recipe_favorites, public.recipe_favorites)', 'execute'),
  'clients can''t call its activity function');

-- Writing your own row ---------------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is(pg_temp.push_fav('1760000000001-0000-alex', 'a1000000-0000-7000-8000-000000000001', '11111111-1111-1111-1111-111111111111',
    jsonb_build_object('household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')),
  '{"status": "applied"}'::jsonb, 'a member favorites a recipe of their household');
select is((select jsonb_build_object('household_id', household_id, 'deleted_at', deleted_at, 'field_clock', field_clock)
    from public.recipe_favorites where recipe_id = 'a1000000-0000-7000-8000-000000000001' and user_id = '11111111-1111-1111-1111-111111111111'),
  '{"household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "deleted_at": null, "field_clock": {"household_id": "1760000000001-0000-alex"}}'::jsonb,
  'the row is inserted live');
select is(pg_temp.taken(), $$[{"user": "11111111-1111-1111-1111-111111111111", "area": "recipes", "action": "recipe.favorited",
  "entity": "a1000000-0000-7000-8000-000000000001", "data": {"household": "Home", "recipe": "Tacos"}}]$$::jsonb,
  'recipe.favorited is logged with the recipe''s name');

select is(pg_temp.push_fav('1760000000005-0000-alex', 'a1000000-0000-7000-8000-000000000001', '11111111-1111-1111-1111-111111111111',
    jsonb_build_object('deleted_at', '2026-10-22T10:00:00Z')),
  '{"status": "applied"}'::jsonb, 'unfavoriting sets deleted_at');
select is((select deleted_at from public.recipe_favorites where recipe_id = 'a1000000-0000-7000-8000-000000000001'
    and user_id = '11111111-1111-1111-1111-111111111111'),
  '2026-10-22T10:00:00Z'::timestamptz, 'the row is unfavorited');
select is(pg_temp.taken(), $$[{"user": "11111111-1111-1111-1111-111111111111", "area": "recipes", "action": "recipe.unfavorited",
  "entity": "a1000000-0000-7000-8000-000000000001", "data": {"household": "Home", "recipe": "Tacos"}}]$$::jsonb,
  'recipe.unfavorited is logged');

select is(pg_temp.push_fav('1760000000003-0000-alex', 'a1000000-0000-7000-8000-000000000001', '11111111-1111-1111-1111-111111111111',
    jsonb_build_object('deleted_at', null)),
  '{"status": "unchanged"}'::jsonb, 'an older favorite loses to the newer unfavorite');
select isnt((select deleted_at from public.recipe_favorites where recipe_id = 'a1000000-0000-7000-8000-000000000001'
    and user_id = '11111111-1111-1111-1111-111111111111'), null, 'it stays unfavorited');
select is(pg_temp.taken(), '[]'::jsonb, 'a losing write logs nothing');

select is(pg_temp.push_fav('1760000000005-0001-alex', 'a1000000-0000-7000-8000-000000000001', '11111111-1111-1111-1111-111111111111',
    jsonb_build_object('deleted_at', null)),
  '{"status": "applied"}'::jsonb, 'favoriting again at a later HLC restores it');
select is((select jsonb_build_object('deleted_at', deleted_at, 'field_clock', field_clock)
    from public.recipe_favorites where recipe_id = 'a1000000-0000-7000-8000-000000000001' and user_id = '11111111-1111-1111-1111-111111111111'),
  '{"deleted_at": null, "field_clock": {"household_id": "1760000000001-0000-alex", "deleted_at": "1760000000005-0001-alex"}}'::jsonb,
  'deleted_at is cleared and carries the winning HLC');
select is(pg_temp.taken(), $$[{"user": "11111111-1111-1111-1111-111111111111", "area": "recipes", "action": "recipe.favorited",
  "entity": "a1000000-0000-7000-8000-000000000001", "data": {"household": "Home", "recipe": "Tacos"}}]$$::jsonb,
  'a restore logs recipe.favorited');

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is(pg_temp.push_fav('1760000000006-0000-sam', 'a1000000-0000-7000-8000-000000000001', '22222222-2222-2222-2222-222222222222',
    jsonb_build_object('household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')),
  '{"status": "applied"}'::jsonb, 'another member favorites the same recipe');
select is(pg_temp.push_fav('1760000000006-0001-sam', 'a1000000-0000-7000-8000-000000000002', '22222222-2222-2222-2222-222222222222',
    jsonb_build_object('household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'deleted_at', '2026-10-22T10:00:00Z')),
  '{"status": "applied"}'::jsonb, 'a row inserted already unfavorited is applied');
select is((select array_agg(action) from private.user_activity), array['recipe.favorited'],
  'only the live insert logs recipe.favorited');
delete from private.user_activity;

-- Refused writes -------------------------------------------------------------------------------------
select is(pg_temp.push_fav('1760000000007-0000-sam', 'a1000000-0000-7000-8000-000000000002', '11111111-1111-1111-1111-111111111111',
    jsonb_build_object('household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')) - 'status',
  '{"code": "42501", "message": "not your favorite"}'::jsonb, 'inserting another member''s favorite is refused');
select is(pg_temp.push_fav('1760000000007-0001-sam', 'a1000000-0000-7000-8000-000000000001', '11111111-1111-1111-1111-111111111111',
    jsonb_build_object('deleted_at', '2026-10-22T11:00:00Z')) ->> 'message',
  'not your favorite', 'unfavoriting another member''s favorite is refused');
select is((select deleted_at from public.recipe_favorites where recipe_id = 'a1000000-0000-7000-8000-000000000001'
    and user_id = '11111111-1111-1111-1111-111111111111'), null, 'their favorite is untouched');
select is(pg_temp.push_fav('1760000000007-0002-sam', 'a1000000-0000-7000-8000-000000000002', '22222222-2222-2222-2222-222222222222',
    jsonb_build_object('household_id', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')) ->> 'message',
  'not your favorite', 'a household_id that isn''t the recipe''s is refused, even on an existing row');
select is(pg_temp.push_fav('1760000000007-0003-sam', 'b1000000-0000-7000-8000-000000000001', '22222222-2222-2222-2222-222222222222',
    jsonb_build_object('household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')) ->> 'message',
  'not your favorite', 'another household''s recipe filed under your household is refused');

select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select is(pg_temp.push_fav('1760000000008-0000-pat', 'a1000000-0000-7000-8000-000000000001', '33333333-3333-3333-3333-333333333333',
    jsonb_build_object('household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')) - 'status',
  '{"code": "42501", "message": "not a member of household aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}'::jsonb,
  'a non-member can''t favorite the household''s recipe');
select is((select count(*)::int from public.recipe_favorites), 3, 'no refused write left a row');
select is(pg_temp.taken(), '[]'::jsonb, 'refused writes log nothing');

-- Reads ---------------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is((select array_agg(user_id::text || ':' || recipe_id::text order by user_id, recipe_id) from public.recipe_favorites), array[
  '11111111-1111-1111-1111-111111111111:a1000000-0000-7000-8000-000000000001',
  '22222222-2222-2222-2222-222222222222:a1000000-0000-7000-8000-000000000001',
  '22222222-2222-2222-2222-222222222222:a1000000-0000-7000-8000-000000000002'], 'a member reads every member''s rows');
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select is((select count(*)::int from public.recipe_favorites), 0, 'a non-member reads none');
select throws_ok($$ insert into public.recipe_favorites (recipe_id, user_id, household_id) values
    ('b1000000-0000-7000-8000-000000000001', '33333333-3333-3333-3333-333333333333', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') $$,
  '42501', null, 'clients can''t insert directly');
reset role;

-- Leaving ---------------------------------------------------------------------------------------------
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select public.leave_household('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select is((select array_agg(user_id::text) from public.recipe_favorites), array['11111111-1111-1111-1111-111111111111'],
  'leaving deletes the leaver''s rows and keeps the others''');
select is((select array_agg(action) from private.user_activity), array['household.left'],
  'leaving logs only household.left');

select * from finish();
rollback;
