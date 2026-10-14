// Searching the Recipes tab (spec 4.14). Pure: no React, SQLite or network.
import { i18n, onLanguageChanged } from '@/i18n';

/** Text as search compares it: lower case, without accents ("Jalapeño" → "jalapeno"), spaces collapsed. */
export function foldForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export type RecipeSearchResult<R> = {
  recipe: R;
  /** The ingredient it matched through, when its name doesn't match: shown as "Has …". */
  ingredientMatch: string | null;
};

/**
 * The recipes whose name, or one of whose ingredients' display names, contains `query`, ignoring
 * case and accents, in their order. A blank query matches every recipe. `ingredients` are the live
 * ingredients of live recipes (`recipeIngredientNamesQuery`), in recipe order; the first match is shown.
 */
export function searchRecipes<R extends { id: string; name: string }>(
  recipes: readonly R[],
  ingredients: readonly { recipeId: string; displayName: string }[],
  query: string,
): RecipeSearchResult<R>[] {
  const q = foldForSearch(query);
  if (!q) return recipes.map((recipe) => ({ recipe, ingredientMatch: null }));
  const firstMatch = new Map<string, string>();
  for (const { recipeId, displayName } of ingredients) {
    if (!firstMatch.has(recipeId) && foldForSearch(displayName).includes(q)) firstMatch.set(recipeId, displayName);
  }
  const results: RecipeSearchResult<R>[] = [];
  for (const recipe of recipes) {
    if (foldForSearch(recipe.name).includes(q)) results.push({ recipe, ingredientMatch: null });
    else if (firstMatch.has(recipe.id)) results.push({ recipe, ingredientMatch: firstMatch.get(recipe.id)! });
  }
  return results;
}

/** The search field's placeholder: "Search 1 recipe", "Search 52 recipes". */
export function recipeSearchPlaceholder(count: number): string {
  return i18n.t('recipes.tab.search', { count });
}

// Module-level strings follow the app's language (a live binding, set once i18n is initialized).
export let NO_RECIPES_MATCH = '';
onLanguageChanged(() => {
  NO_RECIPES_MATCH = i18n.t('recipes.tab.noMatch');
});
