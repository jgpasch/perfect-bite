// match-recipe-steps (cook mode, spec 4.5): which ingredients each step of a recipe uses, from one
// model call. Pure logic with no store, so the eval and Deno tests run it with no database. The
// Edge Function (handler.ts: the plan, the off switch, the limits and the ids) wraps it.
import { MAX_RECIPE_INGREDIENTS, MAX_RECIPE_STEP_LENGTH, MAX_RECIPE_STEPS, SuggestRecipeTagsIngredientSchema } from '@shared/index.ts';
import { NoObjectGeneratedError, type LanguageModel } from 'ai';
import { z } from 'zod';

import { buildMatchRecipeStepsPrompt, MATCH_RECIPE_STEPS_PROMPT_VERSION, type StepMatchRecipe } from '../_shared/ai/prompts/match-recipe-steps.v1.ts';
import { runAiTask, type AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { cleanStepMatch, isAiEnabled, type StepMatch } from '../_shared/ai/tasks.ts';
import { isProviderFailure } from '../categorize-ingredients/handler.ts';

/** A step's text, trimmed and cut to the steps column's limit. */
const StepTextSchema = z.string().transform((s) => Array.from(s.trim()).slice(0, MAX_RECIPE_STEP_LENGTH).join('').trimEnd());

/**
 * The recipe to match: its steps (blank ones dropped, the first 100) and its live ingredients
 * (ones with an empty name dropped, the first 80), each as the tags request reads them.
 */
export const StepMatchRecipeSchema = z.object({
  steps: z
    .array(StepTextSchema)
    .transform((steps) => steps.filter((s) => s !== '').slice(0, MAX_RECIPE_STEPS))
    .refine((steps) => steps.length > 0, 'A recipe needs at least one step'),
  ingredients: z
    .array(SuggestRecipeTagsIngredientSchema)
    .transform((items) => items.filter((i) => i.name !== '').slice(0, MAX_RECIPE_INGREDIENTS))
    .refine((items) => items.length > 0, 'A recipe needs at least one ingredient'),
});

export type MatchDeps = {
  /** Tests inject a MockLanguageModelV4; otherwise the task's env model. */
  model?: { instance: LanguageModel; modelId: string };
  /** Called once per model attempt (`ai_calls` in the function, a list in the CLI and eval). */
  onCall?: (call: AiCallRecord) => Promise<void>;
};

export type MatchResult = { steps: StepMatch; promptVersion: string };

export class StepMatchError extends Error {
  override name = 'StepMatchError';
  constructor(
    readonly reason: 'ai_off' | 'ai_failed' | 'steps_mismatch',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Matches one recipe. Throws `StepMatchError` when matching is off, the model fails or answers
 * badly, or its steps don't line up with the recipe's (all `unavailable` to a caller).
 */
export async function matchRecipeSteps(recipe: StepMatchRecipe, deps: MatchDeps = {}): Promise<MatchResult> {
  if (!deps.model && !isAiEnabled('matchRecipeSteps')) {
    throw new StepMatchError('ai_off', 'Step matching is turned off');
  }
  let output;
  try {
    ({ output } = await runAiTask('matchRecipeSteps', buildMatchRecipeStepsPrompt(recipe), { model: deps.model, onCall: deps.onCall }));
  } catch (err) {
    const invalid = NoObjectGeneratedError.isInstance(err);
    if (!invalid && !isProviderFailure(err)) throw err;
    throw new StepMatchError('ai_failed', `Step matching failed: ${invalid ? 'invalid output' : 'provider error or timeout'}`);
  }
  const steps = cleanStepMatch(output, recipe);
  if (steps === null) throw new StepMatchError('steps_mismatch', "Step matching failed: the answer's steps don't match the recipe's");
  return { steps, promptVersion: MATCH_RECIPE_STEPS_PROMPT_VERSION };
}
