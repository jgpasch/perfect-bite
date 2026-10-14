-- Combine across a family (spec 4.4, 4.15): apply_mutations merges an item that opens beside an
-- open item of its family (`pepino` beside `cucumber`) into that one, both ways. An unlinked pair
-- stays two items, twins open before they were linked stay two, and a cleared link stops new
-- merges while an item already merged stays merged.
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

-- Fixtures (as postgres) ------------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated');
insert into public.households (id, name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1);
insert into public.lists (id, household_id, name, position) values
  ('a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'One', 1),
  ('a1000000-0000-7000-8000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Two', 2),
  ('a1000000-0000-7000-8000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Three', 3);

insert into public.ingredients (normalized_name, display_name, status, lang) values
  ('test cucumber', 'cucumber', 'categorized', 'en'),
  ('test pear', 'pear', 'categorized', 'en'),
  ('test tomato', 'tomato', 'categorized', 'en'),
  ('test tomate', 'tomate', 'categorized', 'es'),
  ('test pera', 'pera', 'categorized', 'es');
insert into public.ingredients (normalized_name, display_name, status, lang, same_as, linked_by) values
  ('test pepino', 'pepino', 'categorized', 'es', 'test cucumber', 'seed');

-- Twins both open before the link (pera, pear).
insert into public.list_items (id, list_id, household_id, ingredient_name, display_name) values
  ('a2000000-0000-7000-8000-000000000031', 'a1000000-0000-7000-8000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test pear', 'pear'),
  ('a2000000-0000-7000-8000-000000000032', 'a1000000-0000-7000-8000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test pera', 'pera');
update public.ingredients set same_as = 'test pear', linked_by = 'seed' where normalized_name = 'test pera';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

-- List One: cucumber first, then pepino.
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000011", "hlc": "1760000000001-0000-alex",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "test cucumber", "display_name": "cucumber" } },
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000012", "hlc": "1760000000002-0000-sam1",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "test pepino", "display_name": "pepino" } },
    { "table": "list_item_contributions", "id": "a3000000-0000-7000-8000-000000000012", "hlc": "1760000000002-0001-sam1",
      "fields": { "list_item_id": "a2000000-0000-7000-8000-000000000012", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "quantity": 2 } }
  ] $$),
  '[{"status": "applied"}, {"status": "merged", "merged_into": "a2000000-0000-7000-8000-000000000011"}, {"status": "applied"}]'::jsonb,
  'pepino added beside an open cucumber is merged into it');
select results_eq(
  $$ select display_name, ingredient_name from public.list_items where list_id = 'a1000000-0000-7000-8000-000000000001' and deleted_at is null $$,
  $$ values ('cucumber', 'test cucumber') $$,
  'one open item, keeping the name it was first added under');
select results_eq(
  $$ select list_item_id, quantity from public.list_item_contributions where id = 'a3000000-0000-7000-8000-000000000012' $$,
  $$ values ('a2000000-0000-7000-8000-000000000011'::uuid, 2::numeric) $$,
  'pepino''s amount went onto cucumber');

-- List Two: pepino first, then cucumber.
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000021", "hlc": "1760000000003-0000-alex",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000002", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "test pepino", "display_name": "pepino" } },
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000022", "hlc": "1760000000004-0000-sam1",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000002", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "test cucumber", "display_name": "cucumber" } }
  ] $$),
  '[{"status": "applied"}, {"status": "merged", "merged_into": "a2000000-0000-7000-8000-000000000021"}]'::jsonb,
  'cucumber added beside an open pepino is merged into it');

-- An unlinked pair stays two.
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000023", "hlc": "1760000000005-0000-alex",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000002", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "test tomato", "display_name": "tomato" } },
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000024", "hlc": "1760000000006-0000-sam1",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000002", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "test tomate", "display_name": "tomate" } }
  ] $$),
  '[{"status": "applied"}, {"status": "applied"}]'::jsonb,
  'tomate beside tomato (unlinked) is its own item');

-- Twins open before their link: an edit doesn't merge them.
select is(
  public.apply_mutations($$ [{ "table": "list_items", "id": "a2000000-0000-7000-8000-000000000032", "hlc": "1760000000007-0000-alex", "fields": { "note": "ripe" } }] $$),
  '[{"status": "applied"}]'::jsonb,
  'editing pera beside an open pear (both open before the link) leaves them two');

-- A checked twin doesn't take an add; reopening it beside the open twin merges it.
select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000031", "hlc": "1760000000008-0000-alex", "fields": { "checked_at": "2026-10-14T10:00:00Z" } },
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000032", "hlc": "1760000000008-0001-alex", "fields": { "checked_at": "2026-10-14T10:00:00Z" } },
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000033", "hlc": "1760000000009-0000-alex",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000003", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "test pera", "display_name": "pera" } }
  ] $$),
  '[{"status": "applied"}, {"status": "applied"}, {"status": "applied"}]'::jsonb,
  'a new pera beside only checked twins is a new item');
select is(
  public.apply_mutations($$ [{ "table": "list_items", "id": "a2000000-0000-7000-8000-000000000031", "hlc": "1760000000010-0000-sam1", "fields": { "checked_at": null } }] $$),
  '[{"status": "merged", "merged_into": "a2000000-0000-7000-8000-000000000033"}]'::jsonb,
  'unchecking pear beside the open pera merges it into pera');

-- ai:unlink clears pepino's link.
reset role;
update public.ingredients set same_as = null, linked_by = null where normalized_name = 'test pepino';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select is(
  public.apply_mutations($$ [
    { "table": "list_items", "id": "a2000000-0000-7000-8000-000000000013", "hlc": "1760000000011-0000-sam1",
      "fields": { "list_id": "a1000000-0000-7000-8000-000000000001", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "ingredient_name": "test pepino", "display_name": "pepino" } }
  ] $$),
  '[{"status": "applied"}]'::jsonb,
  'after the link is cleared, pepino beside an open cucumber is a new item');
select results_eq(
  $$ select deleted_at is not null, merged_into from public.list_items where id = 'a2000000-0000-7000-8000-000000000012' $$,
  $$ values (true, 'a2000000-0000-7000-8000-000000000011'::uuid) $$,
  'the pepino merged before the unlink stays merged');
select results_eq(
  $$ select list_item_id from public.list_item_contributions where id = 'a3000000-0000-7000-8000-000000000012' $$,
  $$ values ('a2000000-0000-7000-8000-000000000011'::uuid) $$,
  'and its amount stays on cucumber');
select is(
  public.apply_mutations($$ [
    { "table": "list_item_contributions", "id": "a3000000-0000-7000-8000-000000000013", "hlc": "1760000000012-0000-sam1",
      "fields": { "list_item_id": "a2000000-0000-7000-8000-000000000012", "household_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "quantity": 1 } }
  ] $$),
  '[{"status": "applied"}]'::jsonb,
  'a late amount for the merged pepino applies');
select results_eq(
  $$ select list_item_id from public.list_item_contributions where id = 'a3000000-0000-7000-8000-000000000013' $$,
  $$ values ('a2000000-0000-7000-8000-000000000011'::uuid) $$,
  'and still follows it to cucumber');

select * from finish();
rollback;
