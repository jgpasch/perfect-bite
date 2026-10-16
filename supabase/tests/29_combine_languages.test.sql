-- Combine across languages is a household setting (spec 4.15, 4.4): households.combine_languages,
-- off by default, decides whether apply_mutations merges an item that opens beside an open item
-- of its family. Any member changes it with set_combine_languages; others can't.
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex owns Off (left at the default) and On, where Pat is a plain member. Sam is in neither.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated'),
  ('44444444-4444-4444-4444-444444444444', 'pat@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name, updated_at) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Off', '2026-01-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', 'On', '2026-01-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000d', 'Sam''s', '2026-01-01');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('aaaaaaaa-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', 'owner', 2),
  ('aaaaaaaa-0000-0000-0000-00000000000b', '44444444-4444-4444-4444-444444444444', 'member', 1),
  ('aaaaaaaa-0000-0000-0000-00000000000d', '22222222-2222-2222-2222-222222222222', 'owner', 1);
insert into public.lists (id, household_id, name, position) values
  ('a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Off one', 1),
  ('a1000000-0000-7000-8000-000000000002', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Off two', 2),
  ('a1000000-0000-7000-8000-000000000003', 'aaaaaaaa-0000-0000-0000-00000000000b', 'On one', 1),
  ('a1000000-0000-7000-8000-000000000004', 'aaaaaaaa-0000-0000-0000-00000000000b', 'On two', 2);

insert into public.ingredients (normalized_name, display_name, status, lang) values
  ('test cucumber', 'cucumber', 'categorized', 'en');
insert into public.ingredients (normalized_name, display_name, status, lang, same_as, linked_by) values
  ('test pepino', 'pepino', 'categorized', 'es', 'test cucumber', 'seed');

-- Access ------------------------------------------------------------------------
select is((select combine_languages from public.households where id = 'aaaaaaaa-0000-0000-0000-00000000000a'), false,
  'a household doesn''t combine languages by default');
select ok(has_function_privilege('authenticated', 'public.set_combine_languages(uuid, boolean)', 'execute'),
  'signed-in users can call set_combine_languages');
select ok(
  not has_function_privilege('anon', 'public.set_combine_languages(uuid, boolean)', 'execute')
  and not has_function_privilege('public', 'public.set_combine_languages(uuid, boolean)', 'execute'),
  'anon and public can''t call set_combine_languages');

-- Who can change it -------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
select lives_ok($$ select public.set_combine_languages('aaaaaaaa-0000-0000-0000-00000000000b', true) $$,
  'a plain member turns it on');
select results_eq($$ select combine_languages, updated_at > '2026-01-01' from public.households where id = 'aaaaaaaa-0000-0000-0000-00000000000b' $$,
  $$ values (true, true) $$, 'it''s on, and updated_at is bumped so pulls carry it');

select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select throws_ok($$ select public.set_combine_languages('aaaaaaaa-0000-0000-0000-00000000000a', true) $$,
  '42501', 'not a member', 'a non-member can''t change it');
select throws_ok($$ select public.set_combine_languages('aaaaaaaa-0000-0000-0000-0000000000ff', true) $$,
  '42501', 'not a member', 'a household that doesn''t exist raises not a member');
select throws_ok($$ update public.households set combine_languages = true where id = 'aaaaaaaa-0000-0000-0000-00000000000d' $$,
  '42501', 'permission denied for table households', 'even an owner can''t update households directly');
reset role;
select is((select combine_languages from public.households where id = 'aaaaaaaa-0000-0000-0000-00000000000d'), false,
  'so the setting is unchanged');
set local role authenticated;

select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.set_combine_languages('aaaaaaaa-0000-0000-0000-00000000000a', true) $$,
  '42501', 'not authenticated', 'changing it needs a signed-in user');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select public.set_combine_languages('aaaaaaaa-0000-0000-0000-00000000000a', null) $$,
  '22023', 'combine_languages must be true or false', 'null isn''t a setting');
select lives_ok($$ select public.set_combine_languages('aaaaaaaa-0000-0000-0000-00000000000a', false) $$,
  'setting the value it already has succeeds');
select results_eq($$ select combine_languages, updated_at from public.households where id = 'aaaaaaaa-0000-0000-0000-00000000000a' $$,
  $$ values (false, '2026-01-01'::timestamptz) $$, 'and doesn''t bump updated_at');

-- Off: twins stay two items, both ways ------------------------------------------
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000011", "hlc": "1760000000001-0000-alex",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-0000-0000-0000-00000000000a", "ingredient_name": "test cucumber", "display_name": "cucumber" } },
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000012", "hlc": "1760000000002-0000-sam1",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-0000-0000-0000-00000000000a", "ingredient_name": "test pepino", "display_name": "pepino" } },
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000021", "hlc": "1760000000003-0000-alex",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000002", "household_id": "aaaaaaaa-0000-0000-0000-00000000000a", "ingredient_name": "test pepino", "display_name": "pepino" } },
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000022", "hlc": "1760000000004-0000-sam1",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000002", "household_id": "aaaaaaaa-0000-0000-0000-00000000000a", "ingredient_name": "test cucumber", "display_name": "cucumber" } }
  ] $$),
  '[{"status": "applied"}, {"status": "applied"}, {"status": "applied"}, {"status": "applied"}]'::jsonb,
  'off: pepino beside cucumber, and cucumber beside pepino, are new items');
select is(
  (select count(*)::int from public.list_items where household_id = 'aaaaaaaa-0000-0000-0000-00000000000a' and deleted_at is null), 4,
  'off: all four stay open');

-- Off: the same key still merges.
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000013", "hlc": "1760000000005-0000-sam1",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-0000-0000-0000-00000000000a", "ingredient_name": "test pepino", "display_name": "pepino" } }
  ] $$),
  '[{"status": "merged", "merged_into": "a2000000-0000-7000-8000-000000000012"}]'::jsonb,
  'off: a second pepino still merges into the open pepino');

-- Off: reopening a twin doesn't merge it.
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000012", "hlc": "1760000000006-0000-alex", "fields": { "checked_at": "2026-10-14T10:00:00Z" } },
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000012", "hlc": "1760000000007-0000-alex", "fields": { "checked_at": null } }
  ] $$),
  '[{"status": "applied"}, {"status": "applied"}]'::jsonb,
  'off: unchecking pepino beside an open cucumber leaves it its own item');

-- On: twins merge, both ways ----------------------------------------------------
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000031", "hlc": "1760000000008-0000-alex",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000003", "household_id": "aaaaaaaa-0000-0000-0000-00000000000b", "ingredient_name": "test cucumber", "display_name": "cucumber" } },
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000032", "hlc": "1760000000009-0000-sam1",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000003", "household_id": "aaaaaaaa-0000-0000-0000-00000000000b", "ingredient_name": "test pepino", "display_name": "pepino" } },
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000041", "hlc": "1760000000010-0000-alex",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000004", "household_id": "aaaaaaaa-0000-0000-0000-00000000000b", "ingredient_name": "test pepino", "display_name": "pepino" } },
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000042", "hlc": "1760000000011-0000-sam1",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000004", "household_id": "aaaaaaaa-0000-0000-0000-00000000000b", "ingredient_name": "test cucumber", "display_name": "cucumber" } }
  ] $$),
  '[{"status": "applied"}, {"status": "merged", "merged_into": "a2000000-0000-7000-8000-000000000031"}, {"status": "applied"}, {"status": "merged", "merged_into": "a2000000-0000-7000-8000-000000000041"}]'::jsonb,
  'on: pepino beside cucumber, and cucumber beside pepino, merge into the first');

-- Turning it on merges nothing already on a list ----------------------------------
select lives_ok($$ select public.set_combine_languages('aaaaaaaa-0000-0000-0000-00000000000a', true) $$,
  'Alex turns Off''s setting on');
select is(
  (select count(*)::int from public.list_items where household_id = 'aaaaaaaa-0000-0000-0000-00000000000a' and deleted_at is null), 4,
  'the open twins on Off''s lists are still four items');
select is(
  public.apply_mutations($$ [{ "table": "list_items", "id": "a2000000-0000-7000-8000-000000000012", "hlc": "1760000000012-0000-alex", "fields": { "note": "small" } }] $$),
  '[{"status": "applied"}]'::jsonb,
  'an edit to one doesn''t merge it');
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000022", "hlc": "1760000000013-0000-alex", "fields": { "checked_at": "2026-10-14T10:00:00Z" } },
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000022", "hlc": "1760000000014-0000-alex", "fields": { "checked_at": null } }
  ] $$),
  '[{"status": "applied"}, {"status": "merged", "merged_into": "a2000000-0000-7000-8000-000000000021"}]'::jsonb,
  'reopening one now merges it into its twin');

-- Turning it off leaves merged items as they are ----------------------------------
select lives_ok($$ select public.set_combine_languages('aaaaaaaa-0000-0000-0000-00000000000b', false) $$,
  'Alex turns On''s setting off');
select results_eq(
  $$ select id from public.list_items where household_id = 'aaaaaaaa-0000-0000-0000-00000000000b' and deleted_at is null order by id $$,
  $$ values ('a2000000-0000-7000-8000-000000000031'::uuid), ('a2000000-0000-7000-8000-000000000041'::uuid) $$,
  'the items merged while it was on stay merged');

select * from finish();
rollback;
