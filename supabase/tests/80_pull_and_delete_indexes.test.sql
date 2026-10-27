-- Server indexes for pull, deletes and presence (architecture review): pull's per-table
-- `household_id/user_id = ? and updated_at > cursor order by updated_at` has a matching index on
-- every synced table, `on delete set null` columns have partial indexes, the single-column
-- household_id indexes are gone, and presence and profile visibility are unchanged.
begin;
create extension if not exists pgtap with schema extensions;
select plan(68);

-- Pull indexes ----------------------------------------------------------------------------------
select has_index('public', 'categories', 'categories_household_updated_idx', array['household_id', 'updated_at'], 'categories (household_id, updated_at)');
select has_index('public', 'household_category_overrides', 'household_category_overrides_household_updated_idx', array['household_id', 'updated_at'], 'household_category_overrides (household_id, updated_at)');
select has_index('public', 'household_staples', 'household_staples_household_updated_idx', array['household_id', 'updated_at'], 'household_staples (household_id, updated_at)');
select has_index('public', 'ingredient_usage', 'ingredient_usage_household_updated_idx', array['household_id', 'updated_at'], 'ingredient_usage (household_id, updated_at)');
select has_index('public', 'ingredient_unit_usage', 'ingredient_unit_usage_household_updated_idx', array['household_id', 'updated_at'], 'ingredient_unit_usage (household_id, updated_at)');
select has_index('public', 'lists', 'lists_household_updated_idx', array['household_id', 'updated_at'], 'lists (household_id, updated_at)');
select has_index('public', 'recipes', 'recipes_household_updated_idx', array['household_id', 'updated_at'], 'recipes (household_id, updated_at)');
select has_index('public', 'recipe_favorites', 'recipe_favorites_household_updated_idx', array['household_id', 'updated_at'], 'recipe_favorites (household_id, updated_at)');
select has_index('public', 'recipe_collections', 'recipe_collections_household_updated_idx', array['household_id', 'updated_at'], 'recipe_collections (household_id, updated_at)');
select has_index('public', 'recipe_collection_recipes', 'recipe_collection_recipes_household_updated_idx', array['household_id', 'updated_at'], 'recipe_collection_recipes (household_id, updated_at)');
select has_index('public', 'list_items', 'list_items_household_updated_idx', array['household_id', 'updated_at'], 'list_items (household_id, updated_at)');
select has_index('public', 'recipe_ingredients', 'recipe_ingredients_household_updated_idx', array['household_id', 'updated_at'], 'recipe_ingredients (household_id, updated_at)');
select has_index('public', 'list_item_contributions', 'list_item_contributions_household_updated_idx', array['household_id', 'updated_at'], 'list_item_contributions (household_id, updated_at)');
select has_index('public', 'meal_plan_entries', 'meal_plan_entries_household_updated_idx', array['household_id', 'updated_at'], 'meal_plan_entries (household_id, updated_at)');
select has_index('public', 'user_household_category_order', 'user_household_category_order_user_updated_idx', array['user_id', 'updated_at'], 'user_household_category_order (user_id, updated_at)');

-- The single-column ones they make redundant are gone; the plan's date index stays.
select hasnt_index('public', 'categories', 'categories_household_id_idx', 'categories_household_id_idx dropped');
select hasnt_index('public', 'lists', 'lists_household_id_idx', 'lists_household_id_idx dropped');
select hasnt_index('public', 'recipes', 'recipes_household_id_idx', 'recipes_household_id_idx dropped');
select hasnt_index('public', 'recipe_favorites', 'recipe_favorites_household_id_idx', 'recipe_favorites_household_id_idx dropped');
select hasnt_index('public', 'recipe_collections', 'recipe_collections_household_id_idx', 'recipe_collections_household_id_idx dropped');
select hasnt_index('public', 'recipe_collection_recipes', 'recipe_collection_recipes_household_id_idx', 'recipe_collection_recipes_household_id_idx dropped');
select hasnt_index('public', 'list_items', 'list_items_household_id_idx', 'list_items_household_id_idx dropped');
select hasnt_index('public', 'recipe_ingredients', 'recipe_ingredients_household_id_idx', 'recipe_ingredients_household_id_idx dropped');
select hasnt_index('public', 'list_item_contributions', 'list_item_contributions_household_id_idx', 'list_item_contributions_household_id_idx dropped');
select has_index('public', 'meal_plan_entries', 'meal_plan_entries_household_date_idx', array['household_id', 'plan_date'], 'meal_plan_entries (household_id, plan_date) kept');

-- Delete indexes: on the column, and partial (only non-null rows) -----------------------------
create function pg_temp.partial_on(p_index text) returns text language sql as $$
  select pg_get_expr(i.indpred, i.indrelid)
  from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = p_index;
$$;

select has_index('public', 'list_items', 'list_items_merged_into_idx', array['merged_into'], 'list_items (merged_into)');
select is(pg_temp.partial_on('list_items_merged_into_idx'), '(merged_into IS NOT NULL)', 'list_items_merged_into_idx is partial');
select has_index('public', 'list_items', 'list_items_checked_by_idx', array['checked_by'], 'list_items (checked_by)');
select is(pg_temp.partial_on('list_items_checked_by_idx'), '(checked_by IS NOT NULL)', 'list_items_checked_by_idx is partial');
select has_index('public', 'list_items', 'list_items_added_by_idx', array['added_by'], 'list_items (added_by)');
select is(pg_temp.partial_on('list_items_added_by_idx'), '(added_by IS NOT NULL)', 'list_items_added_by_idx is partial');
select has_index('public', 'list_item_contributions', 'list_item_contributions_added_by_idx', array['added_by'], 'list_item_contributions (added_by)');
select is(pg_temp.partial_on('list_item_contributions_added_by_idx'), '(added_by IS NOT NULL)', 'list_item_contributions_added_by_idx is partial');
select has_index('public', 'user_settings', 'user_settings_default_list_id_idx', array['default_list_id'], 'user_settings (default_list_id)');
select is(pg_temp.partial_on('user_settings_default_list_id_idx'), '(default_list_id IS NOT NULL)', 'user_settings_default_list_id_idx is partial');
select has_index('public', 'households', 'households_created_by_idx', array['created_by'], 'households (created_by)');
select is(pg_temp.partial_on('households_created_by_idx'), '(created_by IS NOT NULL)', 'households_created_by_idx is partial');
select has_index('public', 'household_invites', 'household_invites_created_by_idx', array['created_by'], 'household_invites (created_by)');
select is(pg_temp.partial_on('household_invites_created_by_idx'), '(created_by IS NOT NULL)', 'household_invites_created_by_idx is partial');
select has_index('public', 'household_invites', 'household_invites_used_by_idx', array['used_by'], 'household_invites (used_by)');
select is(pg_temp.partial_on('household_invites_used_by_idx'), '(used_by IS NOT NULL)', 'household_invites_used_by_idx is partial');
select has_index('public', 'share_imports', 'share_imports_credential_id_idx', array['credential_id'], 'share_imports (credential_id)');
select is(pg_temp.partial_on('share_imports_credential_id_idx'), '(credential_id IS NOT NULL)', 'share_imports_credential_id_idx is partial');

-- Fixtures (as postgres) ------------------------------------------------------------------------
-- Alex and Jo share household A (one list). Sam owns household S (one list) and is also in B with
-- Kim. Lee belongs to no household.
insert into auth.users (id, email, aud, role, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alex@test.local', 'authenticated', 'authenticated', '{}'),
  ('22222222-2222-2222-2222-222222222222', 'sam@test.local', 'authenticated', 'authenticated', '{}'),
  ('33333333-3333-3333-3333-333333333333', 'jo@test.local', 'authenticated', 'authenticated', '{}'),
  ('44444444-4444-4444-4444-444444444444', 'kim@test.local', 'authenticated', 'authenticated', '{}'),
  ('55555555-5555-5555-5555-555555555555', 'lee@test.local', 'authenticated', 'authenticated', '{}');

insert into public.households (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'S'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'B');
insert into public.household_members (household_id, user_id, role, position) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner', 1),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'member', 2),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner', 1),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '44444444-4444-4444-4444-444444444444', 'owner', 1),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '22222222-2222-2222-2222-222222222222', 'member', 2);
insert into public.lists (id, household_id, name, position) values
  ('a1000000-0000-7000-8000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Groceries', 1),
  ('b1000000-0000-7000-8000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Sam''s list', 1);

-- Pull's query can use the new index ------------------------------------------------------------
create function pg_temp.plan_of(p_query text) returns text language plpgsql as $$
declare
  line text;
  result text := '';
begin
  for line in execute 'explain (costs off) ' || p_query loop
    result := result || line || E'\n';
  end loop;
  return result;
end;
$$;

set local enable_seqscan = off;
select matches(
  pg_temp.plan_of($$ select * from public.list_items where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    and updated_at > '2026-01-01' order by updated_at limit 1000 $$),
  'list_items_household_updated_idx', 'pull of list_items uses (household_id, updated_at)');
select matches(
  pg_temp.plan_of($$ select * from public.user_household_category_order where user_id = '11111111-1111-1111-1111-111111111111'
    and updated_at > '2026-01-01' order by updated_at limit 1000 $$),
  'user_household_category_order_user_updated_idx', 'pull of user_household_category_order uses (user_id, updated_at)');
select matches(
  pg_temp.plan_of($$ select * from public.categories where household_id is null order by updated_at limit 1000 $$),
  'categories_household_updated_idx', 'the system categories pull uses (household_id, updated_at) too');
-- Presence's lookup: comparing as a uuid is an index condition, comparing as text (before) isn't.
select matches(
  pg_temp.plan_of($$ select 1 from public.lists l where l.id = substr('list:a1000000-0000-7000-8000-000000000001', 6)::uuid $$),
  'Index Cond: \(id = ', 'a list looked up by uuid uses an index on id');
select doesnt_match(
  pg_temp.plan_of($$ select 1 from public.lists l where l.id::text = substr('list:a1000000-0000-7000-8000-000000000001', 6) $$),
  'Index Cond', 'the old text comparison couldn''t');
reset enable_seqscan;

-- Presence ---------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select is(private.can_use_list_topic('list:a1000000-0000-7000-8000-000000000001'), true, 'a member may use their list''s topic');
select is(private.can_use_list_topic('list:b1000000-0000-7000-8000-000000000001'), false, 'not another household''s list');
select is(private.can_use_list_topic('list:c1000000-0000-7000-8000-000000000001'), false, 'not a list that doesn''t exist');
select is(private.can_use_list_topic('list:not-a-uuid'), false, 'a topic that isn''t a uuid is refused, not an error');
select is(private.can_use_list_topic('list:A1000000-0000-7000-8000-000000000001'), false, 'an uppercase id is refused, as before');
select is(private.can_use_list_topic('list:{a1000000-0000-7000-8000-000000000001}'), false, 'a braced id is refused');
select is(private.can_use_list_topic('list:a1000000000070008000000000000001'), false, 'an id without hyphens is refused');
select is(private.can_use_list_topic('list:a1000000-0000-7000-8000-000000000001 '), false, 'trailing text is refused');
select is(private.can_use_list_topic('a1000000-0000-7000-8000-000000000001'), false, 'a bare uuid without list: is refused');
select is(private.can_use_list_topic('lists:a1000000-0000-7000-8000-000000000001'), false, 'another prefix is refused');
select is(private.can_use_list_topic('list:'), false, 'an empty id is refused');
select is(private.can_use_list_topic(null), false, 'a null topic is refused');

select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is(private.can_use_list_topic('list:a1000000-0000-7000-8000-000000000001'), false, 'a non-member may not use the list''s topic');
select is(private.can_use_list_topic('list:b1000000-0000-7000-8000-000000000001'), true, 'Sam may use their own list''s topic');

-- Profile visibility -----------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select results_eq($$ select user_id from public.profiles order by user_id $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid), ('33333333-3333-3333-3333-333333333333'::uuid) $$,
  'Alex sees their own and Jo''s profiles only');
select results_eq($$ select * from private.my_co_member_ids() order by 1 $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid), ('33333333-3333-3333-3333-333333333333'::uuid) $$,
  'my_co_member_ids is Alex and Jo');

-- Sam is in two households: sees Kim (B), and themself once.
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select results_eq($$ select user_id from public.profiles order by user_id $$,
  $$ values ('22222222-2222-2222-2222-222222222222'::uuid), ('44444444-4444-4444-4444-444444444444'::uuid) $$,
  'Sam sees their own and Kim''s profiles, across both households');

-- Lee, in no household, sees only themself.
select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}', true);
select results_eq($$ select user_id from public.profiles $$,
  $$ values ('55555555-5555-5555-5555-555555555555'::uuid) $$,
  'someone in no household sees only their own profile');

-- Jo leaves A: Alex no longer sees Jo.
reset role;
delete from public.household_members
  where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and user_id = '33333333-3333-3333-3333-333333333333';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select results_eq($$ select user_id from public.profiles $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid) $$,
  'after Jo leaves, Alex sees only their own profile');

set local role anon;
select throws_ok($$ select * from private.my_co_member_ids() $$, '42501', null, 'anon can''t call my_co_member_ids');

select * from finish();
rollback;
