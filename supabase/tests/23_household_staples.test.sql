-- Household staples ("Always have"): written through apply_mutations with field-level LWW on
-- deleted_at, created_by set by the server, and only members see them.
begin;
create extension if not exists pgtap with schema extensions;
select plan(26);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex owns household A, which Jamie is also in. Sam owns household S, which has salt.
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
insert into public.household_staples (household_id, ingredient_name, created_by) values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'salt', '22222222-2222-2222-2222-222222222222');

-- As Alex -----------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

-- Mark, with a spoofed created_by that's ignored
select is(
  public.apply_mutations($$ [
    { "table": "household_staples", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "salt" },
      "hlc": "1760000000010-0000-alex", "fields": { "deleted_at": null, "created_by": "33333333-3333-3333-3333-333333333333" } },
    { "table": "household_staples", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "olive oil" },
      "hlc": "1760000000010-0001-alex", "fields": {} }
  ] $$),
  '[{"status": "applied"}, {"status": "applied"}]'::jsonb, 'a member marks salt and olive oil as staples');
select results_eq(
  $$ select ingredient_name, created_by, deleted_at, field_clock from public.household_staples order by ingredient_name $$,
  $$ values
    ('olive oil', '11111111-1111-1111-1111-111111111111'::uuid, null::timestamptz, '{}'::jsonb),
    ('salt', '11111111-1111-1111-1111-111111111111'::uuid, null::timestamptz, '{"deleted_at": "1760000000010-0000-alex"}'::jsonb) $$,
  'Alex sees their household''s staples only, created by Alex whatever the client sent');

-- Unmark
select is(
  public.apply_mutations($$ [{ "table": "household_staples", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "salt" },
    "hlc": "1760000000020-0000-alex", "fields": { "deleted_at": "2026-10-13T10:00:00Z" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'a member unmarks salt');
select results_eq($$ select deleted_at, field_clock ->> 'deleted_at' from public.household_staples where ingredient_name = 'salt' $$,
  $$ values ('2026-10-13T10:00:00Z'::timestamptz, '1760000000020-0000-alex') $$, 'unmarking sets deleted_at and keeps the row');

-- An older HLC loses
select is(
  public.apply_mutations($$ [{ "table": "household_staples", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "salt" },
    "hlc": "1760000000015-0000-jami", "fields": { "deleted_at": null } }] $$),
  '[{"status": "unchanged"}]'::jsonb, 'a mark older than the unmark is ignored');
select results_eq($$ select deleted_at from public.household_staples where ingredient_name = 'salt' $$,
  $$ values ('2026-10-13T10:00:00Z'::timestamptz) $$, 'salt stays unmarked');

-- Mark again
select is(
  public.apply_mutations($$ [{ "table": "household_staples", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "salt" },
    "hlc": "1760000000030-0000-alex", "fields": { "deleted_at": null, "created_by": "33333333-3333-3333-3333-333333333333" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'marking again after unmarking is applied');
select results_eq(
  $$ select deleted_at, created_by, field_clock ->> 'deleted_at' from public.household_staples where ingredient_name = 'salt' $$,
  $$ values (null::timestamptz, '11111111-1111-1111-1111-111111111111'::uuid, '1760000000030-0000-alex') $$,
  'mark, unmark and mark again ends marked, and created_by can''t be changed later');
select is(
  public.apply_mutations($$ [{ "table": "household_staples", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "salt" },
    "hlc": "1760000000025-0000-jami", "fields": { "deleted_at": "2026-10-13T09:00:00Z" } }] $$),
  '[{"status": "unchanged"}]'::jsonb, 'an unmark older than the re-mark doesn''t undo it');

-- Rejections
select is(
  public.apply_mutations($$ [{ "table": "household_staples", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "salt" },
    "hlc": "1760000000040-0000-alex", "fields": { "created_at": "2026-01-01T00:00:00Z" } }] $$) -> 0 ->> 'code',
  '22023', 'deleted_at is the only field a staple sets');
select is(
  public.apply_mutations($$ [{ "table": "household_staples", "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "hlc": "1760000000040-0000-alex", "fields": { "deleted_at": null } }] $$) -> 0 ->> 'code',
  '22023', 'a staple is named by its household and ingredient');
select is(
  public.apply_mutations($$ [{ "table": "household_staples", "key": { "household_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "ingredient_name": "salt" },
    "hlc": "1760000000040-0000-alex", "fields": { "deleted_at": "2026-10-13T10:00:00Z" } }] $$) -> 0 ->> 'code',
  '42501', 'a non-member can''t unmark another household''s staple');
select is(
  public.apply_mutations($$ [{ "table": "household_staples", "key": { "household_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "ingredient_name": "pepper" },
    "hlc": "1760000000040-0000-alex", "fields": {} }] $$) -> 0 ->> 'code',
  '42501', 'a non-member can''t mark a staple in another household');
select throws_ok($$ insert into public.household_staples (household_id, ingredient_name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'pepper') $$,
  '42501', null, 'staples aren''t inserted directly');
select throws_ok($$ update public.household_staples set deleted_at = now() where ingredient_name = 'salt' $$,
  '42501', null, 'staples aren''t updated directly');

-- As Jamie, the other member of A ------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);

select results_eq(
  $$ select ingredient_name, deleted_at from public.household_staples order by ingredient_name $$,
  $$ values ('olive oil', null::timestamptz), ('salt', null::timestamptz) $$,
  'every member sees the household''s staples');
select is(
  public.apply_mutations($$ [{ "table": "household_staples", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "olive oil" },
    "hlc": "1760000000050-0000-jami", "fields": { "deleted_at": "2026-10-13T11:00:00Z" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'another member unmarks olive oil');
select results_eq($$ select created_by from public.household_staples where ingredient_name = 'olive oil' $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid) $$, 'unmarking leaves created_by as the member who marked it');

-- As Sam, in another household ---------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);

select results_eq(
  $$ select household_id, ingredient_name from public.household_staples $$,
  $$ values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 'salt') $$,
  'Sam sees only their own household''s staples');
select is(
  public.apply_mutations($$ [{ "table": "household_staples", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "salt" },
    "hlc": "1760000000060-0000-sam1", "fields": { "deleted_at": "2026-10-13T12:00:00Z" } }] $$) -> 0 ->> 'code',
  '42501', 'Sam can''t unmark household A''s staple');

-- Jamie leaves A -----------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
do $$ begin perform public.leave_household('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); end $$;

select is_empty($$ select 1 from public.household_staples where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' $$,
  'after leaving, Jamie can''t read the household''s staples');
select is(
  public.apply_mutations($$ [{ "table": "household_staples", "key": { "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "salt" },
    "hlc": "1760000000070-0000-jami", "fields": { "deleted_at": "2026-10-13T13:00:00Z" } }] $$) -> 0 ->> 'code',
  '42501', 'after leaving, Jamie can''t change its staples');

-- Cascades (as postgres) ---------------------------------------------------------------
reset role;
select results_eq(
  $$ select ingredient_name, deleted_at from public.household_staples where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' order by ingredient_name $$,
  $$ values ('olive oil', '2026-10-13T11:00:00Z'::timestamptz), ('salt', null::timestamptz) $$,
  'rejected changes left household A''s staples as they were');

delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
select results_eq(
  $$ select ingredient_name, created_by from public.household_staples where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' order by ingredient_name $$,
  $$ values ('olive oil', null::uuid), ('salt', null::uuid) $$,
  'deleting the user who marked a staple keeps it, with no created_by');

-- Sam deletes household S
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
do $$ begin perform public.delete_household('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'); end $$;
reset role;
select is_empty($$ select 1 from public.household_staples where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' $$,
  'deleting a household deletes its staples');
select results_eq($$ select count(*)::int from public.household_staples $$, $$ values (2) $$,
  'other households'' staples are untouched');

select * from finish();
rollback;
