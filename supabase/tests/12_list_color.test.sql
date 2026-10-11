-- lists.color: an aisle hue or null, set by household members only (spec 4.1, 7.3).
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex and Jo share household A, which has one list. Sam owns household S.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'jo@test.local', 'authenticated', 'authenticated');

insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sam''s household');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'member', 2),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner', 1);
insert into public.lists (id, household_id, name, position) values
  ('a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Groceries', 1);

-- The column ----------------------------------------------------------------------
select has_column('public', 'lists', 'color', 'lists has a color column');
select col_is_null('public', 'lists', 'color', 'color is nullable (null is Default)');
select is((select color from public.lists), null, 'a list starts as Default');
select throws_ok(
  $$ update public.lists set color = 'purple' $$,
  '23514', null, 'a value that isn''t an aisle hue is rejected by the check constraint');
select lives_ok(
  $$ update public.lists set color = 'grey'; update public.lists set color = null $$,
  'an aisle hue and null are accepted');

-- As Alex (a member) --------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select is(
  public.apply_mutations($$ [{ "table": "lists", "id": "a1000000-0000-7000-8000-000000000001", "hlc": "1760000000001-0000-alex", "fields": { "color": "rose" } }] $$),
  '[{"status": "applied"}]'::jsonb, 'a member sets the colour through apply_mutations');
select is(
  public.apply_mutations($$ [{ "table": "lists", "id": "a1000000-0000-7000-8000-000000000001", "hlc": "1760000000002-0000-alex", "fields": { "color": "purple" } }] $$),
  '[{"status": "rejected", "code": "23514", "message": "new row for relation \"lists\" violates check constraint \"lists_color_check\""}]'::jsonb,
  'a bad colour is rejected through apply_mutations too');
select throws_ok(
  $$ update public.lists set color = 'blue' $$,
  '42501', null, 'the column can''t be updated directly, only through apply_mutations');

-- As Jo (another member of the same household) ------------------------------------
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);

select is((select color from public.lists), 'rose', 'another member sees the colour Alex set');
select is(
  public.apply_mutations($$ [{ "table": "lists", "id": "a1000000-0000-7000-8000-000000000001", "hlc": "1760000000003-0000-jo", "fields": { "color": null } }] $$),
  '[{"status": "applied"}]'::jsonb, 'any member can change it back to Default');

-- As Sam (another household) ------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);

select is(
  public.apply_mutations($$ [{ "table": "lists", "id": "a1000000-0000-7000-8000-000000000001", "hlc": "1760000000009-0000-sam", "fields": { "color": "green" } }] $$),
  '[{"status": "rejected", "code": "42501", "message": "not a member of household aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}]'::jsonb,
  'a member of another household can''t change the colour');

reset role;
select results_eq(
  $$ select color, field_clock ->> 'color' from public.lists $$,
  $$ values (null::text, '1760000000003-0000-jo') $$,
  'only the members'' edits landed: Default, clocked at Jo''s edit');

select * from finish();
rollback;
