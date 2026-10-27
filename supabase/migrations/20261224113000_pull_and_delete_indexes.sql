-- Server indexes for pull, deletes and presence (architecture review).
--
-- Pull (src/sync/pull.ts, fetchRows) reads each synced table as `household_id = ? and updated_at >
-- cursor order by updated_at limit n` (or `user_id = ?` for per-user tables), so each gets an index
-- on (household_id, updated_at) or (user_id, updated_at). The single-column household_id indexes
-- they lead with become redundant and go; the composite still serves the household delete cascade.
-- Tables that hold one row per household or user (households, household_category_order,
-- user_settings) are found by their primary key and need nothing.
--
-- Deleting an account or a household sets these `on delete set null` columns to null, which looks
-- rows up by the column: without an index each is a seq scan. They're mostly null, so the indexes
-- are partial.
--
-- Presence: can_use_list_topic compared `l.id::text` to the topic, which can't use the lists
-- primary key. It now checks the topic is a uuid first and compares `l.id = …::uuid`.
--
-- Profiles: profiles_select_own_or_household ran a household_members subquery under the caller's
-- RLS for every profile row. It now reads private.my_co_member_ids(), security definer like
-- my_household_ids. Who can see which profile is unchanged.

-- Pull ------------------------------------------------------------------------------------------

create index categories_household_updated_idx on public.categories (household_id, updated_at);
drop index public.categories_household_id_idx;

create index household_category_overrides_household_updated_idx
  on public.household_category_overrides (household_id, updated_at);
create index household_staples_household_updated_idx on public.household_staples (household_id, updated_at);
create index ingredient_usage_household_updated_idx on public.ingredient_usage (household_id, updated_at);
create index ingredient_unit_usage_household_updated_idx
  on public.ingredient_unit_usage (household_id, updated_at);

create index lists_household_updated_idx on public.lists (household_id, updated_at);
drop index public.lists_household_id_idx;

create index recipes_household_updated_idx on public.recipes (household_id, updated_at);
drop index public.recipes_household_id_idx;

create index recipe_favorites_household_updated_idx on public.recipe_favorites (household_id, updated_at);
drop index public.recipe_favorites_household_id_idx;

create index recipe_collections_household_updated_idx on public.recipe_collections (household_id, updated_at);
drop index public.recipe_collections_household_id_idx;

create index recipe_collection_recipes_household_updated_idx
  on public.recipe_collection_recipes (household_id, updated_at);
drop index public.recipe_collection_recipes_household_id_idx;

create index list_items_household_updated_idx on public.list_items (household_id, updated_at);
drop index public.list_items_household_id_idx;

create index recipe_ingredients_household_updated_idx on public.recipe_ingredients (household_id, updated_at);
drop index public.recipe_ingredients_household_id_idx;

create index list_item_contributions_household_updated_idx
  on public.list_item_contributions (household_id, updated_at);
drop index public.list_item_contributions_household_id_idx;

-- meal_plan_entries_household_date_idx stays: the plan reads by date.
create index meal_plan_entries_household_updated_idx on public.meal_plan_entries (household_id, updated_at);

create index user_household_category_order_user_updated_idx
  on public.user_household_category_order (user_id, updated_at);

-- Deletes ---------------------------------------------------------------------------------------

create index list_items_merged_into_idx on public.list_items (merged_into) where merged_into is not null;
create index list_items_checked_by_idx on public.list_items (checked_by) where checked_by is not null;
create index list_items_added_by_idx on public.list_items (added_by) where added_by is not null;
create index list_item_contributions_added_by_idx
  on public.list_item_contributions (added_by) where added_by is not null;
create index user_settings_default_list_id_idx
  on public.user_settings (default_list_id) where default_list_id is not null;
create index households_created_by_idx on public.households (created_by) where created_by is not null;
create index household_invites_created_by_idx
  on public.household_invites (created_by) where created_by is not null;
create index household_invites_used_by_idx on public.household_invites (used_by) where used_by is not null;
create index share_imports_credential_id_idx
  on public.share_imports (credential_id) where credential_id is not null;

-- Presence --------------------------------------------------------------------------------------

-- Whether `p_topic` is `list:<id>` for a list in one of the caller's households. The id must be a
-- lowercase uuid, as `l.id::text` gave before; anything else is refused before the cast.
-- plpgsql, so the cast never runs ahead of the check.
create or replace function private.can_use_list_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_topic is null
    or p_topic !~ '^list:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return exists (
    select 1
    from public.lists l
    join public.household_members m on m.household_id = l.household_id
    where l.id = substr(p_topic, 6)::uuid
      and m.user_id = (select auth.uid())
  );
end;
$$;

-- Profiles --------------------------------------------------------------------------------------

-- Everyone who shares a household with the caller, the caller included.
create function private.my_co_member_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.user_id
  from public.household_members m
  where m.household_id in (
    select household_id from public.household_members where user_id = (select auth.uid())
  );
$$;

revoke all on function private.my_co_member_ids() from public, anon;
grant execute on function private.my_co_member_ids() to authenticated;

drop policy profiles_select_own_or_household on public.profiles;

create policy profiles_select_own_or_household on public.profiles
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or user_id in (select private.my_co_member_ids())
  );
