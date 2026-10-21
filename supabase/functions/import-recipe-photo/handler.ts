// import-recipe-photo (spec 6.10): pure logic behind a store interface, so it runs in Deno tests
// with a fake store and MockLanguageModelV4. index.ts wires the real store.
import type { RecipeImportResponse, RecipePhotoImportRequest } from '@shared/index.ts';
import { NoObjectGeneratedError, type LanguageModel } from 'ai';

import { buildExtractRecipePhotoPrompt } from '../_shared/ai/prompts/extract-recipe-photo.v3.ts';
import { runAiTask, type AiCaller, type AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { cleanExtractedRecipe, isAiEnabled } from '../_shared/ai/tasks.ts';
import { NotEntitledError, type Feature } from '../_shared/entitlements.ts';
import { isProviderFailure, type LimitResult } from '../categorize-ingredients/handler.ts';
import { importResponse, type ImportDeps } from '../import-recipe/handler.ts';

/** The tables import-recipe-photo uses, as it sees them. index.ts implements it with the service role. */
export interface RecipePhotoImportStore {
  /**
   * Throws NotEntitledError unless the caller's plan has `feature` (`requireFeature` in
   * `_shared/entitlements.ts`). Called first, before the kill switch, the rate limit or the model.
   */
  requireFeature(feature: Feature): Promise<void>;
  /** Counts one photo import against the per-user limits (`public.check_recipe_photo_limit`): per minute and monthly. */
  checkLimit(): Promise<LimitResult>;
  /** Writes one `ai_calls` row. Its prompt describes each image; it never holds the bytes. */
  logAiCall(call: AiCallRecord): Promise<void>;
}

export type PhotoImportDeps = {
  store: RecipePhotoImportStore;
  /** The shared `categorize()`, bound to its own store and the caller's limits. */
  categorize: ImportDeps['categorize'];
  /** Tests inject a MockLanguageModelV4 for extract-recipe-photo; otherwise the task's env model. */
  model?: { instance: LanguageModel; modelId: string };
  /** The signed-in caller, recorded on each `ai_calls` row. */
  caller?: AiCaller;
};

/** Why a photo import failed; request.ts turns it into the HTTP status. */
export type PhotoImportFailure =
  | { code: 'not_entitled' }
  | { code: 'not_a_recipe' }
  | { code: 'rate_limited' }
  | { code: 'limit_reached' }
  | { code: 'unavailable'; reason: 'ai_off' | 'ai_failed' };

export class ImportRecipePhotoError extends Error {
  override name = 'ImportRecipePhotoError';
  constructor(
    readonly failure: PhotoImportFailure,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Imports one recipe from 1 to 3 photos of its pages (spec 6.10): the plan, the kill switch, the
 * limits, one extract-recipe-photo call, then the same cleaning, categorize step and response as a
 * link import, with no source URL and no photo. Throws `ImportRecipePhotoError` for every expected
 * failure. Nothing is cached, and the images are written nowhere.
 */
export async function importRecipePhoto(request: RecipePhotoImportRequest, deps: PhotoImportDeps): Promise<RecipeImportResponse> {
  try {
    // Link and photo imports share `recipe_import` (spec 4.12).
    await deps.store.requireFeature('recipe_import');
  } catch (err) {
    if (err instanceof NotEntitledError) {
      throw new ImportRecipePhotoError({ code: 'not_entitled' }, "Photo import isn't included in your plan");
    }
    throw err;
  }

  // Before the limit, so a call refused by the kill switch uses no budget.
  if (!isAiEnabled('extractRecipePhoto')) {
    throw new ImportRecipePhotoError({ code: 'unavailable', reason: 'ai_off' }, 'Photo import is turned off');
  }

  const limit = await deps.store.checkLimit();
  if (limit === 'user_limit') throw new ImportRecipePhotoError({ code: 'rate_limited' }, 'Too many photo imports; try again later');
  if (limit === 'monthly_limit') throw new ImportRecipePhotoError({ code: 'limit_reached' }, "This month's photo imports are used up");

  let output;
  try {
    ({ output } = await runAiTask('extractRecipePhoto', await buildExtractRecipePhotoPrompt(request.images), {
      model: deps.model,
      caller: deps.caller,
      onCall: (call) => deps.store.logAiCall(call),
    }));
  } catch (err) {
    const invalid = NoObjectGeneratedError.isInstance(err);
    if (!invalid && !isProviderFailure(err)) throw err;
    const what = invalid ? 'invalid output' : 'provider error or timeout';
    throw new ImportRecipePhotoError({ code: 'unavailable', reason: 'ai_failed' }, `Photo extraction failed: ${what}`);
  }

  // The model's own steps, as from page text; `image_url` is always null (the model never sets it).
  const recipe = cleanExtractedRecipe(output);
  if (!recipe.is_recipe) throw new ImportRecipePhotoError({ code: 'not_a_recipe' }, "That photo doesn't look like a recipe");
  return importResponse(recipe, null, deps.categorize);
}
