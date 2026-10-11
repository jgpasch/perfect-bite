import type { RecipeIngredient } from '@/db';
import { collectPendingNames } from '@/features/categories/categories';
import { addItemsBulk, undoAdds, type AddItemResult, type BulkAdd } from '@/features/lists/items';

import { getRecipe, recipeIngredientsQuery } from './recipes';

/** Servings multipliers offered when adding a recipe to a list (spec 4.5). */
export const SERVINGS = [0.5, 1, 2, 3] as const;

/** The bulk adds for a recipe's chosen ingredients, scaled by `servings`. */
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
        quantity: i.quantity === null ? null : i.quantity * servings,
        unit: i.unit,
      },
    }));
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
 * A recipe picked in the add bar (spec 4.2): every ingredient at 1×, added as `addRecipeToList` does. Null when the
 * recipe is gone; `recipeName` is for the toast.
 */
export function addWholeRecipeToList(
  listId: string,
  recipeId: string,
  userId: string | null,
): (RecipeListAdd & { recipeName: string }) | null {
  const recipe = getRecipe(recipeId);
  if (!recipe) return null;
  const ingredients = recipeIngredientsQuery(recipeId).all();
  const adds = buildRecipeAdds(recipeId, ingredients, new Set(ingredients.map((i) => i.id)), 1);
  return { ...addRecipeToList(listId, adds, userId), recipeName: recipe.name };
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
