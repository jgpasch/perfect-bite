// match-recipe-steps (spec 6.8): the plan, the off switch and the limits around matchRecipeSteps(),
// behind a store interface, so it runs in Deno tests with a fake store and MockLanguageModelV4.
// index.ts wires the real store.
import type { MatchRecipeStepsRequest, MatchRecipeStepsResponse } from '@shared/index.ts';

import type { AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { isAiEnabled } from '../_shared/ai/tasks.ts';
import { NotEntitledError, type Feature } from '../_shared/entitlements.ts';
import type { LimitResult } from '../categorize-ingredients/handler.ts';
import { matchRecipeSteps, StepMatchError, type MatchDeps } from './match.ts';

/** The tables match-recipe-steps uses, as it sees them. index.ts implements it with the service role. */
export interface StepMatchStore {
  /**
   * Throws NotEntitledError unless the caller's plan has `feature` (`requireFeature` in
   * `_shared/entitlements.ts`). Called first, before the rate limit or the model.
   */
  requireFeature(feature: Feature): Promise<void>;
  /** Counts one match against the per-user limits (`public.check_step_match_limit`). */
  checkLimit(): Promise<LimitResult>;
  /** Writes one `ai_calls` row. */
  logAiCall(call: AiCallRecord): Promise<void>;
}

export type MatchStepsDeps = {
  store: StepMatchStore;
  /** Tests inject a MockLanguageModelV4; otherwise the task's env model. */
  model?: MatchDeps['model'];
};

/** Why a match failed; request.ts turns it into the HTTP status. */
export type MatchStepsFailure =
  | { code: 'not_entitled' }
  | { code: 'rate_limited' }
  | { code: 'limit_reached' }
  | { code: 'unavailable'; reason: 'ai_off' | 'ai_failed' };

export class MatchStepsError extends Error {
  override name = 'MatchStepsError';
  constructor(
    readonly failure: MatchStepsFailure,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Matches one recipe's ingredients to its steps (spec 6.8): the plan, the off switch, the limits,
 * then one model call. Blank steps aren't sent and use nothing; the model's ingredient numbers are
 * mapped back to the request's ids. Throws `MatchStepsError` for every expected failure. Nothing is
 * cached and nothing is written but the usage counters and `ai_calls`.
 */
export async function matchSteps(request: MatchRecipeStepsRequest, deps: MatchStepsDeps): Promise<MatchRecipeStepsResponse> {
  try {
    await deps.store.requireFeature('step_ingredients');
  } catch (err) {
    if (err instanceof NotEntitledError) {
      throw new MatchStepsError({ code: 'not_entitled' }, "Step ingredients aren't included in your plan");
    }
    throw err;
  }

  // Before the limit, so a call refused by the off switch uses no budget.
  if (!isAiEnabled('matchRecipeSteps')) {
    throw new MatchStepsError({ code: 'unavailable', reason: 'ai_off' }, 'Step matching is turned off');
  }

  const limit = await deps.store.checkLimit();
  if (limit === 'user_limit') throw new MatchStepsError({ code: 'rate_limited' }, 'Too many step matches; try again later');
  if (limit === 'monthly_limit') throw new MatchStepsError({ code: 'limit_reached' }, "This month's step matches are used up");

  const sent = request.steps.flatMap((text, i) => (text === '' ? [] : [i]));
  let result;
  try {
    result = await matchRecipeSteps(
      { steps: sent.map((i) => request.steps[i]), ingredients: request.ingredients },
      { model: deps.model, onCall: (call) => deps.store.logAiCall(call) },
    );
  } catch (err) {
    if (!(err instanceof StepMatchError)) throw err;
    const reason = err.reason === 'ai_off' ? 'ai_off' : 'ai_failed';
    throw new MatchStepsError({ code: 'unavailable', reason }, err.message);
  }

  const steps: MatchRecipeStepsResponse['steps'] = request.steps.map(() => []);
  sent.forEach((stepIndex, k) => {
    steps[stepIndex] = result.steps[k].map((use) => ({ id: request.ingredients[use.ingredient].id, quantity: use.quantity }));
  });
  return { steps, promptVersion: result.promptVersion };
}
