// The recipe sheets hand their result back to the list screen they open: the sheet stores it as it
// closes, and the list screen takes it when it gains focus to show the toast. Add to recipe (spec
// 4.5) also leaves Select mode and switches to By recipe ("Added 3 items to Tacos"); a recipe added
// to the list (spec 4.4) shows "Added Tacos · 8 items" with Undo.

import type { AddItemResult } from '@/features/lists/items';

export type RecipeAddResult =
  | { kind: 'toRecipe'; listId: string; recipeId: string; recipeName: string; count: number }
  | { kind: 'toList'; listId: string; recipeId: string; recipeName: string; count: number; results: (AddItemResult | null)[] };

let pending: RecipeAddResult | null = null;

export function setRecipeAddResult(result: RecipeAddResult): void {
  pending = result;
}

/** The result for this list, once: taking it clears it. A result for another list stays. */
export function takeRecipeAddResult(listId: string): RecipeAddResult | null {
  if (pending?.listId !== listId) return null;
  const result = pending;
  pending = null;
  return result;
}
