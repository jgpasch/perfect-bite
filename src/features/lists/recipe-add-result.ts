// The Add to recipe sheet (spec 4.5) hands its result back to the list screen under it: the sheet
// stores it as it closes, and the list screen takes it when it regains focus to leave Select mode,
// switch to By recipe and show the "Added 3 items to Tacos" toast.

export type RecipeAddResult = { listId: string; recipeId: string; recipeName: string; count: number };

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
