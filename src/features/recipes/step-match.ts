import { stepIngredientsBasis, stepTexts, type RecipeStepEntry, type StepIngredients } from '@/shared';

/** An ingredient's use in one step: `quantity` is the step's share, null = all of it or not stated. */
export type StepUse<I> = { ingredient: I; quantity: number | null };

export type StepMatch<I> = {
  /** `none`: never matched. `stale`: the steps or ingredients changed since; still shown. */
  state: 'none' | 'fresh' | 'stale';
  /** One entry per recipe step (`stepTexts`: headings aren't steps): its live ingredients, in the recipe's ingredient order. */
  steps: StepUse<I>[][];
  /** Live ingredients in no step, in the recipe's ingredient order. */
  unplaced: I[];
};

type MatchIngredient = { id: string; position: number; deletedAt?: Date | null };

/**
 * The recipe's saved step match (spec 4.5) against its current ingredients. Deleted or unknown ids
 * are dropped, so a stale match still lines up with what the recipe has now.
 */
export function stepMatch<I extends MatchIngredient>(
  recipe: { steps: readonly RecipeStepEntry[] | null; stepIngredients: StepIngredients | null },
  ingredients: readonly I[],
): StepMatch<I> {
  const live = ingredients
    .map((ingredient, index) => ({ ingredient, index }))
    .filter(({ ingredient }) => ingredient.deletedAt == null)
    .sort((a, b) => a.ingredient.position - b.ingredient.position || a.index - b.index)
    .map(({ ingredient }) => ingredient);
  const steps = stepTexts(recipe.steps);
  const match = recipe.stepIngredients;
  if (!match) return { state: 'none', steps: steps.map(() => []), unplaced: live };

  const placed = new Set<string>();
  const matched = steps.map((_, i) => {
    const shares = new Map<string, number | null>();
    for (const use of match.steps[i] ?? []) if (!shares.has(use.id)) shares.set(use.id, use.quantity);
    return live
      .filter((ingredient) => shares.has(ingredient.id))
      .map((ingredient) => {
        placed.add(ingredient.id);
        return { ingredient, quantity: shares.get(ingredient.id) ?? null };
      });
  });
  const basis = stepIngredientsBasis(steps, live.map((ingredient) => ingredient.id));
  return {
    state: match.basis === basis ? 'fresh' : 'stale',
    steps: matched,
    unplaced: live.filter((ingredient) => !placed.has(ingredient.id)),
  };
}
