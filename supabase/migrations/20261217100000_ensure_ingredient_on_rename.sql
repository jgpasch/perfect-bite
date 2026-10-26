-- Renaming a list item or recipe ingredient to a name the catalog hasn't seen (spec 5): the
-- device adds the new name to its own catalog and pushes an update, but ensure_ingredient only
-- ran on insert, so the update failed the ingredients foreign key and the rename was lost.
-- Run it on a rename too: the new name goes in as pending and counts for the household.

create trigger list_items_ensure_ingredient_on_rename
  before update of ingredient_name on public.list_items
  for each row when (new.ingredient_name is distinct from old.ingredient_name)
  execute function private.ensure_ingredient();

create trigger recipe_ingredients_ensure_ingredient_on_rename
  before update of ingredient_name on public.recipe_ingredients
  for each row when (new.ingredient_name is distinct from old.ingredient_name)
  execute function private.ensure_ingredient();
