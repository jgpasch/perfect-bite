// match-recipe-steps (cook mode, spec 4.5): which ingredients each step of a recipe uses, from one
// model call. Pure logic with no store, so the eval and Deno tests run it with no database. The
// Edge Function (handler.ts: the plan, the off switch, the limits and the ids) wraps it.
import { NoObjectGeneratedError, type LanguageModel } from 'ai';

import { buildMatchRecipeStepsPrompt, MATCH_RECIPE_STEPS_PROMPT_VERSION, type StepMatchRecipe } from '../_shared/ai/prompts/match-recipe-steps.v1.ts';
import { runAiTask, type AiCaller, type AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { cleanStepMatch, isAiEnabled, type StepMatch } from '../_shared/ai/tasks.ts';
import { isProviderFailure } from '../categorize-ingredients/handler.ts';

export type MatchDeps = {
  /** Tests inject a MockLanguageModelV4; otherwise the task's env model. */
  model?: { instance: LanguageModel; modelId: string };
  /** Called once per model attempt (`ai_calls` in the function, a list in the CLI and eval). */
  onCall?: (call: AiCallRecord) => Promise<void>;
  /** The signed-in caller, recorded on each `ai_calls` row; none in the CLI and eval. */
  caller?: AiCaller;
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
    ({ output } = await runAiTask('matchRecipeSteps', buildMatchRecipeStepsPrompt(recipe), { model: deps.model, onCall: deps.onCall, caller: deps.caller }));
  } catch (err) {
    const invalid = NoObjectGeneratedError.isInstance(err);
    if (!invalid && !isProviderFailure(err)) throw err;
    throw new StepMatchError('ai_failed', `Step matching failed: ${invalid ? 'invalid output' : 'provider error or timeout'}`);
  }
  const steps = cleanStepMatch(output, recipe);
  if (steps === null) throw new StepMatchError('steps_mismatch', "Step matching failed: the answer's steps don't match the recipe's");
  return { steps, promptVersion: MATCH_RECIPE_STEPS_PROMPT_VERSION };
}
