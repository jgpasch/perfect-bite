// A recipe-only import from the in-app sheet (spec 4.10) hands its result to the Recipes tab, which
// shows "Saved Chicken tikka masala" with Undo and View recipe: the sheet stores it as it closes, and
// the tab takes it when it gains focus (or at once, if it's showing). From a list's menu the list
// screen shows it instead (`recipe-add-result.ts`).

export type SavedRecipeResult = { recipeId: string; recipeName: string; created: boolean; undo: () => void };

let pending: SavedRecipeResult | null = null;
const listeners = new Set<() => void>();

export function setSavedRecipeResult(result: SavedRecipeResult): void {
  pending = result;
  for (const listener of [...listeners]) listener();
}

/** Tells a Recipes tab that's already showing about a result set while it shows. */
export function onSavedRecipeResult(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The pending result, once: taking it clears it. */
export function takeSavedRecipeResult(): SavedRecipeResult | null {
  const result = pending;
  pending = null;
  return result;
}
