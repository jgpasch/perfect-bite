// Saving an imported recipe (spec 4.10): the pure rules, shared by the device's import and the
// server's share import.
import { stepTexts } from '../recipe-steps.ts';
import { canonicalRecipeUrl, type RecipeImportResponse } from '../schemas/recipe-import.ts';
import { stepIngredientsBasis, type StepIngredients } from '../step-ingredients.ts';

/**
 * The namespace import ids are hashed under (UUIDv5), so an import id always gives the same recipe
 * id: on the device, and for a share imported on the server (whose import id is the envelope id).
 */
export const IMPORT_ID_NAMESPACE = '6f3b2a91-4c7e-4d1a-9b8e-2a5c7d0e4f13';

/** `recipes.servings`: a whole number from 1 to 100, else null. */
export function servingsOf(servings: number | null): number | null {
  return servings !== null && Number.isInteger(servings) && servings >= 1 && servings <= 100 ? servings : null;
}

/** The recipe's name, or its site's host when the page gave none ("Recipe" without a link). */
export function nameOf(imported: Pick<RecipeImportResponse, 'name' | 'sourceUrl'>): string {
  const name = imported.name.trim().replace(/\s+/g, ' ');
  if (name) return name;
  if (imported.sourceUrl === null) return 'Recipe';
  try {
    return new URL(imported.sourceUrl).hostname;
  } catch {
    return 'Recipe';
  }
}

/**
 * The response's step match (indexes into its ingredients) as `recipes.step_ingredients` for the
 * recipe the import just created, whose ingredients (`ingredientIds`, by position) are the
 * response's in the same order. Null when there's none, or it doesn't line up with the saved steps
 * and ingredients: the recipe stays unmatched, to be matched later.
 */
export function importedStepIngredients(
  imported: Pick<RecipeImportResponse, 'steps' | 'stepIngredients' | 'ingredients'>,
  ingredientIds: readonly string[],
): StepIngredients | null {
  const match = imported.stepIngredients;
  // One entry per step string: headings aren't steps.
  const stepCount = stepTexts(imported.steps).length;
  if (!match || stepCount === 0 || match.length !== stepCount) return null;
  if (ingredientIds.length !== imported.ingredients.length) return null;
  if (match.some((uses) => uses.some((use) => use.index >= ingredientIds.length))) return null;
  return {
    v: 1,
    basis: stepIngredientsBasis(imported.steps, ingredientIds),
    steps: match.map((uses) => uses.map((use) => ({ id: ingredientIds[use.index], quantity: use.quantity }))),
  };
}

/** A recipe an import could reuse. */
export type ReuseCandidate = {
  id: string;
  name: string;
  householdId: string;
  sourceUrl: string | null;
  deletedAt: Date | string | null;
};

/**
 * The recipe an import reuses instead of creating one: the live recipe an earlier run of the same
 * import created (`importRecipeId`, the id its import id maps to), else the first live one in
 * `householdId` whose source URL canonicalizes to `sourceUrl` (already canonical). A photo import
 * has no URL, so it only ever finds its own earlier run.
 */
export function findReusableRecipe(
  candidates: readonly ReuseCandidate[],
  target: { householdId: string; sourceUrl: string | null; importRecipeId?: string },
): { id: string; name: string } | undefined {
  const live = candidates.filter((r) => r.deletedAt === null);
  const own = target.importRecipeId === undefined ? undefined : live.find((r) => r.id === target.importRecipeId);
  const found =
    own ??
    (target.sourceUrl === null
      ? undefined
      : live.find(
          (r) =>
            r.householdId === target.householdId &&
            r.sourceUrl !== null &&
            canonicalRecipeUrl(r.sourceUrl) === target.sourceUrl,
        ));
  return found && { id: found.id, name: found.name };
}
