// Spec 4.5, 5. Which ingredients each method step uses, saved on the recipe as
// `recipes.step_ingredients` and synced. `basis` records what the match was made from, so the app
// can tell when the steps or ingredients have changed since (a stale match is still shown).
import { stepTexts, type RecipeStepEntry } from './recipe-steps.ts';

/** One use of an ingredient in a step. `quantity` is the step's share in the ingredient's own unit; null = all of it or not stated. */
export type StepIngredientUse = { id: string; quantity: number | null };

/** `recipes.step_ingredients`: one entry per step. Null on the recipe = never matched. */
export type StepIngredients = { v: 1; basis: string; steps: StepIngredientUse[][] };

/** cyrb53: a fast 53-bit string hash. Not cryptographic; it only has to notice a change. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * A stable hash of the step texts (`stepTexts`, in order: headings don't count, so editing one
 * leaves the match fresh) and the live ingredient ids (in any order: they're sorted). A match whose
 * basis differs from the recipe's current one is stale.
 */
export function stepIngredientsBasis(steps: readonly RecipeStepEntry[] | null | undefined, liveIngredientIds: readonly string[]): string {
  const ids = [...liveIngredientIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return hash53(JSON.stringify([stepTexts(steps), ids]));
}
