-- The meal plan (spec 4.16, 5): entries written through apply_mutations by id, added_by set by the
-- server, a recipe only from the entry's own household, the kind rules, and only members see them.
begin;
create extension if not exists pgtap with schema extensions;
select plan(36);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex owns household A (with Tacos), which Jamie is also in. Sam owns household S (with Chili).
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'jamie@test.local', 'authenticated', 'authenticated');

insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sam''s household');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'member', 1),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner', 1);
insert into public.recipes (id, household_id, name) values
  ('a0000000-0000-0000-0000-00000000000a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tacos'),
  ('b0000000-0000-0000-0000-00000000000b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Chili');
insert into public.meal_plan_entries (id, household_id, plan_date, meal, kind, recipe_id, added_by) values
  ('e0000000-0000-0000-0000-0000000000b1', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '2026-10-15', 'dinner', 'recipe',
   'b0000000-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222');

select has_table('public', 'meal_plan_entries', 'meal_plan_entries exists');
select ok(
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'meal_plan_entries'),
  'meal_plan_entries is in the realtime publication');

-- As Alex -----------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

-- Insert a recipe entry with a spoofed added_by, and a note
select is(
  public.apply_mutations($$ [
    { "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a1", "hlc": "1760000000010-0000-alex",
      "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "plan_date": "2026-10-15", "meal": "dinner",
                  "position": 0, "kind": "recipe", "recipe_id": "a0000000-0000-0000-0000-00000000000a", "note": null,
                  "deleted_at": null, "added_by": "33333333-3333-3333-3333-333333333333" } },
    { "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a2", "hlc": "1760000000010-0001-alex",
      "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "plan_date": "2026-10-16", "meal": "lunch",
                  "kind": "note", "note": "Pizza night" } }
  ] $$),
  '[{"status": "applied"}, {"status": "applied"}]'::jsonb, 'a member adds a recipe entry and a note');
select results_eq(
  $$ select id::text, plan_date, meal, kind, recipe_id, note, added_by, field_clock ? 'added_by'
     from public.meal_plan_entries order by plan_date $$,
  $$ values
    ('e0000000-0000-0000-0000-0000000000a1', '2026-10-15'::date, 'dinner', 'recipe',
     'a0000000-0000-0000-0000-00000000000a'::uuid, null::text, '11111111-1111-1111-1111-111111111111'::uuid, false),
    ('e0000000-0000-0000-0000-0000000000a2', '2026-10-16'::date, 'lunch', 'note',
     null::uuid, 'Pizza night', '11111111-1111-1111-1111-111111111111'::uuid, false) $$,
  'Alex sees only their household''s entries, added_by Alex whatever the client sent, with no clock for it');

-- Clear, then a later edit can't change added_by
select is(
  public.apply_mutations($$ [{ "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a1",
    "hlc": "1760000000020-0000-alex", "fields": { "deleted_at": "2026-10-13T10:00:00Z", "added_by": "33333333-3333-3333-3333-333333333333" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'a member clears the slot');
select results_eq(
  $$ select deleted_at, added_by, field_clock ->> 'deleted_at' from public.meal_plan_entries where id = 'e0000000-0000-0000-0000-0000000000a1' $$,
  $$ values ('2026-10-13T10:00:00Z'::timestamptz, '11111111-1111-1111-1111-111111111111'::uuid, '1760000000020-0000-alex') $$,
  'clearing sets deleted_at; added_by is ignored on update');
select is(
  public.apply_mutations($$ [{ "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a1",
    "hlc": "1760000000015-0000-jami", "fields": { "position": 3 } }] $$),
  '[{"status": "applied"}]'::jsonb, 'an older edit to another field still applies (field-level LWW)');
select is(
  public.apply_mutations($$ [{ "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a1",
    "hlc": "1760000000015-0001-jami", "fields": { "deleted_at": null } }] $$),
  '[{"status": "unchanged"}]'::jsonb, 'an older un-clear loses to the clear');

-- A recipe from another household
select is(
  public.apply_mutations($$ [{ "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a3", "hlc": "1760000000030-0000-alex",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "plan_date": "2026-10-17", "meal": "dinner",
                "kind": "recipe", "recipe_id": "b0000000-0000-0000-0000-00000000000b" } }] $$) -> 0 ->> 'code',
  '22023', 'an entry can''t use another household''s recipe');
select is(
  public.apply_mutations($$ [{ "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a2", "hlc": "1760000000030-0001-alex",
    "fields": { "kind": "recipe", "recipe_id": "b0000000-0000-0000-0000-00000000000b", "note": null } }] $$) -> 0 ->> 'code',
  '22023', 'nor be changed to point at one');
select is(
  public.apply_mutations($$ [{ "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a3", "hlc": "1760000000030-0002-alex",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "plan_date": "2026-10-17", "meal": "dinner",
                "kind": "recipe", "recipe_id": "c0000000-0000-0000-0000-00000000000c" } }] $$) -> 0 ->> 'code',
  '22023', 'nor a recipe that doesn''t exist');

-- The kind rules
select is(
  public.apply_mutations($$ [{ "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a4", "hlc": "1760000000040-0000-alex",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "plan_date": "2026-10-17", "meal": "dinner", "kind": "recipe" } }] $$) -> 0 ->> 'code',
  '23514', 'a recipe entry needs a recipe');
select is(
  public.apply_mutations($$ [{ "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a4", "hlc": "1760000000040-0001-alex",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "plan_date": "2026-10-17", "meal": "dinner",
                "kind": "leftovers", "recipe_id": "a0000000-0000-0000-0000-00000000000a" } }] $$) -> 0 ->> 'code',
  '23514', 'only a recipe entry has a recipe');
select is(
  public.apply_mutations($$ [{ "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a4", "hlc": "1760000000040-0002-alex",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "plan_date": "2026-10-17", "meal": "dinner", "kind": "note" } }] $$) -> 0 ->> 'code',
  '23514', 'a note entry needs a note');
select is(
  public.apply_mutations($$ [{ "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a4", "hlc": "1760000000040-0003-alex",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "plan_date": "2026-10-17", "meal": "dinner",
                "kind": "eating-out", "note": "Thai place" } }] $$) -> 0 ->> 'code',
  '23514', 'only a note entry has a note');
select is(
  public.apply_mutations($$ [{ "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a4", "hlc": "1760000000040-0004-alex",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "plan_date": "2026-10-17", "meal": "dinner",
                "kind": "note", "note": "" } }] $$) -> 0 ->> 'code',
  '23514', 'a note isn''t empty');
select is(
  public.apply_mutations($$ [{ "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a4", "hlc": "1760000000040-0005-alex",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "plan_date": "2026-10-17", "meal": "dinner",
                "kind": "note", "note": " Pizza " } }] $$) -> 0 ->> 'code',
  '23514', 'a note is trimmed');
select is(
  public.apply_mutations(jsonb_build_array(jsonb_build_object(
    'table', 'meal_plan_entries', 'id', 'e0000000-0000-0000-0000-0000000000a4', 'hlc', '1760000000040-0006-alex',
    'fields', jsonb_build_object('household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'plan_date', '2026-10-17',
      'meal', 'dinner', 'kind', 'note', 'note', repeat('x', 61))))) -> 0 ->> 'code',
  '23514', 'a note is at most 60 characters');
select is(
  public.apply_mutations(jsonb_build_array(jsonb_build_object(
    'table', 'meal_plan_entries', 'id', 'e0000000-0000-0000-0000-0000000000a4', 'hlc', '1760000000040-0007-alex',
    'fields', jsonb_build_object('household_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'plan_date', '2026-10-17',
      'meal', 'dinner', 'kind', 'note', 'note', repeat('ñ', 60))))),
  '[{"status": "applied"}]'::jsonb, 'a 60-character note is fine');
select is(
  public.apply_mutations($$ [{ "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a4", "hlc": "1760000000040-0008-alex",
    "fields": { "kind": "leftovers" } }] $$) -> 0 ->> 'code',
  '23514', 'changing a note entry''s kind without clearing its note breaks the rule');
select is(
  public.apply_mutations($$ [{ "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a5", "hlc": "1760000000040-0009-alex",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "plan_date": "2026-10-17", "meal": "brunch", "kind": "leftovers" } }] $$) -> 0 ->> 'code',
  '23514', 'meal is breakfast, lunch or dinner');
select is(
  public.apply_mutations($$ [{ "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a5", "hlc": "1760000000040-0010-alex",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "plan_date": "2026-10-17", "meal": "lunch", "kind": "takeaway" } }] $$) -> 0 ->> 'code',
  '23514', 'kind is one of the four');
select is(
  public.apply_mutations($$ [{ "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a5", "hlc": "1760000000040-0011-alex",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "plan_date": "2026-10-17", "meal": "lunch", "kind": "eating-out" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Leftovers and Eating out need neither a recipe nor a note');

-- Not a member, and no direct writes
select is(
  public.apply_mutations($$ [{ "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000b1",
    "hlc": "1760000000050-0000-alex", "fields": { "deleted_at": "2026-10-13T10:00:00Z" } }] $$) -> 0 ->> 'code',
  '42501', 'a non-member can''t clear another household''s entry');
select is(
  public.apply_mutations($$ [{ "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a6", "hlc": "1760000000050-0001-alex",
    "fields": { "household_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "plan_date": "2026-10-17", "meal": "lunch", "kind": "leftovers" } }] $$) -> 0 ->> 'code',
  '42501', 'a non-member can''t add an entry to another household');
select is(
  public.apply_mutations($$ [{ "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a2", "hlc": "1760000000050-0002-alex",
    "fields": { "household_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" } }] $$) -> 0 ->> 'code',
  '22023', 'an entry can''t move to another household');
select throws_ok(
  $$ insert into public.meal_plan_entries (id, household_id, plan_date, meal, kind)
     values ('e0000000-0000-0000-0000-0000000000a7', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-10-18', 'lunch', 'leftovers') $$,
  '42501', null, 'entries aren''t inserted directly');
select throws_ok($$ update public.meal_plan_entries set position = 9 $$, '42501', null, 'entries aren''t updated directly');
select throws_ok($$ delete from public.meal_plan_entries $$, '42501', null, 'entries aren''t deleted directly');

-- As Jamie, the other member of A ------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);

select results_eq(
  $$ select count(*)::int from public.meal_plan_entries where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' $$,
  $$ values (4) $$, 'every member sees the household''s entries');
select is(
  public.apply_mutations($$ [{ "table": "meal_plan_entries", "id": "e0000000-0000-0000-0000-0000000000a8", "hlc": "1760000000060-0000-jami",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "plan_date": "2026-10-18", "meal": "breakfast", "kind": "leftovers" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'another member adds an entry');
select results_eq(
  $$ select added_by from public.meal_plan_entries where id = 'e0000000-0000-0000-0000-0000000000a8' $$,
  $$ values ('33333333-3333-3333-3333-333333333333'::uuid) $$, 'added_by is whoever inserted it');

-- As Sam, in another household ---------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);

select results_eq(
  $$ select id::text from public.meal_plan_entries $$,
  $$ values ('e0000000-0000-0000-0000-0000000000b1') $$,
  'a non-member can''t read another household''s entries');

-- Jamie leaves A -----------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
do $$ begin perform public.leave_household('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); end $$;

select is_empty($$ select 1 from public.meal_plan_entries where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' $$,
  'after leaving, Jamie can''t read the household''s entries');

-- Cascades (as postgres) ---------------------------------------------------------------
reset role;
delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
select results_eq(
  $$ select count(*)::int from public.meal_plan_entries where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and added_by is null $$,
  $$ values (4) $$, 'deleting the user who added entries keeps them, with no added_by');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
do $$ begin perform public.delete_household('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'); end $$;
reset role;
select is_empty($$ select 1 from public.meal_plan_entries where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' $$,
  'deleting a household deletes its entries (and its recipes, which they point at)');

select * from finish();
rollback;
