// suggest-recipe-tags (spec 6.7): pure logic behind a store interface, so it runs in Deno tests
// with a fake store and MockLanguageModelV4. index.ts wires the real store.
import type { SuggestRecipeTagsRequest, SuggestRecipeTagsResponse } from '@shared/index.ts';
import { NoObjectGeneratedError, type LanguageModel } from 'ai';

import { buildSuggestRecipeTagsPrompt, SUGGEST_RECIPE_TAGS_PROMPT_VERSION } from '../_shared/ai/prompts/suggest-recipe-tags.v1.ts';
import { runAiTask, type AiCaller, type AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { cleanSuggestedTags, isAiEnabled } from '../_shared/ai/tasks.ts';
import { isProviderFailure, type LimitResult } from '../categorize-ingredients/handler.ts';

/** The tables suggest-recipe-tags uses, as it sees them. index.ts implements it with the service role. */
export interface SuggestTagsStore {
  /** Counts one suggestion against the per-user limits (`public.check_recipe_tags_limit`). */
  checkLimit(): Promise<LimitResult>;
  /** Writes one `ai_calls` row. */
  logAiCall(call: AiCallRecord): Promise<void>;
}

export type SuggestDeps = {
  store: SuggestTagsStore;
  /** Tests inject a MockLanguageModelV4; otherwise the task's env model. */
  model?: { instance: LanguageModel; modelId: string };
  /** The signed-in caller, recorded on each `ai_calls` row. */
  caller?: AiCaller;
};

/** Why a suggestion failed; request.ts turns it into the HTTP status. */
export type SuggestFailure =
  | { code: 'rate_limited' }
  | { code: 'limit_reached' }
  | { code: 'unavailable'; reason: 'ai_off' | 'ai_failed' };

export class SuggestTagsError extends Error {
  override name = 'SuggestTagsError';
  constructor(
    readonly failure: SuggestFailure,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Suggests tags for one recipe (spec 6.7): the limits, then one model call. Tag suggestions aren't
 * a plan feature (spec 4.12), so there's no plan check. Throws `SuggestTagsError` for every
 * expected failure. Nothing is cached and nothing is written but the usage counters and `ai_calls`.
 */
export async function suggestRecipeTags(request: SuggestRecipeTagsRequest, deps: SuggestDeps): Promise<SuggestRecipeTagsResponse> {
  // Before the limit, so a call refused by the kill switch uses no budget.
  if (!isAiEnabled('suggestRecipeTags')) {
    throw new SuggestTagsError({ code: 'unavailable', reason: 'ai_off' }, 'Tag suggestions are turned off');
  }

  const limit = await deps.store.checkLimit();
  if (limit === 'user_limit') throw new SuggestTagsError({ code: 'rate_limited' }, 'Too many tag suggestions; try again later');
  if (limit === 'monthly_limit') throw new SuggestTagsError({ code: 'limit_reached' }, "This month's tag suggestions are used up");

  let output;
  try {
    ({ output } = await runAiTask('suggestRecipeTags', buildSuggestRecipeTagsPrompt(request), {
      model: deps.model,
      caller: deps.caller,
      onCall: (call) => deps.store.logAiCall(call),
    }));
  } catch (err) {
    const invalid = NoObjectGeneratedError.isInstance(err);
    if (!invalid && !isProviderFailure(err)) throw err;
    const what = invalid ? 'invalid output' : 'provider error or timeout';
    throw new SuggestTagsError({ code: 'unavailable', reason: 'ai_failed' }, `Tag suggestion failed: ${what}`);
  }
  return { tags: cleanSuggestedTags(output), promptVersion: SUGGEST_RECIPE_TAGS_PROMPT_VERSION };
}
