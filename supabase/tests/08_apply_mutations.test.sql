-- apply_mutations: field-level LWW by HLC, delete wins, idempotency, merges (spec 7.3).
begin;
create extension if not exists pgtap with schema extensions;
select plan(47);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex owns household A; Sam owns household S, which has one list.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated');

insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sam''s household');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner', 1);
insert into public.lists (id, household_id, name, position) values
  ('b1000000-0000-7000-8000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sam''s groceries', 1);

-- As Alex -----------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

-- Creating rows
select is(
  public.apply_mutations($$ [
    { "table": "lists", "id": "a1000000-0000-7000-8000-000000000001", "hlc": "1760000000000-0000-alex",
      "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Groceries", "position": 1, "created_at": "2026-01-01T00:00:00Z" } },
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000000-0001-alex",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "banana", "display_name": "Bananas" } }
  ] $$),
  '[{"status": "applied"}, {"status": "applied"}]'::jsonb,
  'a batch that creates a list and an item reports both applied');
select results_eq($$ select name, created_at, field_clock from public.lists $$,
  $$ values ('Groceries', '2026-01-01T00:00:00Z'::timestamptz, '{"household_id": "1760000000000-0000-alex", "name": "1760000000000-0000-alex", "position": "1760000000000-0000-alex", "created_at": "1760000000000-0000-alex"}'::jsonb) $$,
  'the new row keeps the device''s created_at, and every field it set is clocked at the mutation''s hlc');

-- Newer HLC wins per field, older ignored
select is(
  public.apply_mutations($$ [{ "table": "lists", "id": "a1000000-0000-7000-8000-000000000001", "hlc": "1760000000005-0000-sam1", "fields": { "name": "Weekly shop" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'a newer edit is applied');
select is(
  public.apply_mutations($$ [{ "table": "lists", "id": "a1000000-0000-7000-8000-000000000001", "hlc": "1760000000003-0000-alex", "fields": { "name": "Old name", "emoji": "🥦" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'an older edit still applies the fields it is newest for');
select results_eq($$ select name, emoji, field_clock ->> 'name', field_clock ->> 'emoji' from public.lists $$,
  $$ values ('Weekly shop', '🥦', '1760000000005-0000-sam1', '1760000000003-0000-alex') $$,
  'the older name is ignored, its emoji (never set before) is kept');
select is(
  public.apply_mutations($$ [{ "table": "lists", "id": "a1000000-0000-7000-8000-000000000001", "hlc": "1760000000005-0000-alex", "fields": { "name": "Tie" } }] $$),
  '[{"status": "unchanged"}]'::jsonb, 'same wall clock and counter: the larger device id wins, so this one is ignored');
select is(
  public.apply_mutations($$ [{ "table": "lists", "id": "a1000000-0000-7000-8000-000000000001", "hlc": "1760000000005-0001-alex", "fields": { "name": "Counted up" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'a higher counter at the same wall clock is newer');

-- Concurrent check + note edit are both kept
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000010-0000-sam1",
      "fields": { "checked_at": "2026-10-10T10:00:00Z", "checked_by": "11111111-1111-1111-1111-111111111111" } },
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000009-0000-alex",
      "fields": { "note": "ripe ones" } }
  ] $$),
  '[{"status": "applied"}, {"status": "applied"}]'::jsonb, 'a check and an older note edit both apply');
select results_eq($$ select checked_at, note from public.list_items where id = 'a2000000-0000-7000-8000-000000000001' $$,
  $$ values ('2026-10-10T10:00:00Z'::timestamptz, 'ripe ones') $$, 'the item is checked and has the note');

-- Delete wins over edit; undo clears deleted_at
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000020-0000-alex", "fields": { "deleted_at": "2026-10-10T11:00:00Z" } },
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000025-0000-sam1", "fields": { "note": "big ones", "checked_at": null } }
  ] $$),
  '[{"status": "applied"}, {"status": "applied"}]'::jsonb, 'a delete and a newer edit both apply');
select results_eq($$ select deleted_at, note, checked_at from public.list_items where id = 'a2000000-0000-7000-8000-000000000001' $$,
  $$ values ('2026-10-10T11:00:00Z'::timestamptz, 'big ones', null::timestamptz) $$,
  'the newer edit doesn''t undo the delete');
select is(
  public.apply_mutations($$ [{ "table": "list_items", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000015-0000-sam1", "fields": { "deleted_at": null } }] $$),
  '[{"status": "unchanged"}]'::jsonb, 'an undo older than the delete is ignored');
select is(
  public.apply_mutations($$ [{ "table": "list_items", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000030-0000-alex", "fields": { "deleted_at": null } }] $$),
  '[{"status": "applied"}]'::jsonb, 'a newer undo is applied');
select is((select deleted_at from public.list_items where id = 'a2000000-0000-7000-8000-000000000001'), null,
  'the undo clears deleted_at');

-- A repeated batch is a no-op
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000030-0000-alex", "fields": { "deleted_at": null } },
    { "table": "lists", "id": "a1000000-0000-7000-8000-000000000001", "hlc": "1760000000005-0001-alex", "fields": { "name": "Counted up" } }
  ] $$),
  '[{"status": "unchanged"}, {"status": "unchanged"}]'::jsonb, 're-sending mutations already applied changes nothing');
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000000-0001-alex",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "banana", "display_name": "Bananas" } }
  ] $$),
  '[{"status": "unchanged"}]'::jsonb, 're-sending the insert doesn''t reset the row');
select results_eq($$ select display_name, note, deleted_at from public.list_items where id = 'a2000000-0000-7000-8000-000000000001' $$,
  $$ values ('Bananas', 'big ones', null::timestamptz) $$, 'the item keeps its later edits');

-- Counters add up once per hlc; unit usage last_used_at takes the later time
select is(
  public.apply_mutations($$ [
    { "table": "ingredient_usage", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "banana" }, "hlc": "1760000000040-0000-alex",
      "fields": { "display_name": "Bananas", "last_used_at": "2026-10-10T12:00:00Z" }, "counters": { "use_count": 1 } },
    { "table": "ingredient_usage", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "banana" }, "hlc": "1760000000041-0000-sam1",
      "fields": { "display_name": "banana" }, "counters": { "use_count": 2 } },
    { "table": "ingredient_usage", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "banana" }, "hlc": "1760000000040-0000-alex",
      "fields": { "display_name": "Bananas", "last_used_at": "2026-10-10T12:00:00Z" }, "counters": { "use_count": 1 } }
  ] $$),
  '[{"status": "applied"}, {"status": "applied"}, {"status": "unchanged"}]'::jsonb,
  'two devices'' uses apply; the re-sent one doesn''t');
select results_eq($$ select display_name, use_count from public.ingredient_usage $$,
  $$ values ('banana', 3) $$, 'use_count adds both devices'' uses once each; display_name is last-writer-wins');
select is(
  public.apply_mutations($$ [
    { "table": "ingredient_unit_usage", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "banana", "unit_key": "count" }, "hlc": "1760000000050-0000-alex",
      "fields": { "last_used_at": "2026-10-10T12:00:00Z" }, "counters": { "use_count": 1 } },
    { "table": "ingredient_unit_usage", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "banana", "unit_key": "count" }, "hlc": "1760000000051-0000-sam1",
      "fields": { "last_used_at": "2026-10-09T12:00:00Z" }, "counters": { "use_count": -1 } }
  ] $$),
  '[{"status": "applied"}, {"status": "applied"}]'::jsonb, 'unit usage mutations apply');
select results_eq($$ select use_count, last_used_at from public.ingredient_unit_usage $$,
  $$ values (0, '2026-10-10T12:00:00Z'::timestamptz) $$,
  'unit use_count adds deltas; an earlier last_used_at with a newer hlc doesn''t move it back');

-- Duplicate open item merged
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000060-0000-sam1",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "banana", "display_name": "bananas" } },
    { "table": "list_item_contributions", "id": "a3000000-0000-7000-8000-000000000001", "hlc": "1760000000060-0001-sam1",
      "fields": { "list_item_id": "a2000000-0000-7000-8000-000000000002", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "quantity": 6 } }
  ] $$),
  '[{"status": "merged", "merged_into": "a2000000-0000-7000-8000-000000000001"}, {"status": "applied"}]'::jsonb,
  'a second open banana is merged into the first, and its contribution still applies');
select results_eq($$ select deleted_at is not null, merged_into from public.list_items where id = 'a2000000-0000-7000-8000-000000000002' $$,
  $$ values (true, 'a2000000-0000-7000-8000-000000000001'::uuid) $$, 'the incoming item is soft-deleted and marked merged');
select results_eq($$ select list_item_id, quantity from public.list_item_contributions $$,
  $$ values ('a2000000-0000-7000-8000-000000000001'::uuid, 6::numeric) $$,
  'its contribution points at the open item');
select is(
  public.apply_mutations($$ [{ "table": "list_items", "id": "a2000000-0000-7000-8000-000000000002", "hlc": "1760000000070-0000-sam1", "fields": { "deleted_at": null } }] $$),
  '[{"status": "merged", "merged_into": "a2000000-0000-7000-8000-000000000001"}]'::jsonb,
  'reopening the merged item merges it again rather than failing');
select is((select count(*)::int from public.list_items where deleted_at is null and checked_at is null), 1,
  'there is still one open banana');

-- Who added and checked an item is the caller, whatever the client sends
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000003", "hlc": "1760000000072-0000-alex",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "apple", "display_name": "Apples",
                  "added_by": "22222222-2222-2222-2222-222222222222", "checked_by": "22222222-2222-2222-2222-222222222222" } },
    { "table": "list_item_contributions", "id": "a3000000-0000-7000-8000-000000000002", "hlc": "1760000000072-0001-alex",
      "fields": { "list_item_id": "a2000000-0000-7000-8000-000000000003", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "added_by": "22222222-2222-2222-2222-222222222222" } }
  ] $$),
  '[{"status": "applied"}, {"status": "applied"}]'::jsonb, 'an item and an amount sent with another user as adder still apply');
select results_eq(
  $$ select added_by, checked_by, field_clock ? 'added_by', field_clock ? 'checked_by'
     from public.list_items where id = 'a2000000-0000-7000-8000-000000000003' $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid, null::uuid, false, false) $$,
  'the new item was added by the caller, and an open one has no checker');
select is((select added_by from public.list_item_contributions where id = 'a3000000-0000-7000-8000-000000000002'),
  '11111111-1111-1111-1111-111111111111'::uuid, 'the new amount was added by the caller');
select is(
  public.apply_mutations($$ [{ "table": "list_items", "id": "a2000000-0000-7000-8000-000000000003", "hlc": "1760000000073-0000-alex",
    "fields": { "added_by": "22222222-2222-2222-2222-222222222222", "checked_by": "22222222-2222-2222-2222-222222222222" } }] $$),
  '[{"status": "unchanged"}]'::jsonb, 'a write of only who added or checked it changes nothing');
select is(
  public.apply_mutations($$ [{ "table": "list_items", "id": "a2000000-0000-7000-8000-000000000003", "hlc": "1760000000074-0000-alex",
    "fields": { "checked_at": "2026-10-10T13:00:00Z", "checked_by": "22222222-2222-2222-2222-222222222222" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'a check sent with another user as checker applies');
select results_eq(
  $$ select checked_at, checked_by, added_by, field_clock ->> 'checked_by'
     from public.list_items where id = 'a2000000-0000-7000-8000-000000000003' $$,
  $$ values ('2026-10-10T13:00:00Z'::timestamptz, '11111111-1111-1111-1111-111111111111'::uuid,
             '11111111-1111-1111-1111-111111111111'::uuid, '1760000000074-0000-alex') $$,
  'the caller checked it, at the check''s clock, and the adder is unchanged');
-- Whoever checked it first (here set by hand) keeps it when a later check time wins.
reset role;
update public.list_items set checked_by = '22222222-2222-2222-2222-222222222222' where id = 'a2000000-0000-7000-8000-000000000003';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is(
  public.apply_mutations($$ [{ "table": "list_items", "id": "a2000000-0000-7000-8000-000000000003", "hlc": "1760000000075-0000-alex",
    "fields": { "checked_at": "2026-10-10T13:05:00Z", "checked_by": "11111111-1111-1111-1111-111111111111" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'a later check time over a check applies');
select results_eq(
  $$ select checked_at, checked_by, field_clock ->> 'checked_by' from public.list_items where id = 'a2000000-0000-7000-8000-000000000003' $$,
  $$ values ('2026-10-10T13:05:00Z'::timestamptz, '22222222-2222-2222-2222-222222222222'::uuid, '1760000000075-0000-alex') $$,
  'a re-check keeps the checker, with checked_at''s clock');
select is(
  public.apply_mutations($$ [{ "table": "list_items", "id": "a2000000-0000-7000-8000-000000000003", "hlc": "1760000000076-0000-alex",
    "fields": { "checked_at": null, "checked_by": "22222222-2222-2222-2222-222222222222" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'an uncheck applies');
select results_eq(
  $$ select checked_at, checked_by, field_clock ->> 'checked_by' from public.list_items where id = 'a2000000-0000-7000-8000-000000000003' $$,
  $$ values (null::timestamptz, null::uuid, '1760000000076-0000-alex') $$,
  'an unchecked item has no checker, whatever the client sends');
select is(
  public.apply_mutations($$ [{ "table": "list_items", "id": "a2000000-0000-7000-8000-000000000004", "hlc": "1760000000077-0000-alex",
    "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "pear", "display_name": "Pears",
                "checked_at": "2026-10-10T13:10:00Z", "checked_by": "22222222-2222-2222-2222-222222222222", "added_by": null } }] $$),
  '[{"status": "applied"}]'::jsonb, 'an item inserted checked applies');
select results_eq(
  $$ select added_by, checked_by from public.list_items where id = 'a2000000-0000-7000-8000-000000000004' $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid, '11111111-1111-1111-1111-111111111111'::uuid) $$,
  'an item inserted checked was added and checked by the caller');

-- Non-member rejected, without blocking the rest of the batch
select is(
  public.apply_mutations($$ [
    { "table": "lists", "id": "b1000000-0000-7000-8000-000000000001", "hlc": "1760000000080-0000-alex", "fields": { "name": "Mine now" } },
    { "table": "lists", "id": "a1000000-0000-7000-8000-000000000002", "hlc": "1760000000080-0001-alex",
      "fields": { "household_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "name": "Sneaky", "position": 2 } },
    { "table": "lists", "id": "a1000000-0000-7000-8000-000000000001", "hlc": "1760000000080-0002-alex", "fields": { "position": 5 } }
  ] $$),
  jsonb_build_array(
    '{"status": "rejected", "code": "42501", "message": "not a member of household bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}'::jsonb,
    '{"status": "rejected", "code": "42501", "message": "not a member of household bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}'::jsonb,
    '{"status": "applied"}'::jsonb),
  'edits to and inserts into another household are rejected; the next mutation still applies');
select results_eq($$ select name from public.lists where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' $$,
  $$ select null::text where false $$, 'Alex still can''t see Sam''s list');

-- Invalid mutations
select is(
  (select jsonb_agg(r ->> 'code') from jsonb_array_elements(public.apply_mutations($$ [
    { "table": "households", "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "hlc": "1760000000090-0000-alex", "fields": { "name": "x" } },
    { "table": "lists", "id": "a1000000-0000-7000-8000-000000000001", "hlc": "yesterday", "fields": { "name": "x" } },
    { "table": "lists", "id": "a1000000-0000-7000-8000-000000000001", "hlc": "1760000000090-0001-alex", "fields": { "updated_at": "2020-01-01T00:00:00Z" } },
    { "table": "lists", "id": "a1000000-0000-7000-8000-000000000001", "hlc": "1760000000090-0002-alex", "fields": { "field_clock": {} } },
    { "table": "lists", "id": "a1000000-0000-7000-8000-000000000001", "hlc": "1760000000090-0003-alex", "fields": { "household_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" } },
    { "table": "lists", "id": "a1000000-0000-7000-8000-000000000001", "hlc": "1760000000090-0004-alex", "fields": { "colour": "red" } },
    { "table": "lists", "id": "a1000000-0000-7000-8000-000000000001", "hlc": "1760000000090-0005-alex", "counters": { "position": 1 } },
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000090-0006-alex", "fields": { "merged_into": null } },
    { "table": "lists", "hlc": "1760000000090-0007-alex", "fields": { "name": "x" } },
    { "table": "lists", "id": "a1000000-0000-7000-8000-000000000009", "hlc": "1760000000090-0008-alex", "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "No position" } }
  ] $$)) r),
  '["22023", "22023", "22023", "22023", "22023", "22023", "22023", "22023", "22023", "23502"]'::jsonb,
  'unknown tables, bad hlcs, server-owned fields, household moves, unknown fields, bad counters, missing ids and missing columns are rejected');
select results_eq($$ select name, position from public.lists $$,
  $$ values ('Counted up', 5::double precision) $$, 'rejected mutations change nothing');
select throws_ok($$ select public.apply_mutations('{"table": "lists"}') $$,
  '22023', 'mutations must be an array', 'a batch must be an array');

-- Direct writes are revoked
select throws_ok($$ insert into public.lists (id, household_id, name, position) values ('a1000000-0000-7000-8000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Direct', 3) $$,
  '42501', null, 'lists can''t be inserted directly');
select throws_ok($$ update public.list_items set note = 'direct' $$,
  '42501', null, 'list items can''t be updated directly');
select throws_ok($$ delete from public.ingredient_usage $$,
  '42501', null, 'ingredient usage can''t be deleted directly');

-- Anonymous callers can't apply mutations
reset role;
set local role anon;
select throws_ok($$ select public.apply_mutations('[]') $$,
  '42501', null, 'anon can''t call apply_mutations');

select * from finish();
rollback;
