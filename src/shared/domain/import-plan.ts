// Saving an imported recipe (spec 4.10) as data (share-server-import plan §1, §5): the recipe and
// its ingredients when it's new, then its ingredients onto the list as a bulk add. The device runs
// `writes` through its sync helpers; the server's share import commits them. Pure.
import { stepTexts } from '../recipe-steps.ts';
import type { RecipeImportResponse } from '../schemas/recipe-import.ts';
import {
  planListAdds,
  type AddOutcome,
  type IdSource,
  type ListSnapshot,
  type Precondition,
  type UnitKnowledge,
  type WireValue,
  type Write,
} from './list-plan.ts';
import { positionBetween } from './position.ts';
import { importedStepIngredients, nameOf, servingsOf } from './recipe-import.ts';

export type RecipeImportPlanInput = {
  extracted: RecipeImportResponse;
  /** The household the recipe is saved to, and the list its ingredients go on (null: recipe-only). */
  target: { householdId: string; listId: string | null };
  /** The live recipe the import reuses (`findReusableRecipe`), or null to create one. */
  existingRecipe: { id: string; name: string } | null;
  /** The list's snapshot when `target.listId` is set, else null. */
  listSnapshot: ListSnapshot | null;
  unitKnowledge: UnitKnowledge;
  /** `recipe` 0 is the new recipe's id; `recipeIngredient` i its i-th ingredient's. */
  ids: IdSource;
  at: Date;
  userId: string | null;
};

export type RecipeImportPlan = {
  writes: Write[];
  preconditions: Precondition[];
  summary: {
    recipeId: string;
    recipeName: string;
    /** Whether the import creates the recipe (false: it reuses one). */
    created: boolean;
    /** The list the ingredients go on; null for a recipe-only import. */
    listId: string | null;
    /** One per ingredient added to the list (none for a recipe-only import). */
    results: (AddOutcome | null)[];
    added: number;
    combined: number;
  };
};

/**
 * Plans an import's save: a new recipe (its fields, its ingredients in order and the import's own
 * step match when it lines up) unless one is reused, then every ingredient onto the list at 1×,
 * with Combine. The import counts each ingredient's use once, through the list add: the recipe's
 * own ingredients count none, so a recipe-only import counts nothing.
 */
export function planRecipeImport(input: RecipeImportPlanInput): RecipeImportPlan {
  const { extracted, target, existingRecipe } = input;
  const writes: Write[] = [];
  const preconditions: Precondition[] = [];
  let recipeId: string;

  if (existingRecipe) {
    recipeId = existingRecipe.id;
    preconditions.push({ kind: 'recipeReuse', recipeId });
  } else {
    recipeId = input.ids('recipe', 0);
    preconditions.push({ kind: 'recipeAbsent', recipeId });
    const fields: Record<string, WireValue> = {
      household_id: target.householdId,
      name: nameOf(extracted),
      source_url: extracted.sourceUrl,
      total_minutes: extracted.totalMinutes,
      steps: stepTexts(extracted.steps).length > 0 ? (extracted.steps as WireValue) : null,
      servings: servingsOf(extracted.servings),
      image_url: extracted.imageUrl,
    };
    // Only a recipe this import creates; a reused one keeps its own (spec 4.14). Never `saved`.
    if (extracted.tags !== undefined) fields.tags = extracted.tags && { saved: [], ...extracted.tags };
    writes.push({ op: 'insert', table: 'recipes', id: recipeId, fields });

    const ingredientIds: string[] = [];
    let position = positionBetween(null, null);
    extracted.ingredients.forEach((i, index) => {
      const id = input.ids('recipeIngredient', index);
      ingredientIds.push(id);
      writes.push({
        op: 'insert',
        table: 'recipe_ingredients',
        id,
        fields: {
          recipe_id: recipeId,
          household_id: target.householdId,
          ingredient_name: i.ingredientName,
          display_name: i.displayName,
          quantity: i.quantity,
          unit: i.unit,
          note: i.note.trim() || null,
          position,
        },
      });
      position = positionBetween(position, null);
    });
    // The import's own step match makes the recipe's match fresh.
    const stepIngredients = importedStepIngredients(extracted, ingredientIds);
    if (stepIngredients) {
      writes.push({ op: 'update', table: 'recipes', id: recipeId, fields: { step_ingredients: stepIngredients as WireValue } });
    }
  }

  let results: (AddOutcome | null)[] = [];
  if (target.listId) {
    if (!input.listSnapshot) throw new Error('An import onto a list needs its snapshot');
    const list = planListAdds(
      input.listSnapshot,
      extracted.ingredients.map((i) => ({
        source: 'recipe' as const,
        recipeId,
        ingredientName: i.ingredientName,
        displayName: i.displayName,
        quantity: i.quantity,
        unit: i.unit,
      })),
      { userId: input.userId, at: input.at },
      input.unitKnowledge,
      input.ids,
    );
    writes.push(...list.writes);
    preconditions.push(...list.preconditions);
    results = list.results;
  }

  const added = results.filter((r) => r !== null);
  return {
    writes,
    preconditions,
    summary: {
      recipeId,
      recipeName: existingRecipe?.name ?? nameOf(extracted),
      created: !existingRecipe,
      listId: target.listId,
      results,
      added: added.length,
      combined: added.filter((r) => r.kind === 'combine').length,
    },
  };
}
