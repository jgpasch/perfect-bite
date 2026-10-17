// The Pexels search API (https://www.pexels.com/api/documentation/), as photo-search uses it. The
// key goes in the Authorization header from the server only; it never reaches the app.
import {
  MAX_PHOTO_SEARCH_PAGE,
  PHOTO_SEARCH_PER_PAGE,
  PhotoSearchResultSchema,
  type PhotoSearchResponse,
  type PhotoSearchResult,
} from '@shared/index.ts';

export const PEXELS_SEARCH_URL = 'https://api.pexels.com/v1/search';

/** How long a search may take before it counts as failed. */
export const PEXELS_TIMEOUT_MS = 8_000;

export class PexelsError extends Error {
  override name = 'PexelsError';
  constructor(
    /** `rate_limited`: Pexels answered 429 (our quota is used up). `failed`: anything else. */
    readonly reason: 'rate_limited' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

export type PexelsOptions = {
  apiKey: string;
  /** Tests inject a fake Pexels. */
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/** One Pexels photo as PhotoSearchResult, or null when it's missing a field or a URL isn't `https://`. */
export function toResult(photo: unknown): PhotoSearchResult | null {
  if (typeof photo !== 'object' || photo === null) return null;
  const p = photo as Record<string, unknown>;
  const src = (typeof p.src === 'object' && p.src !== null ? p.src : {}) as Record<string, unknown>;
  const alt = typeof p.alt === 'string' && p.alt.trim() ? p.alt.trim() : null;
  const parsed = PhotoSearchResultSchema.safeParse({
    id: p.id,
    thumb: src.medium,
    full: src.large2x,
    width: p.width,
    height: p.height,
    author: typeof p.photographer === 'string' ? p.photographer.trim() : p.photographer,
    authorUrl: p.photographer_url,
    pageUrl: p.url,
    alt,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * `GET /v1/search` for one page of landscape photos, 20 a page. `hasMore` is Pexels' `next_page`,
 * and false on the last page we allow. Pexels' 429 is `rate_limited`; any other status, a network
 * error, a body that isn't the expected JSON, or no answer within the timeout is `failed`.
 */
export async function searchPexels(query: string, page: number, options: PexelsOptions): Promise<PhotoSearchResponse> {
  const url = new URL(PEXELS_SEARCH_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(PHOTO_SEARCH_PER_PAGE));
  url.searchParams.set('orientation', 'landscape');

  let body: unknown;
  try {
    const res = await (options.fetch ?? fetch)(url, {
      headers: { authorization: options.apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? PEXELS_TIMEOUT_MS),
    });
    if (res.status === 429) {
      await res.body?.cancel();
      throw new PexelsError('rate_limited', 'Pexels rate limit reached');
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new PexelsError('failed', `Pexels answered ${res.status}`);
    }
    body = await res.json();
  } catch (err) {
    if (err instanceof PexelsError) throw err;
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
    throw new PexelsError('failed', timedOut ? 'Pexels timed out' : 'Pexels could not be reached or answered badly');
  }

  if (typeof body !== 'object' || body === null || !Array.isArray((body as { photos?: unknown }).photos)) {
    throw new PexelsError('failed', 'Pexels answered without photos');
  }
  const { photos, next_page } = body as { photos: unknown[]; next_page?: unknown };
  return {
    photos: photos
      .slice(0, PHOTO_SEARCH_PER_PAGE)
      .map(toResult)
      .filter((p): p is PhotoSearchResult => p !== null),
    hasMore: typeof next_page === 'string' && next_page.length > 0 && page < MAX_PHOTO_SEARCH_PAGE,
  };
}
