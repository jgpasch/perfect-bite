// What the recipe screens show (boards 05–07). Pure: no React, SQLite or network.

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

/** A recipe row's second line in the add bar's panel (spec 4.2): "Recipe · 8 items". */
export function recipeSuggestionDetail(count: number): string {
  return `Recipe · ${count} ${count === 1 ? 'item' : 'items'}`;
}

/** What VoiceOver reads for that row: "Add recipe Tacos, 8 items". */
export function recipeSuggestionLabel(name: string, count: number): string {
  return `Add recipe ${name}, ${count} ${count === 1 ? 'item' : 'items'}`;
}

/** The toast after adding a recipe to a list: "Added Tacos · 8 items", the recipe's name in bold. */
export function addedRecipeToListToast(recipeName: string, count: number): { message: string; emphasis: string } {
  return { message: `Added ${recipeName} · ${count} ${count === 1 ? 'item' : 'items'}`, emphasis: recipeName };
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