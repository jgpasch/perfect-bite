// Pixabay (https://pixabay.com/api/docs/) as a PhotoProvider, the default. The key goes in the
// query string, from the server only; it never reaches the app. Pixabay's terms fit how the app
// uses a pick: its image URLs may show search results but not be hotlinked for good, so the app
// downloads the photo and uploads it as the household's own (spec 4.5). They also ask that answers
// be cached for 24 hours, which photo-search does (its URLs expire after 24 hours, so a little less).
import { MAX_PHOTO_SEARCH_PAGE, PHOTO_SEARCH_PER_PAGE, PhotoSearchResultSchema, type PhotoSearchResult } from '@shared/index.ts';

import { getJson, PhotoProviderError, type PhotoProvider, type ProviderOptions } from './types.ts';

export const PIXABAY_SEARCH_URL = 'https://pixabay.com/api/';

/** The languages Pixabay searches in; anything else searches in English. */
export const PIXABAY_LANGUAGES = new Set([
  'cs', 'da', 'de', 'en', 'es', 'fr', 'id', 'it', 'hu', 'nl', 'no', 'pl', 'pt', 'ro', 'sk', 'fi', 'sv', 'tr', 'vi', 'th',
  'bg', 'ru', 'el', 'ja', 'ko', 'zh',
]);

/** A Pixabay user's page, from their name and id (the API gives no URL for it). */
export function pixabayUserUrl(user: string, userId: number): string {
  return `https://pixabay.com/users/${encodeURIComponent(user)}-${userId}/`;
}

/** One Pixabay hit as PhotoSearchResult, or null when it's missing a field or a URL isn't `https://`. */
export function toPixabayResult(hit: unknown): PhotoSearchResult | null {
  if (typeof hit !== 'object' || hit === null) return null;
  const h = hit as Record<string, unknown>;
  const user = typeof h.user === 'string' ? h.user.trim() : '';
  const userId = typeof h.user_id === 'number' && Number.isInteger(h.user_id) ? h.user_id : null;
  const tags = typeof h.tags === 'string' && h.tags.trim() ? h.tags.trim() : null;
  const parsed = PhotoSearchResultSchema.safeParse({
    id: typeof h.id === 'number' || typeof h.id === 'string' ? String(h.id) : h.id,
    thumb: h.webformatURL,
    full: h.largeImageURL,
    width: h.imageWidth,
    height: h.imageHeight,
    author: user,
    authorUrl: user && userId !== null ? pixabayUserUrl(user, userId) : undefined,
    pageUrl: h.pageURL,
    alt: tags,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * `GET /api/`, 20 horizontal photos a page with SafeSearch on. `hasMore` while `totalHits` (what
 * Pixabay lets us page through) goes past this page, and false on the last page we allow.
 */
export function pixabayProvider(options: ProviderOptions): PhotoProvider {
  return {
    id: 'pixabay',
    info: { name: 'Pixabay', url: 'https://pixabay.com' },
    async search(query, page, lang) {
      const url = new URL(PIXABAY_SEARCH_URL);
      url.searchParams.set('key', options.apiKey);
      url.searchParams.set('q', query);
      url.searchParams.set('lang', PIXABAY_LANGUAGES.has(lang) ? lang : 'en');
      url.searchParams.set('image_type', 'photo');
      url.searchParams.set('orientation', 'horizontal');
      url.searchParams.set('safesearch', 'true');
      url.searchParams.set('page', String(page));
      url.searchParams.set('per_page', String(PHOTO_SEARCH_PER_PAGE));
      const body = await getJson('Pixabay', url, { headers: { accept: 'application/json' } }, options);
      if (typeof body !== 'object' || body === null || !Array.isArray((body as { hits?: unknown }).hits)) {
        throw new PhotoProviderError('failed', 'Pixabay answered without hits');
      }
      const { hits, totalHits } = body as { hits: unknown[]; totalHits?: unknown };
      const total = typeof totalHits === 'number' ? totalHits : 0;
      return {
        photos: hits
          .slice(0, PHOTO_SEARCH_PER_PAGE)
          .map(toPixabayResult)
          .filter((p): p is PhotoSearchResult => p !== null),
        hasMore: page * PHOTO_SEARCH_PER_PAGE < total && page < MAX_PHOTO_SEARCH_PAGE,
      };
    },
  };
}
