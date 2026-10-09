import type { RecipeIngredient } from '@/db';
import { collectPendingNames } from '@/features/categories/categories';
import { addItemsBulk, planBulkAddToList, type BulkAdd, type BulkConflict } from '@/features/lists/items';

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

/** Conflicts to ask about before adding (the bulk sheet), or none. */
export function planRecipeAdd(listId: string, adds: readonly BulkAdd[]): BulkConflict[] {
  return planBulkAddToList(listId, adds);
}

/**
 * Adds the recipe's ingredients; `keepExisting` holds the indexes the user chose to keep. Returns
 * every name the add recorded as pending, for one `categorizePending` call.
 */
export function addRecipeToList(
  listId: string,
  adds: readonly BulkAdd[],
  userId: string | null,
  keepExisting: ReadonlySet<number>,
): string[] {
  return collectPendingNames(addItemsBulk(listId, adds, userId, keepExisting));
}
