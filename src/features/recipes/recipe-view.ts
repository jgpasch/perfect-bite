// What the recipe screens show (boards 05–08). Pure: no React, SQLite or network.

import type { BulkConflict } from '@/features/lists/items';

export type RecipeHouseholdGroup<R> = { householdId: string; name: string; recipes: R[] };

/** Recipes under their household's name, households in order of their first recipe, recipes in order. */
export function groupRecipesByHousehold<R extends { householdId: string; householdName: string }>(
  recipes: readonly R[],
): RecipeHouseholdGroup<R>[] {
  const groups = new Map<string, RecipeHouseholdGroup<R>>();
  for (const recipe of recipes) {
    const group = groups.get(recipe.householdId) ?? { householdId: recipe.householdId, name: recipe.householdName, recipes: [] };
    group.recipes.push(recipe);
    groups.set(recipe.householdId, group);
  }
  return [...groups.values()];
}

/**
 * The list each recipe is on, for its "On Groceries" badge: the list it was most recently added
 * to, of those where it still has an open item (`recipesOnListsQuery` rows).
 */
export function onListByRecipe(rows: readonly { recipeId: string; listName: string; addedAt: Date }[]): Map<string, string> {
  const latest = new Map<string, { listName: string; at: number }>();
  for (const row of rows) {
    const at = row.addedAt.getTime();
    const current = latest.get(row.recipeId);
    if (!current || at > current.at) latest.set(row.recipeId, { listName: row.listName, at });
  }
  return new Map([...latest].map(([recipeId, { listName }]) => [recipeId, listName]));
}

/** "1 ingredient", "9 ingredients". */
export function ingredientCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'ingredient' : 'ingredients'}`;
}

/** What VoiceOver reads for a recipe card: "Chicken tacos, 9 ingredients, on Groceries". */
export function recipeCardLabel(name: string, count: number, onList?: string | null): string {
  return [name, ingredientCountLabel(count), onList ? `on ${onList}` : null].filter(Boolean).join(', ');
}

/** A servings multiplier's pill: "½×", "1×", "2×". */
export function servingsLabel(servings: number): string {
  return `${servings === 0.5 ? '½' : servings}×`;
}

/** The add-to-list CTA: "Add 8 to Groceries", or "Nothing selected". */
export function addCtaLabel(count: number, listName: string): string {
  return count === 0 ? 'Nothing selected' : `Add ${count} to ${listName}`;
}

/** The already-on-the-list step's title: "2 are already on Groceries". */
export function conflictTitle(count: number, listName: string): string {
  return `${count} ${count === 1 ? 'is' : 'are'} already on ${listName}`;
}

type ConflictAmounts = Pick<BulkConflict, 'existingAmountText' | 'combinedAmountText' | 'keptAmountText'>;

/**
 * A clash row's result on the right: "→ 6 lb" when combining, "stays 4" when keeping (or "→ …" if
 * keeping still changes the total), or nothing when there's no amount to show.
 */
export function conflictResult(conflict: ConflictAmounts, keeping: boolean): string {
  if (!keeping) return conflict.combinedAmountText ? `→ ${conflict.combinedAmountText}` : '';
  if (conflict.keptAmountText !== conflict.existingAmountText) return conflict.keptAmountText ? `→ ${conflict.keptAmountText}` : '';
  return conflict.existingAmountText ? `stays ${conflict.existingAmountText}` : '';
}

/**
 * Recipes most recently used first (the "Add to recipe" sheet, spec 4.5). A recipe's last use is
 * the later of its last change (`updatedAt`) and the last time it was added to a list (`uses`, one
 * per recipe contribution). Ties go by name, then id.
 */
export function orderByLastUse<R extends { id: string; name: string; updatedAt: Date }>(
  recipes: readonly R[],
  uses: readonly { recipeId: string; at: Date }[],
): R[] {
  const lastAdd = new Map<string, number>();
  for (const use of uses) lastAdd.set(use.recipeId, Math.max(lastAdd.get(use.recipeId) ?? -Infinity, use.at.getTime()));
  const lastUse = (r: R) => Math.max(r.updatedAt.getTime(), lastAdd.get(r.id) ?? -Infinity);
  return [...recipes].sort(
    (a, b) => lastUse(b) - lastUse(a) || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** The "Add to recipe" sheet's title: "Add 1 item to…", "Add 3 items to…". */
export function addToRecipeTitle(count: number): string {
  return `Add ${count} ${count === 1 ? 'item' : 'items'} to…`;
}

/** The toast after adding items to a recipe: "Added 3 items to Tacos", the recipe's name in bold. */
export function addedToRecipeToast(count: number, recipeName: string): { message: string; emphasis: string } {
  return { message: `Added ${count} ${count === 1 ? 'item' : 'items'} to ${recipeName}`, emphasis: recipeName };
}

/** The Keep segment's label: "Keep 4", or "Keep" when the item has no amount. */
export function keepLabel(conflict: Pick<BulkConflict, 'existingAmountText'>): string {
  return conflict.existingAmountText ? `Keep ${conflict.existingAmountText}` : 'Keep';
}
