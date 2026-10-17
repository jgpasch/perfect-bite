// What photo-search needs from a stock photo service (spec 6.11). Each service is one file in this
// folder that implements PhotoProvider; index.ts picks one with PHOTO_SEARCH_PROVIDER. Nothing
// outside this folder knows which service it is: the answer names it (`info`), and the app shows
// that name in the sheet and the photo's credit.
import type { PhotoProviderInfo, PhotoSearchResult } from '@shared/index.ts';

/** How long a search may take before it counts as failed. */
export const PROVIDER_TIMEOUT_MS = 8_000;

export class PhotoProviderError extends Error {
  override name = 'PhotoProviderError';
  constructor(
    /** `rate_limited`: the service answered 429 (our quota is used up). `failed`: anything else. */
    readonly reason: 'rate_limited' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

/** One page of a provider's answer, already mapped and filtered. */
export type ProviderPage = { photos: PhotoSearchResult[]; hasMore: boolean };

export interface PhotoProvider {
  /** Part of the cache key, so switching provider never serves another's answers. */
  readonly id: string;
  /** Who the app credits for the photos. */
  readonly info: PhotoProviderInfo;
  /**
   * One page of landscape photos for `query` (already normalised) in `lang`. Throws
   * PhotoProviderError: `rate_limited` on the service's 429, `failed` for anything else (another
   * status, a network error, a bad body, no answer within PROVIDER_TIMEOUT_MS).
   */
  search(query: string, page: number, lang: string): Promise<ProviderPage>;
}

/** What every provider takes: its key, and for tests a fake service and a shorter timeout. */
export type ProviderOptions = {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/**
 * GETs `url` and returns its JSON body, mapping failures to PhotoProviderError as `search` promises.
 * `name` is for the error messages.
 */
export async function getJson(name: string, url: URL, init: RequestInit, options: ProviderOptions): Promise<unknown> {
  try {
    const res = await (options.fetch ?? fetch)(url, {
      ...init,
      signal: AbortSignal.timeout(options.timeoutMs ?? PROVIDER_TIMEOUT_MS),
    });
    if (res.status === 429) {
      await res.body?.cancel();
      throw new PhotoProviderError('rate_limited', `${name} rate limit reached`);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new PhotoProviderError('failed', `${name} answered ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof PhotoProviderError) throw err;
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
    throw new PhotoProviderError('failed', timedOut ? `${name} timed out` : `${name} could not be reached or answered badly`);
  }
}
