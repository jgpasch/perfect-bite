// The recipe sheets hand their result back to the list screen they open: the sheet stores it as it
// closes, and the list screen takes it when it gains focus to show the toast. Add to recipe (spec
// 4.5) also leaves Select mode and switches to By recipe ("Added 3 items to Tacos"); a recipe added
// to the list (spec 4.4) shows "Added Tacos · 8 items" with Undo; a recipe imported from a link (spec
// 4.10) shows the same with Undo and View recipe.

import type { AddItemResult } from '@/features/lists/items';

export type RecipeAddResult =
  | { kind: 'toRecipe'; listId: string; recipeId: string; recipeName: string; count: number }
  | { kind: 'toList'; listId: string; recipeId: string; recipeName: string; count: number; results: (AddItemResult | null)[] }
  | { kind: 'imported'; listId: string; recipeId: string; recipeName: string; count: number; undo: () => void };

let pending: RecipeAddResult | null = null;
const listeners = new Set<() => void>();

export function setRecipeAddResult(result: RecipeAddResult): void {
  pending = result;
  for (const listener of [...listeners]) listener();
}

/**
 * Tells a list screen that's already showing about a result set while it shows (an import's
 * notification tapped on that list, spec 4.10), since it won't gain focus to take it.
 */
export function onRecipeAddResult(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The result for this list, once: taking it clears it. A result for another list stays. */
export function takeRecipeAddResult(listId: string): RecipeAddResult | null {
  if (pending?.listId !== listId) return null;
  const result = pending;
  pending = null;
  return result;
}

// A recipe added from the add bar (spec 4.2) can be adjusted: its toast's Adjust opens the recipe's
// add sheet with a token, and the sheet's add replaces the add the token names. Only one at a time;
// a newer Adjust replaces it, and Cancel leaves the first add as it is.

export type AdjustableAdd = { listId: string; recipeId: string; results: (AddItemResult | null)[] };

let adjusting: { token: string; add: AdjustableAdd } | null = null;
let nextToken = 0;

/** Remembers the add to replace and returns the token to hand to the add sheet. */
export function startAdjust(add: AdjustableAdd): string {
  nextToken += 1;
  const token = String(nextToken);
  adjusting = { token, add };
  return token;
}

/**
 * The add this token names, once, if it's for this recipe: the sheet takes it as it adds (to any list; the old
 * add goes from its own list). A stale or missing token gives null, so the sheet adds without replacing anything.
 */
export function takeAdjust(token: string | undefined, recipeId: string): AdjustableAdd | null {
  if (!token || adjusting?.token !== token) return null;
  const { add } = adjusting;
  if (add.recipeId !== recipeId) return null;
  adjusting = null;
  return add;
}
