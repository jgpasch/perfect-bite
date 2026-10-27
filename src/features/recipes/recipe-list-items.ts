import { gridRows } from '@/features/recipes/recipe-photo-size';
import type { RecipeSection } from '@/features/recipes/recipe-sort';

/**
 * Where a household starts: its first item carries the gap above it (smaller for the first household) and,
 * with more than one household, its name.
 */
export type RecipeListHousehold = { name: string; first: boolean; label: boolean };

/**
 * The Recipes tab's list (spec 4.5) as the items of a virtualized list, so only the rows in sight are mounted
 * and a search keystroke stays quick with hundreds of recipes. Ungrouped, each recipe row (small photos) or
 * row of tiles (large photos) is its own item, so the household's card is drawn a slice per row. Grouped,
 * each section's folding card is one item.
 */
export type RecipeListItem<R> =
  | { kind: 'row'; key: string; household?: RecipeListHousehold; recipe: R; first: boolean; last: boolean }
  | { kind: 'tiles'; key: string; household?: RecipeListHousehold; recipes: R[]; first: boolean }
  | { kind: 'section'; key: string; household?: RecipeListHousehold; householdId: string; section: RecipeSection<R> };

type Group<R> = { householdId: string; name: string; recipes: readonly R[]; sections: readonly RecipeSection<R>[] };

export function recipeListItems<R extends { id: string }>({
  groups,
  grouped,
  large,
  columns,
  labelHouseholds,
}: {
  /** The households shown, in order, each with its recipes sorted and (grouped) its sections. */
  groups: readonly Group<R>[];
  grouped: boolean;
  /** Large photos: tiles in rows of `columns`, not one row per recipe. */
  large: boolean;
  columns: number;
  labelHouseholds: boolean;
}): RecipeListItem<R>[] {
  const items: RecipeListItem<R>[] = [];
  groups.forEach((group, i) => {
    const { householdId } = group;
    const start: RecipeListHousehold = { name: group.name, first: i === 0, label: labelHouseholds };
    const household = (j: number) => (j === 0 ? { household: start } : {});
    if (grouped) {
      group.sections.forEach((section, j) =>
        items.push({ kind: 'section', key: `section:${householdId}:${section.key}`, ...household(j), householdId, section }),
      );
    } else if (large) {
      gridRows(group.recipes, columns).forEach((recipes, j) =>
        items.push({ kind: 'tiles', key: `tiles:${householdId}:${recipes[0].id}`, ...household(j), recipes, first: j === 0 }),
      );
    } else {
      group.recipes.forEach((recipe, j) =>
        items.push({
          kind: 'row',
          key: `row:${householdId}:${recipe.id}`,
          ...household(j),
          recipe,
          first: j === 0,
          last: j === group.recipes.length - 1,
        }),
      );
    }
  });
  return items;
}
