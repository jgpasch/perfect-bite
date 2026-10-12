-- Household aisles (spec 4.3.2, 5, 7): overrides and custom aisles belong to a household, are
-- written through apply_mutations with field-level LWW, and only members see them.
begin;
create extension if not exists pgtap with schema extensions;
select plan(43);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex owns household A, which Jamie is also in. Sam owns household S, which has a custom
-- aisle and an override for banana.
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
insert into public.categories (id, name, household_id) values
  ('cccccccc-0000-7000-8000-00000000000b', 'Sam''s aisle', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
insert into public.household_category_overrides (household_id, ingredient_name, category_id) values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'banana', 'cccccccc-0000-7000-8000-00000000000b');

-- As Alex -----------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

-- Custom aisles
select is(
  public.apply_mutations($$ [{ "table": "categories", "id": "cccccccc-0000-7000-8000-00000000000a", "hlc": "1760000000000-0000-alex",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Costco run", "created_at": "2026-01-01T00:00:00Z" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'a member creates a custom aisle in their household');
select results_eq(
  $$ select name, household_id, slug, created_at, field_clock from public.categories where id = 'cccccccc-0000-7000-8000-00000000000a' $$,
  $$ values ('Costco run', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, null::text, '2026-01-01T00:00:00Z'::timestamptz,
    '{"household_id": "1760000000000-0000-alex", "name": "1760000000000-0000-alex", "created_at": "1760000000000-0000-alex"}'::jsonb) $$,
  'the aisle belongs to the household, with no slug, the device''s created_at and every field clocked');
select is(
  public.apply_mutations($$ [{ "table": "categories", "id": "cccccccc-0000-7000-8000-00000000000a", "hlc": "1760000000005-0000-alex", "fields": { "name": "Bulk" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'a newer rename is applied');
select is(
  public.apply_mutations($$ [{ "table": "categories", "id": "cccccccc-0000-7000-8000-00000000000a", "hlc": "1760000000003-0000-jami", "fields": { "name": "Old name" } }] $$),
  '[{"status": "unchanged"}]'::jsonb, 'an older rename is ignored');
select results_eq($$ select name, field_clock ->> 'name' from public.categories where id = 'cccccccc-0000-7000-8000-00000000000a' $$,
  $$ values ('Bulk', '1760000000005-0000-alex') $$, 'the newer name stands');

select is(
  public.apply_mutations($$ [{ "table": "categories", "id": "cccccccc-0000-7000-8000-00000000000c", "hlc": "1760000000006-0000-alex",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Fake", "slug": "fake" } }] $$) -> 0 ->> 'code',
  '22023', 'a custom aisle can''t set a slug');
select is(
  public.apply_mutations($$ [{ "table": "categories", "id": "cccccccc-0000-7000-8000-00000000000a", "hlc": "1760000000006-0000-alex", "fields": { "default_rank": 3 } }] $$) -> 0 ->> 'code',
  '22023', 'a custom aisle can''t set a default rank');
select is(
  public.apply_mutations($$ [{ "table": "categories", "id": "019a4c10-0000-7000-8000-00000000ca01", "hlc": "1760000000006-0000-alex",
    "fields": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "name": "Hacked" } }] $$) -> 0 ->> 'code',
  '42501', 'a system category can''t be renamed or claimed by a household');
select is(
  public.apply_mutations($$ [{ "table": "categories", "id": "cccccccc-0000-7000-8000-00000000000a", "hlc": "1760000000006-0000-alex",
    "fields": { "household_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" } }] $$) -> 0 ->> 'code',
  '22023', 'an aisle can''t move to another household');
select is(
  public.apply_mutations($$ [{ "table": "categories", "id": "cccccccc-0000-7000-8000-00000000000d", "hlc": "1760000000006-0000-alex",
    "fields": { "household_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "name": "Sneaky" } }] $$) -> 0 ->> 'code',
  '42501', 'a non-member can''t create an aisle in another household');
select is(
  public.apply_mutations($$ [{ "table": "categories", "id": "cccccccc-0000-7000-8000-00000000000b", "hlc": "1760000000006-0000-alex", "fields": { "name": "Mine now" } }] $$) -> 0 ->> 'code',
  '42501', 'a non-member can''t rename another household''s aisle');
select results_eq($$ select name from public.categories where household_id is not null $$,
  $$ values ('Bulk') $$, 'Alex sees their household''s custom aisle and not Sam''s');
select throws_ok($$ update public.categories set name = 'Direct' where id = 'cccccccc-0000-7000-8000-00000000000a' $$,
  '42501', null, 'custom aisles aren''t written directly');

-- Overrides
select is(
  public.apply_mutations($$ [
    { "table": "household_category_overrides", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "banana" },
      "hlc": "1760000000010-0000-alex", "fields": { "category_id": "cccccccc-0000-7000-8000-00000000000a" } },
    { "table": "household_category_overrides", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "milk" },
      "hlc": "1760000000010-0001-alex", "fields": { "category_id": "019a4c10-0000-7000-8000-00000000ca01" } }
  ] $$),
  '[{"status": "applied"}, {"status": "applied"}]'::jsonb,
  'a member moves ingredients to their household''s custom aisle and to a system aisle');
select results_eq(
  $$ select ingredient_name, category_id, field_clock from public.household_category_overrides order by ingredient_name $$,
  $$ values
    ('banana', 'cccccccc-0000-7000-8000-00000000000a'::uuid, '{"category_id": "1760000000010-0000-alex"}'::jsonb),
    ('milk', '019a4c10-0000-7000-8000-00000000ca01'::uuid, '{"category_id": "1760000000010-0001-alex"}'::jsonb) $$,
  'Alex sees their household''s overrides only, not Sam''s banana');

select is(
  public.apply_mutations($$ [{ "table": "household_category_overrides", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "banana" },
    "hlc": "1760000000020-0000-jami", "fields": { "category_id": "019a4c10-0000-7000-8000-00000000ca02" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'a later change to the aisle wins');
select is(
  public.apply_mutations($$ [{ "table": "household_category_overrides", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "banana" },
    "hlc": "1760000000015-0000-alex", "fields": { "category_id": "019a4c10-0000-7000-8000-00000000ca01" } }] $$),
  '[{"status": "unchanged"}]'::jsonb, 'an earlier change is ignored');
select results_eq($$ select category_id from public.household_category_overrides where ingredient_name = 'banana' $$,
  $$ values ('019a4c10-0000-7000-8000-00000000ca02'::uuid) $$, 'banana is in the later change''s aisle');

select is(
  public.apply_mutations($$ [{ "table": "household_category_overrides", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "banana" },
    "hlc": "1760000000030-0000-alex", "fields": { "category_id": null } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Reset to default is a newer change to null');
select results_eq($$ select category_id, field_clock ->> 'category_id' from public.household_category_overrides where ingredient_name = 'banana' $$,
  $$ values (null::uuid, '1760000000030-0000-alex') $$, 'the reset keeps the row, with its clock, so the default applies');
select is(
  public.apply_mutations($$ [{ "table": "household_category_overrides", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "banana" },
    "hlc": "1760000000025-0000-jami", "fields": { "category_id": "019a4c10-0000-7000-8000-00000000ca03" } }] $$),
  '[{"status": "unchanged"}]'::jsonb, 'a move older than the reset doesn''t undo it');
select is(
  public.apply_mutations($$ [{ "table": "household_category_overrides", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "banana" },
    "hlc": "1760000000035-0000-jami", "fields": { "category_id": "019a4c10-0000-7000-8000-00000000ca03" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'a move after the reset wins');
select is(
  public.apply_mutations($$ [{ "table": "household_category_overrides", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "lemon" },
    "hlc": "1760000000036-0000-alex", "fields": { "category_id": null } }] $$),
  '[{"status": "applied"}]'::jsonb, 'resetting an ingredient with no override yet writes a null row');

select is(
  public.apply_mutations($$ [{ "table": "household_category_overrides", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "milk" },
    "hlc": "1760000000040-0000-alex", "fields": { "category_id": "cccccccc-0000-7000-8000-00000000000b" } }] $$) -> 0 ->> 'code',
  '22023', 'another household''s custom aisle is rejected');
select is(
  public.apply_mutations($$ [{ "table": "household_category_overrides", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "milk" },
    "hlc": "1760000000040-0000-alex", "fields": { "category_id": "cccccccc-0000-7000-8000-0000000000ff" } }] $$) -> 0 ->> 'code',
  '22023', 'an unknown category is rejected');
select is(
  public.apply_mutations($$ [{ "table": "household_category_overrides", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "milk" },
    "hlc": "1760000000040-0000-alex", "fields": { "created_at": "2026-01-01T00:00:00Z" } }] $$) -> 0 ->> 'code',
  '22023', 'category_id is the only field an override sets');
select is(
  public.apply_mutations($$ [{ "table": "household_category_overrides", "key": { "household_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "ingredient_name": "banana" },
    "hlc": "1760000000040-0000-alex", "fields": { "category_id": "019a4c10-0000-7000-8000-00000000ca01" } }] $$) -> 0 ->> 'code',
  '42501', 'a non-member can''t write another household''s override');
select results_eq($$ select category_id from public.household_category_overrides where ingredient_name = 'milk' $$,
  $$ values ('019a4c10-0000-7000-8000-00000000ca01'::uuid) $$, 'rejected changes leave milk where it was');
select throws_ok($$ insert into public.household_category_overrides (household_id, ingredient_name, category_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'egg', '019a4c10-0000-7000-8000-00000000ca01') $$,
  '42501', null, 'overrides aren''t written directly');

-- As Jamie, the other member of A ------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);

select results_eq(
  $$ select ingredient_name, category_id from public.household_category_overrides order by ingredient_name $$,
  $$ values ('banana', '019a4c10-0000-7000-8000-00000000ca03'::uuid), ('lemon', null::uuid), ('milk', '019a4c10-0000-7000-8000-00000000ca01'::uuid) $$,
  'every member sees the household''s overrides');
select results_eq($$ select name from public.categories where household_id is not null $$,
  $$ values ('Bulk') $$, 'every member has the household''s custom aisle');
select is(
  public.apply_mutations($$ [{ "table": "categories", "id": "cccccccc-0000-7000-8000-00000000000a", "hlc": "1760000000050-0000-jami", "fields": { "name": "Warehouse" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'another member renames the household''s aisle');

-- As Sam, in another household ---------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);

select results_eq(
  $$ select household_id, ingredient_name, category_id from public.household_category_overrides $$,
  $$ values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 'banana', 'cccccccc-0000-7000-8000-00000000000b'::uuid) $$,
  'Sam sees only their own household''s banana override');
select results_eq($$ select name from public.categories where household_id is not null $$,
  $$ values ('Sam''s aisle') $$, 'Sam doesn''t see household A''s custom aisle');
select is((select count(*)::int from public.categories where household_id is null), 20,
  'system categories are readable by everyone');
select is(
  public.apply_mutations($$ [{ "table": "household_category_overrides", "key": { "household_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "ingredient_name": "milk" },
    "hlc": "1760000000060-0000-sam1", "fields": { "category_id": "cccccccc-0000-7000-8000-00000000000a" } }] $$) -> 0 ->> 'code',
  '22023', 'Sam can''t point an override at household A''s aisle');

-- Leaving A: Jamie's membership is removed (as postgres) -----------------------------
reset role;
delete from public.household_members
where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and user_id = '33333333-3333-3333-3333-333333333333';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);

select is_empty($$ select 1 from public.household_category_overrides $$, 'after leaving, Jamie can''t read the household''s overrides');
select is_empty($$ select 1 from public.categories where household_id is not null $$, 'after leaving, Jamie loses its custom aisles');
select is(
  public.apply_mutations($$ [{ "table": "household_category_overrides", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "milk" },
    "hlc": "1760000000070-0000-jami", "fields": { "category_id": "019a4c10-0000-7000-8000-00000000ca02" } }] $$) -> 0 ->> 'code',
  '42501', 'after leaving, Jamie can''t change its overrides');
select is(
  public.apply_mutations($$ [{ "table": "categories", "id": "cccccccc-0000-7000-8000-00000000000a", "hlc": "1760000000070-0000-jami", "fields": { "name": "Gone" } }] $$) -> 0 ->> 'code',
  '42501', 'after leaving, Jamie can''t rename its aisles');

-- Cascades (as postgres) ---------------------------------------------------------------
reset role;
select results_eq($$ select name from public.categories where id = 'cccccccc-0000-7000-8000-00000000000a' $$,
  $$ values ('Warehouse') $$, 'the rejected rename after leaving changed nothing');
insert into public.household_category_overrides (household_id, ingredient_name, category_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'egg', 'cccccccc-0000-7000-8000-00000000000a');
delete from public.categories where id = 'cccccccc-0000-7000-8000-00000000000a';
select is_empty($$ select 1 from public.household_category_overrides where ingredient_name = 'egg' $$,
  'deleting a custom aisle deletes the overrides that point at it');
delete from public.households where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
select is_empty(
  $$ select 1 from public.categories where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
     union all select 1 from public.household_category_overrides where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' $$,
  'deleting a household deletes its custom aisles and overrides');

select * from finish();
rollback;
