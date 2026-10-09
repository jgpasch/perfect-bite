// "Start from ingredients" (spec 4.5): Select mode on a list, then Make recipe... or Add to recipe...
import { and, inArray, isNull } from 'drizzle-orm';

import { db, listItemContributions, listItems } from '@/db';
import { itemTotal } from '@/features/lists/items';
import { newId } from '@/lib/id';
import { parseAmount } from '@/shared';

import { addParsedRecipeIngredients, createRecipe, recipeIngredientsQuery } from './recipes';

/**
 * Appends the selected list items to a recipe as ingredients (with their amount when it reads
 * as one amount, like `2 lb`; skipping ones the recipe already has), and links each item to the recipe with an amount-less
 * contribution so it groups under the recipe right away. Returns the names it recorded as pending,
 * for `categorizePending`.
 */
export function addItemsToRecipe(recipeId: string, itemIds: readonly string[], userId: string | null): string[] {
  if (itemIds.length === 0) return [];
  const items = db
    .select()
    .from(listItems)
    .where(and(inArray(listItems.id, [...itemIds]), isNull(listItems.deletedAt)))
    .all();
  const contributions = db
    .select()
    .from(listItemContributions)
    .where(and(inArray(listItemContributions.listItemId, [...itemIds]), isNull(listItemContributions.deletedAt)))
    .all();
  // Keep the order the user sees (selection order is the list's order).
  const ordered = itemIds.map((id) => items.find((i) => i.id === id)).filter((i) => i !== undefined);

  // An ingredient already in the recipe isn't listed again; the item is still linked below.
  const inRecipe = new Set(recipeIngredientsQuery(recipeId).all().map((i) => i.ingredientName));
  const pendingNames = addParsedRecipeIngredients(
    recipeId,
    ordered.filter((item) => !inRecipe.has(item.ingredientName)).map((item) => {
      const amount = parseAmount(itemTotal(contributions.filter((c) => c.listItemId === item.id)));
      return {
        ingredientName: item.ingredientName,
        displayName: item.displayName,
        quantity: amount?.quantity ?? null,
        unit: amount?.unit ?? null,
      };
    }),
  );

  db.transaction((tx) => {
    for (const item of ordered) {
      const linked = contributions.some((c) => c.listItemId === item.id && c.recipeId === recipeId);
      if (linked) continue;
      tx.insert(listItemContributions)
        .values({
          id: newId(),
          listItemId: item.id,
          householdId: item.householdId,
          source: 'recipe',
          recipeId,
          quantity: null,
          unit: null,
          addedBy: userId,
        })
        .run();
    }
  });
  return pendingNames;
}

/** "Make recipe...": a new recipe from the selected items. Returns its id and the names recorded as pending. */
export function makeRecipeFromItems(
  name: string,
  itemIds: readonly string[],
  userId: string | null,
): { recipeId: string; pendingNames: string[] } {
  const recipeId = createRecipe(name);
  return { recipeId, pendingNames: addItemsToRecipe(recipeId, itemIds, userId) };
}

