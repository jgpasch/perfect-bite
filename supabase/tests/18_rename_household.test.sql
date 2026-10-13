-- rename_household (spec 4.7, 5): owners rename, the name is trimmed and checked.
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex owns S, which Pat joined as a plain member. Sam owns T and isn't in S.
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated'),
  ('44444444-4444-4444-4444-444444444444', 'pat@test.local', 'authenticated', 'authenticated');

insert into public.households (id, name, updated_at) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Shared', '2026-01-01'),
  ('aaaaaaaa-0000-0000-0000-00000000000d', 'Sam''s household', '2026-01-01');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '44444444-4444-4444-4444-444444444444', 'member', 1),
  ('aaaaaaaa-0000-0000-0000-00000000000d', '22222222-2222-2222-2222-222222222222', 'owner', 1);

-- Access ------------------------------------------------------------------------
select ok(has_function_privilege('authenticated', 'public.rename_household(uuid, text)', 'execute'),
  'signed-in users can call rename_household');
select ok(
  not has_function_privilege('anon', 'public.rename_household(uuid, text)', 'execute')
  and not has_function_privilege('public', 'public.rename_household(uuid, text)', 'execute'),
  'anon and public can''t call rename_household');

-- The same name changes nothing ---------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select lives_ok($$ select public.rename_household('aaaaaaaa-0000-0000-0000-00000000000a', '  Shared ') $$,
  'renaming to the same name (after trimming) succeeds');
select results_eq($$ select name, updated_at from public.households where id = 'aaaaaaaa-0000-0000-0000-00000000000a' $$,
  $$ values ('Shared'::text, '2026-01-01'::timestamptz) $$,
  'and leaves the name and updated_at as they were');

-- An owner renames ------------------------------------------------------------------
select lives_ok($$ select public.rename_household('aaaaaaaa-0000-0000-0000-00000000000a', '  Smith home  ') $$,
  'the owner renames the household');
select results_eq($$ select name from public.households where id = 'aaaaaaaa-0000-0000-0000-00000000000a' $$,
  $$ values ('Smith home') $$, 'the new name is stored trimmed');
select ok((select updated_at > '2026-01-01' from public.households where id = 'aaaaaaaa-0000-0000-0000-00000000000a'),
  'updated_at is bumped, so pulls carry the change');

select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
select results_eq($$ select name from public.households where id = 'aaaaaaaa-0000-0000-0000-00000000000a' $$,
  $$ values ('Smith home') $$, 'another member reads the new name');

-- Name rules ----------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select public.rename_household('aaaaaaaa-0000-0000-0000-00000000000a', '   ') $$,
  '22023', 'household name cannot be blank', 'a blank name raises');
select throws_ok($$ select public.rename_household('aaaaaaaa-0000-0000-0000-00000000000a', '') $$,
  '22023', 'household name cannot be blank', 'an empty name raises');
select throws_ok($$ select public.rename_household('aaaaaaaa-0000-0000-0000-00000000000a', null) $$,
  '22023', 'household name cannot be blank', 'a null name raises');
select throws_ok($$ select public.rename_household('aaaaaaaa-0000-0000-0000-00000000000a', repeat('a', 51)) $$,
  '22023', 'household name is too long', 'a 51-character name raises');
select lives_ok($$ select public.rename_household('aaaaaaaa-0000-0000-0000-00000000000a', '  ' || repeat('b', 50) || '  ') $$,
  'a 50-character name (spaces around it don''t count) is fine');
select results_eq($$ select name from public.households where id = 'aaaaaaaa-0000-0000-0000-00000000000a' $$,
  $$ values (repeat('b', 50)) $$, 'and is stored trimmed');

-- Who can't rename ----------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
select throws_ok($$ select public.rename_household('aaaaaaaa-0000-0000-0000-00000000000a', 'Pat''s now') $$,
  '42501', 'not an owner', 'a plain member can''t rename');

select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select throws_ok($$ select public.rename_household('aaaaaaaa-0000-0000-0000-00000000000a', 'Sam''s now') $$,
  '42501', 'not a member', 'a non-member can''t rename');
select throws_ok($$ select public.rename_household('aaaaaaaa-0000-0000-0000-0000000000ff', 'Ghost') $$,
  '42501', 'not a member', 'renaming a household that doesn''t exist raises not a member');
select throws_ok($$ select public.rename_household('aaaaaaaa-0000-0000-0000-00000000000a', '   ') $$,
  '42501', 'not a member', 'membership is checked before the name');

select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.rename_household('aaaaaaaa-0000-0000-0000-00000000000a', 'Nobody''s') $$,
  '42501', 'not authenticated', 'renaming needs a signed-in user');

reset role;
select results_eq($$ select id, name from public.households where id::text like 'aaaaaaaa-%' order by id $$,
  $$ values ('aaaaaaaa-0000-0000-0000-00000000000a'::uuid, repeat('b', 50)), ('aaaaaaaa-0000-0000-0000-00000000000d'::uuid, 'Sam''s household') $$,
  'the refused calls changed no names');

select * from finish();
rollback;
