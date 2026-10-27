-- Fewer server round trips (architecture review): fail_ingredients (categorize),
-- share_import_reuse_candidates and its URL lookup key (share-import worker), and
-- get_households_members (the app's names cache).
begin;
create extension if not exists pgtap with schema extensions;
select plan(38);

-- fail_ingredients ----------------------------------------------------------------------------------
insert into public.ingredients (normalized_name, display_name, status, attempts, default_category_id) values
  ('zz pending', 'zz pending', 'pending', 0, null),
  ('zz failed', 'zz failed', 'failed', 2, '019a4c10-0000-7000-8000-00000000ca20'),
  ('zz done', 'zz done', 'categorized', 0, (select id from public.categories where household_id is null order by id limit 1));

select lives_ok($$ select public.fail_ingredients(array['zz pending', 'zz failed', 'zz done', 'zz pending', 'zz missing']) $$,
  'fail_ingredients takes names with a repeat and one with no row');
select results_eq(
  $$ select normalized_name, status, attempts, default_category_id from public.ingredients
     where normalized_name like 'zz %' order by normalized_name $$,
  $$ values
    ('zz done'::text, 'categorized'::text, 0, (select id from public.categories where household_id is null order by id limit 1)),
    ('zz failed', 'failed', 3, '019a4c10-0000-7000-8000-00000000ca20'::uuid),
    ('zz pending', 'failed', 1, '019a4c10-0000-7000-8000-00000000ca20'::uuid) $$,
  'pending and failed rows become failed/Other with one more attempt (a repeat counts once); a categorized row is untouched');
select ok(not exists (select 1 from public.ingredients where normalized_name = 'zz missing'), 'a name with no row makes none');
select lives_ok($$ select public.fail_ingredients(array[]::text[]) $$, 'no names is a no-op');

select ok(has_function_privilege('service_role', 'public.fail_ingredients(text[])', 'execute'), 'the service role can call fail_ingredients');
select ok(not has_function_privilege('authenticated', 'public.fail_ingredients(text[])', 'execute'), 'a signed-in user can''t');
select ok(not has_function_privilege('anon', 'public.fail_ingredients(text[])', 'execute'), 'nor anon');

-- private.recipe_url_lookup_key ---------------------------------------------------------------------
-- Plain URLs: what canonicalRecipeUrl makes of the host and path.
select is(private.recipe_url_lookup_key('https://example.com/garlic-pasta'), 'example.com/garlic-pasta', 'host and path');
select is(private.recipe_url_lookup_key('HTTP://WWW.Example.COM/Garlic-Pasta///?utm_source=x#top'), 'example.com/Garlic-Pasta',
  'scheme and host case, one www., trailing slashes, query and fragment; the path keeps its case');
select is(private.recipe_url_lookup_key('https://www.www.example.com:8080/a//b/'), 'www.example.com/a//b', 'one www. only, a port dropped, inner slashes kept');
select is(private.recipe_url_lookup_key('https://example.com'), 'example.com', 'no path');
select is(private.recipe_url_lookup_key('https://example.com/'), 'example.com', 'a root path');
select is(private.recipe_url_lookup_key('https://example.com?id=3'), 'example.com', 'a query with no path');
select is(private.recipe_url_lookup_key('https://example.com/a@b/c:d'), 'example.com/a@b/c:d', '@ and : in the path');
-- Not plain enough to be sure: null, so always a candidate.
select is(private.recipe_url_lookup_key(null), null, 'null');
select is(private.recipe_url_lookup_key('ftp://example.com/a'), null, 'not http(s)');
select is(private.recipe_url_lookup_key(' https://example.com/a'), null, 'a leading space');
select is(private.recipe_url_lookup_key('https://user@example.com/a'), null, 'user info');
select is(private.recipe_url_lookup_key('https://café.com/a'), null, 'a non-ASCII host');
select is(private.recipe_url_lookup_key('https://example.com/caf%C3%A9'), null, 'a percent-encoded path');
select is(private.recipe_url_lookup_key('https://example.com/a b'), null, 'a space in the path');
select is(private.recipe_url_lookup_key('https://example.com/a/../b'), null, 'a dot segment');
select is(private.recipe_url_lookup_key('https://example.com\a'), null, 'a backslash');
select is(private.recipe_url_lookup_key('http://127.0.0.1/a'), null, 'an IPv4 host');
select is(private.recipe_url_lookup_key('http://0x7f.1/a'), null, 'a hex IPv4 host');
select is(private.recipe_url_lookup_key('https://a..com/x'), null, 'an empty label');

select has_index('public', 'recipes', 'recipes_household_url_key_idx', 'recipes has the URL lookup key index');

-- share_import_reuse_candidates ---------------------------------------------------------------------
insert into public.households (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Home'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Cabin');
insert into public.recipes (id, household_id, name, source_url, deleted_at) values
  ('c0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Pasta', 'https://example.com/pasta', null),
  ('c0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Pasta again', 'https://WWW.example.com/pasta/?utm_source=x', null),
  ('c0000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'Odd link', 'https://example.com/p%61sta', null),
  ('c0000000-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'Soup', 'https://example.com/soup', null),
  ('c0000000-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', 'Deleted pasta', 'https://example.com/pasta', now()),
  ('c0000000-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001', 'No link', null, null),
  ('c0000000-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000002', 'Cabin pasta', 'https://example.com/pasta', null),
  ('c0000000-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-000000000002', 'Earlier run', null, null),
  ('c0000000-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000002', 'Deleted run', null, now());

select results_eq(
  $$ select id, name from public.share_import_reuse_candidates(
       'aaaaaaaa-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000008', 'example.com/pasta') order by id $$,
  $$ values
    ('c0000000-0000-0000-0000-000000000001'::uuid, 'Pasta'::text),
    ('c0000000-0000-0000-0000-000000000002', 'Pasta again'),
    ('c0000000-0000-0000-0000-000000000003', 'Odd link'),
    ('c0000000-0000-0000-0000-000000000008', 'Earlier run') $$,
  'the earlier run (any household), and the household''s live recipes whose key matches or is unknown; not another URL, a deleted one, one with no link or another household''s');
select results_eq(
  $$ select household_id, source_url, deleted_at from public.share_import_reuse_candidates(
       'aaaaaaaa-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', null) $$,
  $$ values ('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'https://example.com/pasta'::text, null::timestamptz) $$,
  'a photo import (no URL key) gets only its own earlier run, with the columns the worker reads');
select is_empty(
  $$ select * from public.share_import_reuse_candidates(
       'aaaaaaaa-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000009', null) $$,
  'a deleted earlier run isn''t a candidate');
select ok(has_function_privilege('service_role', 'public.share_import_reuse_candidates(uuid, uuid, text)', 'execute'),
  'the service role can call share_import_reuse_candidates');
select ok(not has_function_privilege('authenticated', 'public.share_import_reuse_candidates(uuid, uuid, text)', 'execute'),
  'a signed-in user can''t');

-- get_households_members ----------------------------------------------------------------------------
insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('11111111-0000-0000-0000-000000000001', 'jo@test.local', 'authenticated', 'authenticated', '{"given_name":"Jo","family_name":"Doe"}'),
  ('11111111-0000-0000-0000-000000000002', 'alex@test.local', 'authenticated', 'authenticated', '{"given_name":"Alex"}'),
  ('11111111-0000-0000-0000-000000000003', 'sam@test.local', 'authenticated', 'authenticated', '{"given_name":"Sam"}');
insert into public.household_members (household_id, user_id, role, position, joined_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000002', 'member', 1, '2026-01-02T00:00:00Z'),
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'owner', 1, '2026-01-01T00:00:00Z'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'owner', 2, '2026-01-03T00:00:00Z'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000003', 'member', 1, '2026-01-04T00:00:00Z');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-0000-0000-0000-000000000001","role":"authenticated"}', true);
select results_eq(
  $$ select household_id, user_id, first_name, last_name, role, joined_at from public.get_households_members(
       array['aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001']::uuid[]) $$,
  $$ values
    ('aaaaaaaa-0000-0000-0000-000000000001'::uuid, '11111111-0000-0000-0000-000000000001'::uuid, 'Jo'::text, 'Doe'::text, 'owner'::text, '2026-01-01T00:00:00Z'::timestamptz),
    ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000002', 'Alex', null, 'member', '2026-01-02T00:00:00Z'),
    ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'Jo', 'Doe', 'owner', '2026-01-03T00:00:00Z'),
    ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000003', 'Sam', null, 'member', '2026-01-04T00:00:00Z') $$,
  'every member of both households in one call, by household, owners first');
select results_eq(
  $$ select household_id, user_id from public.get_households_members(array['aaaaaaaa-0000-0000-0000-000000000001']::uuid[])
     except
     select household_id, user_id from public.get_household_members('aaaaaaaa-0000-0000-0000-000000000001') x
       cross join (select 'aaaaaaaa-0000-0000-0000-000000000001'::uuid as household_id) h $$,
  $$ select null::uuid, null::uuid where false $$,
  'the same members as get_household_members');

select set_config('request.jwt.claims', '{"sub":"11111111-0000-0000-0000-000000000003","role":"authenticated"}', true);
select results_eq(
  $$ select household_id, user_id from public.get_households_members(
       array['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'ffffffff-ffff-ffff-ffff-ffffffffffff']::uuid[]) $$,
  $$ values
    ('aaaaaaaa-0000-0000-0000-000000000002'::uuid, '11111111-0000-0000-0000-000000000001'::uuid),
    ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000003') $$,
  'a household the caller isn''t in, or an unknown id, has no rows and doesn''t fail the others');
select is_empty($$ select * from public.get_households_members(array[]::uuid[]) $$, 'no households, no rows');

reset role;
select ok(has_function_privilege('authenticated', 'public.get_households_members(uuid[])', 'execute'), 'a signed-in user can call get_households_members');
select ok(not has_function_privilege('anon', 'public.get_households_members(uuid[])', 'execute'), 'anon can''t');

select * from finish();
rollback;
