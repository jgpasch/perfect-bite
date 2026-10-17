// recipe-photos (spec 6.9): the photos on a recipe's page, for the Choose a photo sheet (spec 4.5).
// Behind a store interface, so it runs in Deno tests with a fake store and a fake fetch. index.ts
// wires the real store. No AI call and no plan feature.
import { canonicalRecipeUrl, type RecipePhotosRequest, type RecipePhotosResponse } from '@shared/index.ts';

import { FetchPageError, type FetchedPage } from '../_shared/fetch-page.ts';
import type { LimitResult } from '../categorize-ingredients/handler.ts';

/** What recipe-photos uses, as it sees it. index.ts implements it with the service role. */
export interface RecipePhotosStore {
  /** Counts one request against the per-user and global limits (`public.check_recipe_photos_limit`). */
  checkLimit(): Promise<LimitResult>;
}

export type RecipePhotosDeps = {
  store: RecipePhotosStore;
  /** `fetchPage` from `_shared/fetch-page.ts`; tests inject one with a fake resolver and fetch. */
  fetchPage: (url: string) => Promise<FetchedPage>;
};

/** Why it failed; request.ts turns it into the HTTP status. */
export type RecipePhotosFailure =
  | { code: 'invalid_url' }
  | { code: 'fetch_failed' }
  | { code: 'rate_limited' }
  | { code: 'unavailable'; reason: 'global_cap' };

export class RecipePhotosError extends Error {
  override name = 'RecipePhotosError';
  constructor(
    readonly failure: RecipePhotosFailure,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The page's photos, best first (`readImageCandidates`, at most 12), fetched with `fetchPage`'s
 * rules. The URL is checked before the limits, so a bad one uses no budget; a blocked address (or
 * a redirect to one) is `invalid_url`, as in import-recipe, and every other fetch failure
 * `fetch_failed`. Nothing is cached or stored.
 */
export async function recipePhotos(request: RecipePhotosRequest, deps: RecipePhotosDeps): Promise<RecipePhotosResponse> {
  if (!canonicalRecipeUrl(request.url)) throw new RecipePhotosError({ code: 'invalid_url' }, 'Not an http(s) URL');

  const limit = await deps.store.checkLimit();
  if (limit === 'user_limit') throw new RecipePhotosError({ code: 'rate_limited' }, 'Too many requests; try again later');
  if (limit === 'global_cap') {
    throw new RecipePhotosError({ code: 'unavailable', reason: 'global_cap' }, 'Page photos are paused for now');
  }

  try {
    const page = await deps.fetchPage(request.url.trim());
    return { images: page.imageCandidates };
  } catch (err) {
    if (!(err instanceof FetchPageError)) throw err;
    if (err.reason === 'invalid_url' || err.reason === 'blocked_address') {
      throw new RecipePhotosError({ code: 'invalid_url' }, err.message);
    }
    throw new RecipePhotosError({ code: 'fetch_failed' }, err.message);
  }
}
