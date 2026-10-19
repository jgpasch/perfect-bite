-- Section headings in recipes.steps (spec 4.5 "Step sections", 5).
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

-- Fixtures (as postgres) ------------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alex''s household');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1);
insert into public.recipes (id, household_id, name, steps) values
  ('a2000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Chicken', '["Mix", "Grill"]');

-- Accepted ------------------------------------------------------------------------
select lives_ok(
  $$ update public.recipes set steps = '["Chop", "Stir"]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  'steps without headings are still accepted');
select lives_ok(
  $$ update public.recipes set steps = '[{"section": "Marinate"}, "Mix", {"section": "Grilling", "choice": true}, "Grill", {"section": "Baking", "choice": true}, "Bake"]'
     where id = 'a2000000-0000-7000-8000-000000000001' $$,
  'headings with and without choice are accepted');
select lives_ok(
  $$ update public.recipes set steps = '["Mix", {"section": "Grill"}, "Grill"]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  'steps before the first heading are accepted');
select lives_ok(
  $$ update public.recipes set steps = jsonb_build_array(jsonb_build_object('section', repeat('é', 80)), 'Mix')
     where id = 'a2000000-0000-7000-8000-000000000001' $$,
  'an 80-character name (counted in characters) is accepted');
select lives_ok(
  $$ update public.recipes set steps = (select jsonb_agg(jsonb_build_object('section', 'S' || i)) from generate_series(1, 20) i) || '["Mix"]'::jsonb
     where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '20 headings are accepted');
select lives_ok(
  $$ update public.recipes set steps = (select jsonb_agg(jsonb_build_object('section', 'S' || i)) from generate_series(1, 20) i)
       || (select jsonb_agg('Stir ' || i) from generate_series(1, 80) i)
     where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '100 entries, headings included, are accepted');
select lives_ok(
  $$ update public.recipes set steps = '[{"section": "Trailing"}, "Mix", {"section": "Empty"}]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  'a heading with no step after it is left to cleaning, not the check');

-- Refused ------------------------------------------------------------------------
select throws_ok(
  $$ update public.recipes set steps = '[{"section": "Grill", "choice": false}, "Grill"]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'choice: false is refused');
select throws_ok(
  $$ update public.recipes set steps = '[{"section": "Grill", "choice": "true"}, "Grill"]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'choice as a string is refused');
select throws_ok(
  $$ update public.recipes set steps = '[{"section": "Grill", "choice": null}, "Grill"]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'choice: null is refused');
select throws_ok(
  $$ update public.recipes set steps = '[{"section": "Grill", "note": "x"}, "Grill"]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'an extra key is refused');
select throws_ok(
  $$ update public.recipes set steps = '[{"section": "Grill", "choice": true, "x": 1}, "Grill"]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'an extra key next to choice is refused');
select throws_ok(
  $$ update public.recipes set steps = '[{"choice": true}, "Grill"]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a heading without section is refused');
select throws_ok(
  $$ update public.recipes set steps = '[{}, "Grill"]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'an empty object is refused');
select throws_ok(
  $$ update public.recipes set steps = '[{"section": ""}, "Grill"]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'an empty name is refused');
select throws_ok(
  $$ update public.recipes set steps = jsonb_build_array(jsonb_build_object('section', repeat('a', 81)), 'Mix')
     where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'an 81-character name is refused');
select throws_ok(
  $$ update public.recipes set steps = '[{"section": 3}, "Grill"]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a name that isn''t a string is refused');
select throws_ok(
  $$ update public.recipes set steps = (select jsonb_agg(jsonb_build_object('section', 'S' || i)) from generate_series(1, 21) i) || '["Mix"]'::jsonb
     where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, '21 headings are refused');
select throws_ok(
  $$ update public.recipes set steps = '[{"section": "Grill"}]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'headings only (no step) are refused');
select throws_ok(
  $$ update public.recipes set steps = (select jsonb_agg(jsonb_build_object('section', 'S' || i)) from generate_series(1, 20) i)
       || (select jsonb_agg('Stir ' || i) from generate_series(1, 81) i)
     where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, '101 entries, headings included, are refused');
select throws_ok(
  $$ update public.recipes set steps = '["Mix", 2]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a number entry is refused');
select throws_ok(
  $$ update public.recipes set steps = '["Mix", null]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a null entry is refused');
select throws_ok(
  $$ update public.recipes set steps = '["Mix", ["Grill"]]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'an array entry is refused');
select throws_ok(
  $$ update public.recipes set steps = '["Mix", true]' where id = 'a2000000-0000-7000-8000-000000000001' $$,
  '23514', null, 'a boolean entry is refused');

select * from finish();
rollback;
