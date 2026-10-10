-- Realtime (spec 7.2): the app listens for changes to the user's households, their own
-- preference tables, their memberships and the catalog while it's in the foreground, and pulls
-- what changed. Realtime checks each subscriber's RLS (select) policies, so members only hear
-- about their own households' rows.
--
-- Replica identity stays the default (the primary key): delete events only need the key. The
-- app applies the user's category order and override deletes from it, since those rows are
-- hard-deleted and a pull can't see them.

alter publication supabase_realtime add table
  public.households,
  public.household_members,
  public.lists,
  public.recipes,
  public.list_items,
  public.recipe_ingredients,
  public.list_item_contributions,
  public.ingredient_usage,
  public.ingredient_unit_usage,
  public.categories,
  public.user_category_order,
  public.user_category_overrides,
  public.user_settings,
  public.ingredients;
