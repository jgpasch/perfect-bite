// import-recipe-photo (spec 6.10): pure logic behind a store interface, so it runs in Deno tests
// with a fake store and MockLanguageModelV4. index.ts wires the real store.
import type { RecipeImportResponse, RecipePhotoImportRequest } from '@shared/index.ts';
import { NoObjectGeneratedError, type LanguageModel } from 'ai';

import { buildExtractRecipePhotoPrompt } from '../_shared/ai/prompts/extract-recipe-photo.v3.ts';
import { runAiTask, type AiCaller, type AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { cleanExtractedRecipe, isAiEnabled } from '../_shared/ai/tasks.ts';
import { NotEntitledError, type Feature } from '../_shared/entitlements.ts';
import { isProviderFailure, type LimitResult } from '../categorize-ingredients/handler.ts';
import { callerIn, importResponse, type ImportDeps } from '../import-recipe/handler.ts';

/** The tables import-recipe-photo uses, as it sees them. index.ts implements it with the service role. */
export interface RecipePhotoImportStore {
  /**
   * Throws NotEntitledError unless the plan of `householdId` (the household the recipe is saved to)
   * has `feature` and the caller is in it (`requireFeature` in `_shared/entitlements.ts`). Called
   * first, before the kill switch, the rate limit or the model.
   */
  requireFeature(feature: Feature, householdId: string): Promise<void>;
  /**
   * Counts one photo import against the per-user safety limits (per minute, daily) and the monthly
   * `recipe_import` allowance of `householdId`, shared with link imports
   * (`public.check_recipe_photo_limit`).
   */
  checkLimit(householdId: string): Promise<LimitResult>;
  /** Writes one `ai_calls` row. Its prompt describes each image; it never holds the bytes. */
  logAiCall(call: AiCallRecord): Promise<void>;
}

/** What `extractRecipePhotoForImport` needs: with no plan check or limit, the store only logs. */
export type PhotoExtractDeps = Omit<PhotoImportDeps, 'store'> & { store: Pick<RecipePhotoImportStore, 'logAiCall'> };

export type PhotoImportDeps = {
  store: RecipePhotoImportStore;
  /** The shared `categorize()`, bound to its own store and the caller's limits. */
  categorize: ImportDeps['categorize'];
  /** Tests inject a MockLanguageModelV4 for extract-recipe-photo; otherwise the task's env model. */
  model?: { instance: LanguageModel; modelId: string };
  /** The signed-in caller, recorded on each `ai_calls` row with the request's `householdId`. */
  caller?: AiCaller;
};

/** Why a photo import failed; request.ts turns it into the HTTP status. */
export type PhotoImportFailure =
  | { code: 'not_entitled' }
  | { code: 'not_a_recipe' }
  | { code: 'rate_limited' }
  | { code: 'daily_limit' }
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
 * limits, then `extractRecipePhotoForImport`. Throws `ImportRecipePhotoError` for every expected
 * failure. Nothing is cached, and the images are written nowhere.
 */
export async function importRecipePhoto(request: RecipePhotoImportRequest, deps: PhotoImportDeps): Promise<RecipeImportResponse> {
  try {
    // Link and photo imports share `recipe_import` (spec 4.12).
    // A household the caller isn't in is refused here too.
    await deps.store.requireFeature('recipe_import', request.householdId);
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

  const limit = await deps.store.checkLimit(request.householdId);
  if (limit === 'user_limit') throw new ImportRecipePhotoError({ code: 'rate_limited' }, 'Too many photo imports; try again later');
  // The day's link and photo imports together (`recipe_import`'s safety row), and the month's
  // (the household's `recipe_import`).
  if (limit === 'daily_limit') throw new ImportRecipePhotoError({ code: 'daily_limit' }, "Today's recipe imports are used up");
  if (limit === 'monthly_limit') throw new ImportRecipePhotoError({ code: 'limit_reached' }, "This month's recipe imports are used up");

  return extractRecipePhotoForImport(request.images, request.householdId, deps);
}

/**
 * The extraction half of a photo import (spec 6.10), after the plan check and the limit: the kill
 * switch, one extract-recipe-photo call, then the same cleaning, categorize step and response as a
 * link import, with no source URL and no photo. `importRecipePhoto` calls it for in-app photos;
 * `share-import-worker` (6.12) calls it with a photo share's pages after `requireFeature` and
 * `reserve_share_import` have checked and counted the import. Throws `ImportRecipePhotoError`
 * (`unavailable`, `not_a_recipe`) for every expected failure.
 */
export async function extractRecipePhotoForImport(
  images: RecipePhotoImportRequest['images'],
  householdId: string,
  deps: PhotoExtractDeps,
): Promise<RecipeImportResponse> {
  // `importRecipePhoto` checked it before its limit too; the worker checks it here.
  if (!isAiEnabled('extractRecipePhoto')) {
    throw new ImportRecipePhotoError({ code: 'unavailable', reason: 'ai_off' }, 'Photo import is turned off');
  }
  const caller = callerIn(deps.caller, householdId);

  let output;
  try {
    ({ output } = await runAiTask('extractRecipePhoto', await buildExtractRecipePhotoPrompt(images), {
      model: deps.model,
      caller,
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
  return importResponse(recipe, null, (names) => deps.categorize(names, caller));
}
