// photo-search (spec 6.11): free stock photos from Pexels for the Choose a photo sheet (spec 4.5).
// Behind a store interface and an injected Pexels search, so it runs in Deno tests with fakes.
// index.ts wires the real ones. No AI call and no plan feature.
import { photoSearchKey, type PhotoSearchRequest, type PhotoSearchResponse } from '@shared/index.ts';

import type { LimitResult } from '../categorize-ingredients/handler.ts';
import { PexelsError } from './pexels.ts';

/** What photo-search uses, as it sees it. index.ts implements it with the service role. */
export interface PhotoSearchStore {
  /**
   * Counts one search against the per-user limits and, unless `cached`, the global cap
   * (`public.check_photo_search_limit`).
   */
  checkLimit(cached: boolean): Promise<LimitResult>;
  /** The answer saved for this key and page in the last 24 hours, or null. */
  getCached(queryKey: string, page: number): Promise<PhotoSearchResponse | null>;
  saveCached(queryKey: string, page: number, answer: PhotoSearchResponse): Promise<void>;
}

export type PhotoSearchDeps = {
  store: PhotoSearchStore;
  /** `searchPexels` bound to the key; null when `PEXELS_API_KEY` isn't set. */
  searchPexels: ((query: string, page: number) => Promise<PhotoSearchResponse>) | null;
};

/** Why it failed; request.ts turns it into the HTTP status. */
export type PhotoSearchFailure =
  | { code: 'rate_limited' }
  | { code: 'unavailable'; reason: 'no_key' | 'global_cap' | 'pexels_rate_limited' }
  | { code: 'search_failed' };

export class PhotoSearchError extends Error {
  override name = 'PhotoSearchError';
  constructor(
    readonly failure: PhotoSearchFailure,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One page of stock photos for the query. Without a key it's `unavailable` before anything is
 * read or counted. A cached answer (24 hours, by `photoSearchKey` and page) still counts against
 * the user's limits but not the global cap, and doesn't call Pexels. A fresh answer is cached,
 * empty ones included; a failure to save it doesn't fail the search.
 */
export async function photoSearch(request: PhotoSearchRequest, deps: PhotoSearchDeps): Promise<PhotoSearchResponse> {
  if (!deps.searchPexels) {
    throw new PhotoSearchError({ code: 'unavailable', reason: 'no_key' }, 'Photo search is not set up');
  }

  const key = photoSearchKey(request.query);
  const cached = await deps.store.getCached(key, request.page);

  const limit = await deps.store.checkLimit(cached !== null);
  if (limit === 'user_limit') throw new PhotoSearchError({ code: 'rate_limited' }, 'Too many searches; try again later');
  if (limit === 'global_cap') {
    throw new PhotoSearchError({ code: 'unavailable', reason: 'global_cap' }, 'Photo search is paused for now');
  }
  if (cached) return cached;

  let answer: PhotoSearchResponse;
  try {
    answer = await deps.searchPexels(key, request.page);
  } catch (err) {
    if (!(err instanceof PexelsError)) throw err;
    if (err.reason === 'rate_limited') {
      throw new PhotoSearchError({ code: 'unavailable', reason: 'pexels_rate_limited' }, 'Photo search is paused for now');
    }
    throw new PhotoSearchError({ code: 'search_failed' }, err.message);
  }

  try {
    await deps.store.saveCached(key, request.page, answer);
  } catch (err) {
    console.error('photo-search: caching failed:', err instanceof Error ? err.message : String(err));
  }
  return answer;
}
