// Pexels (https://www.pexels.com/api/documentation/) as a PhotoProvider. The key goes in the
// Authorization header from the server only; it never reaches the app. New Pexels keys were paused
// in October 2026, so it isn't the default; it stays for when they're issued again.
import { MAX_PHOTO_SEARCH_PAGE, PHOTO_SEARCH_PER_PAGE, PhotoSearchResultSchema, type PhotoSearchResult } from '@shared/index.ts';

import { getJson, PhotoProviderError, type PhotoProvider, type ProviderOptions } from './types.ts';

export const PEXELS_SEARCH_URL = 'https://api.pexels.com/v1/search';

/** One Pexels photo as PhotoSearchResult, or null when it's missing a field or a URL isn't `https://`. */
export function toPexelsResult(photo: unknown): PhotoSearchResult | null {
  if (typeof photo !== 'object' || photo === null) return null;
  const p = photo as Record<string, unknown>;
  const src = (typeof p.src === 'object' && p.src !== null ? p.src : {}) as Record<string, unknown>;
  const alt = typeof p.alt === 'string' && p.alt.trim() ? p.alt.trim() : null;
  const parsed = PhotoSearchResultSchema.safeParse({
    id: typeof p.id === 'number' || typeof p.id === 'string' ? String(p.id) : p.id,
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
 * `GET /v1/search`, 20 landscape photos a page. `hasMore` is Pexels' `next_page`, and false on the
 * last page we allow. Pexels has no language parameter, so `lang` is ignored.
 */
export function pexelsProvider(options: ProviderOptions): PhotoProvider {
  return {
    id: 'pexels',
    info: { name: 'Pexels', url: 'https://www.pexels.com' },
    async search(query, page) {
      const url = new URL(PEXELS_SEARCH_URL);
      url.searchParams.set('query', query);
      url.searchParams.set('page', String(page));
      url.searchParams.set('per_page', String(PHOTO_SEARCH_PER_PAGE));
      url.searchParams.set('orientation', 'landscape');
      const body = await getJson('Pexels', url, { headers: { authorization: options.apiKey, accept: 'application/json' } }, options);
      if (typeof body !== 'object' || body === null || !Array.isArray((body as { photos?: unknown }).photos)) {
        throw new PhotoProviderError('failed', 'Pexels answered without photos');
      }
      const { photos, next_page } = body as { photos: unknown[]; next_page?: unknown };
      return {
        photos: photos
          .slice(0, PHOTO_SEARCH_PER_PAGE)
          .map(toPexelsResult)
          .filter((p): p is PhotoSearchResult => p !== null),
        hasMore: typeof next_page === 'string' && next_page.length > 0 && page < MAX_PHOTO_SEARCH_PAGE,
      };
    },
  };
}
