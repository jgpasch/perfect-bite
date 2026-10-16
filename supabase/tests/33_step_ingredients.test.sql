-- recipes.step_ingredients (spec 4.5, 5, 7.1).
begin;
create extension if not exists pgtap with schema extensions;
select plan(33);

-- Fixtures (as postgres) ------------------------------------------------------
-- Alex and Jo share household A, which has one recipe from before this migration. Sam owns
-- household S.
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
insert into public.recipes (id, household_id, name) values
  ('a2000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Old soup');

-- Sets the old recipe's match (as the current role).
create function pg_temp.set_match(p_value jsonb) returns void language sql as $$
  update public.recipes set step_ingredients = p_value where id = 'a2000000-0000-7000-8000-000000000001'
$$;

-- The column ----------------------------------------------------------------------
select col_type_is('public', 'recipes', 'step_ingredients', 'jsonb', 'step_ingredients is jsonb');
select is(
  (select step_ingredients from public.recipes where id = 'a2000000-0000-7000-8000-000000000001'),
  null, 'an existing recipe is unmatched');

-- The shape check ------------------------------------------------------------------
select lives_ok(
  $$ select pg_temp.set_match('{"v": 1, "basis": "0a1b2c3d4e5f60", "steps": [[{"id": "i1", "quantity": null}], []]}');
     select pg_temp.set_match('{"v": 1, "basis": "b", "steps": [[{"id": "i1", "quantity": 1.5}, {"id": "i2", "quantity": null}]]}');
     select pg_temp.set_match('{"steps": [[]], "basis": "b", "v": 2}');
     select pg_temp.set_match(null) $$,
  'a match with shares, an empty step, any key order, a later version and null are accepted');
select lives_ok(
  $$ select pg_temp.set_match(jsonb_build_object('v', 1, 'basis', repeat('b', 64), 'steps',
       (select jsonb_agg(u) from generate_series(1, 100),
          lateral (select jsonb_agg(jsonb_build_object('id', 'i' || j, 'quantity', null)) u
                   from generate_series(1, 80) j) x))) $$,
  '100 steps of 80 ids each and a 64-character basis are accepted');

select throws_ok($$ select pg_temp.set_match('[]') $$, '23514', null, 'an array is refused');
select throws_ok($$ select pg_temp.set_match('"match"') $$, '23514', null, 'a string is refused');
select throws_ok($$ select pg_temp.set_match('{"basis": "b", "steps": [[]]}') $$,
  '23514', null, 'a match without v is refused');
select throws_ok($$ select pg_temp.set_match('{"v": "1", "basis": "b", "steps": [[]]}') $$,
  '23514', null, 'a string v is refused');
select throws_ok($$ select pg_temp.set_match('{"v": 0, "basis": "b", "steps": [[]]}') $$,
  '23514', null, 'v 0 is refused');
select throws_ok($$ select pg_temp.set_match('{"v": 1, "steps": [[]]}') $$,
  '23514', null, 'a match without basis is refused');
select throws_ok($$ select pg_temp.set_match('{"v": 1, "basis": "", "steps": [[]]}') $$,
  '23514', null, 'an empty basis is refused');
select throws_ok($$ select pg_temp.set_match(jsonb_build_object('v', 1, 'basis', repeat('b', 65), 'steps', '[[]]'::jsonb)) $$,
  '23514', null, 'a basis over 64 characters is refused');
select throws_ok($$ select pg_temp.set_match('{"v": 1, "basis": "b"}') $$,
  '23514', null, 'a match without steps is refused');
select throws_ok($$ select pg_temp.set_match('{"v": 1, "basis": "b", "steps": []}') $$,
  '23514', null, 'no steps are refused (null means never matched)');
select throws_ok($$ select pg_temp.set_match('{"v": 1, "basis": "b", "steps": {"1": []}}') $$,
  '23514', null, 'steps that aren''t an array are refused');
select throws_ok(
  $$ select pg_temp.set_match(jsonb_build_object('v', 1, 'basis', 'b', 'steps',
       (select jsonb_agg('[]'::jsonb) from generate_series(1, 101)))) $$,
  '23514', null, '101 steps are refused');
select throws_ok($$ select pg_temp.set_match('{"v": 1, "basis": "b", "steps": [[], "i1"]}') $$,
  '23514', null, 'a step that isn''t an array is refused');
select throws_ok(
  $$ select pg_temp.set_match(jsonb_build_object('v', 1, 'basis', 'b', 'steps', jsonb_build_array(
       (select jsonb_agg(jsonb_build_object('id', 'i' || j, 'quantity', null)) from generate_series(1, 81) j)))) $$,
  '23514', null, '81 ids in a step are refused');
select throws_ok($$ select pg_temp.set_match('{"v": 1, "basis": "b", "steps": [["i1"]]}') $$,
  '23514', null, 'a bare id is refused');
select throws_ok($$ select pg_temp.set_match('{"v": 1, "basis": "b", "steps": [[{"quantity": null}]]}') $$,
  '23514', null, 'a use without an id is refused');
select throws_ok($$ select pg_temp.set_match('{"v": 1, "basis": "b", "steps": [[{"id": 7, "quantity": null}]]}') $$,
  '23514', null, 'a number id is refused');
select throws_ok($$ select pg_temp.set_match('{"v": 1, "basis": "b", "steps": [[{"id": "", "quantity": null}]]}') $$,
  '23514', null, 'an empty id is refused');
select throws_ok($$ select pg_temp.set_match('{"v": 1, "basis": "b", "steps": [[{"id": "i1"}]]}') $$,
  '23514', null, 'a use without a quantity is refused');
select throws_ok($$ select pg_temp.set_match('{"v": 1, "basis": "b", "steps": [[{"id": "i1", "quantity": "1"}]]}') $$,
  '23514', null, 'a string quantity is refused');
select throws_ok($$ select pg_temp.set_match('{"v": 1, "basis": "b", "steps": [[{"id": "i1", "quantity": 0}]]}') $$,
  '23514', null, 'a zero share is refused');

-- As Alex (a member) --------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000005-0000-alex",
    "fields": { "step_ingredients": { "v": 1, "basis": "alex", "steps": [[{ "id": "i1", "quantity": 1 }]] } } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Alex saves a match');
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000006-0000-alex",
    "fields": { "step_ingredients": { "v": 1, "basis": "bad", "steps": [] } } }] $$),
  '[{"status": "rejected", "code": "23514", "message": "new row for relation \"recipes\" violates check constraint \"recipes_step_ingredients_shape\""}]'::jsonb,
  'a bad match is rejected through apply_mutations');

-- As Jo: last-writer-wins on the whole value. An older match loses, a newer one replaces it.
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);

select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000003-0000-jo",
    "fields": { "step_ingredients": { "v": 1, "basis": "jo-old", "steps": [[]] } } }] $$),
  '[{"status": "unchanged"}]'::jsonb, 'Jo''s older match loses');
select is(
  (select step_ingredients ->> 'basis' from public.recipes where id = 'a2000000-0000-7000-8000-000000000001'),
  'alex', 'Alex''s match stays');
select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000007-0000-jo",
    "fields": { "step_ingredients": { "v": 1, "basis": "jo", "steps": [[], [{ "id": "i2", "quantity": null }]] } } }] $$),
  '[{"status": "applied"}]'::jsonb, 'Jo''s newer match applies');
select results_eq(
  $$ select step_ingredients, field_clock ->> 'step_ingredients'
     from public.recipes where id = 'a2000000-0000-7000-8000-000000000001' $$,
  $$ values ('{"v": 1, "basis": "jo", "steps": [[], [{"id": "i2", "quantity": null}]]}'::jsonb, '1760000000007-0000-jo') $$,
  'the whole value is replaced, with its clock');

-- As Sam (another household) ------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);

select is(
  public.apply_mutations($$ [{ "table": "recipes", "id": "a2000000-0000-7000-8000-000000000001", "hlc": "1760000000009-0000-sam",
    "fields": { "step_ingredients": null } }] $$),
  '[{"status": "rejected", "code": "42501", "message": "not a member of household aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}]'::jsonb,
  'Sam can''t set household A''s match');

reset role;
select is(
  (select step_ingredients ->> 'basis' from public.recipes where id = 'a2000000-0000-7000-8000-000000000001'),
  'jo', 'Sam''s write changed nothing');

select * from finish();
rollback;
