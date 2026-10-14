import type { RecipeIngredient } from '@/db';
import { kitchenRound } from '@/domain/kitchen-round';
import { collectPendingNames } from '@/features/categories/categories';
import { stapleNames } from '@/features/households/staples';
import { addItemsBulk, undoAdds, type AddItemResult, type BulkAdd } from '@/features/lists/items';
import { getList } from '@/features/lists/lists';
import { i18n } from '@/i18n';

import { SERVINGS_MAX, SERVINGS_MIN } from './recipe-view';
import { getRecipe, recipeIngredientsQuery } from './recipes';

/** Servings multipliers offered when adding a recipe to a list (spec 4.5). */
export const SERVINGS = [0.5, 1, 2, 3] as const;

/**
 * Where Add to list's servings card starts (board 17): the recipe screen's chosen servings (`param`, a whole number
 * 1–100), else the recipe's own `base`.
 */
export function startingServings(base: number, param: string | undefined): number {
  const chosen = Number(param);
  return param && Number.isInteger(chosen) && chosen >= SERVINGS_MIN && chosen <= SERVINGS_MAX ? chosen : base;
}

/** The multiplier for `buildRecipeAdds` when adding for `chosen` people and the recipe serves `base`. */
export function servingsMultiplier(chosen: number, base: number): number {
  return chosen / base;
}

/** The servings card's line under "For 6": "Recipe serves 4". */
export function recipeServesLabel(base: number): string {
  return i18n.t('recipes.servings.recipeServes', { count: base });
}

/**
 * The bulk adds for a recipe's chosen ingredients, scaled by `servings` and rounded to kitchen measures
 * (`kitchenRound`, which may change the unit). At 1× the amounts are as written.
 */
export function buildRecipeAdds(
  recipeId: string,
  ingredients: readonly RecipeIngredient[],
  selectedIds: ReadonlySet<string>,
  servings: number,
): BulkAdd[] {
  return ingredients
    .filter((i) => selectedIds.has(i.id))
    .map((i) => ({
      source: 'recipe' as const,
      recipeId,
      parsed: {
        ingredientName: i.ingredientName,
        displayName: i.displayName,
        ...(i.quantity === null || servings === 1
          ? { quantity: i.quantity, unit: i.unit }
          : kitchenRound({ quantity: i.quantity * servings, unit: i.unit })),
      },
    }));
}

/**
 * The ingredients a recipe add starts with ticked (spec 4.5): all but the household's staples (`stapleNames`),
 * matched by ingredient key.
 */
export function defaultSelection(ingredients: readonly RecipeIngredient[], staples: ReadonlySet<string>): Set<string> {
  return new Set(ingredients.filter((i) => !staples.has(i.ingredientName)).map((i) => i.id));
}

/** What one recipe add did: the adds, for Undo, how many there were, for the toast, and new names. */
export type RecipeListAdd = {
  results: (AddItemResult | null)[];
  count: number;
  /** Every name the add recorded as pending, for one `categorizePending` call. */
  pendingNames: string[];
};

/**
 * Adds the recipe's chosen ingredients as single adds would (spec 4.4): every one already open on
 * the list Combines, and a checked one is reopened with its amounts replaced. Nothing to ask.
 */
export function addRecipeToList(listId: string, adds: readonly BulkAdd[], userId: string | null): RecipeListAdd {
  const results = addItemsBulk(listId, adds, userId);
  return { results, count: results.filter((r) => r !== null).length, pendingNames: collectPendingNames(results) };
}

/** The toast's Undo: takes back the whole recipe add in one step. */
export function undoRecipeAdd(add: Pick<RecipeListAdd, 'results'>): void {
  undoAdds(add.results);
}

/**
 * A recipe picked in the add bar (spec 4.2): every ingredient at 1× except the list household's staples
 * (`defaultSelection`), added as `addRecipeToList` does. Null when the recipe is gone; `recipeName` is for the toast
 * and `skipped` names the staples left out, in recipe order. All staples: nothing added, `count: 0`.
 */
export function addWholeRecipeToList(
  listId: string,
  recipeId: string,
  userId: string | null,
): (RecipeListAdd & { recipeName: string; skipped: string[] }) | null {
  const recipe = getRecipe(recipeId);
  if (!recipe) return null;
  const ingredients = recipeIngredientsQuery(recipeId).all();
  const householdId = getList(listId)?.householdId;
  const selected = defaultSelection(ingredients, householdId ? stapleNames(householdId) : new Set());
  const adds = buildRecipeAdds(recipeId, ingredients, selected, 1);
  // One name per staple, the recipe's first text for it.
  const skipped = new Map<string, string>();
  for (const i of ingredients) {
    if (!selected.has(i.id) && !skipped.has(i.ingredientName)) skipped.set(i.ingredientName, i.displayName);
  }
  return { ...addRecipeToList(listId, adds, userId), recipeName: recipe.name, skipped: [...skipped.values()] };
}

/**
 * The add sheet opened from the toast's **Adjust** (spec 4.2): takes back the earlier add, then adds the adjusted
 * one, so the list ends up as if only the adjusted add had happened.
 */
export function replaceRecipeAdd(
  previous: Pick<RecipeListAdd, 'results'>,
  listId: string,
  adds: readonly BulkAdd[],
  userId: string | null,
): RecipeListAdd {
  undoRecipeAdd(previous);
  return addRecipeToList(listId, adds, userId);
}
