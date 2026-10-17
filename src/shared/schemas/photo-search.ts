import { z } from 'zod';

import { MAX_IMAGE_URL_LENGTH } from '../recipe-jsonld.ts';

// Spec 4.5, 6.11. The photo-search Edge Function and the app's Choose a photo sheet share these.

/** A search is at most this many characters, after trimming. */
export const MAX_PHOTO_SEARCH_QUERY = 100;

/** Pages run from 1 to this. */
export const MAX_PHOTO_SEARCH_PAGE = 10;

/** Photos asked of the provider per page; fewer come back when some are dropped. */
export const PHOTO_SEARCH_PER_PAGE = 20;

/** A photographer's name is at most this long, as `recipes.photo_credit` allows. */
export const MAX_PHOTO_AUTHOR_LENGTH = 200;

/** A provider's name is at most this long, as `recipes.photo_credit` allows. */
export const MAX_PHOTO_PROVIDER_LENGTH = 40;

/**
 * `POST /photo-search`: the words to search for, which page of results, and the language they're
 * in (ISO 639-1; a provider that can't search in it searches as it would without).
 */
export const PhotoSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(MAX_PHOTO_SEARCH_QUERY),
  page: z.number().int().min(1).max(MAX_PHOTO_SEARCH_PAGE).default(1),
  lang: z
    .string()
    .regex(/^[a-z]{2}$/)
    .default('en'),
});
export type PhotoSearchRequest = z.infer<typeof PhotoSearchRequestSchema>;

const HttpsUrlSchema = z.string().max(MAX_IMAGE_URL_LENGTH).startsWith('https://');

/** One stock photo: `thumb` for the grid, `full` to download, and the credit's names and links. */
export const PhotoSearchResultSchema = z.object({
  /** The provider's id for the photo, unique within one search. */
  id: z.string().min(1).max(100),
  thumb: HttpsUrlSchema,
  full: HttpsUrlSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  author: z.string().min(1).max(MAX_PHOTO_AUTHOR_LENGTH),
  authorUrl: HttpsUrlSchema,
  pageUrl: HttpsUrlSchema,
  /** The provider's description of the photo; null when it has none. */
  alt: z.string().nullable(),
});
export type PhotoSearchResult = z.infer<typeof PhotoSearchResultSchema>;

/**
 * Who the photos come from: the name the app credits ("Photos provided by Pixabay", "Photo: Jane Doe
 * / Pixabay") and the home page it links to. The app never names a provider itself.
 */
export const PhotoProviderSchema = z.object({
  name: z.string().min(1).max(MAX_PHOTO_PROVIDER_LENGTH),
  url: HttpsUrlSchema,
});
export type PhotoProviderInfo = z.infer<typeof PhotoProviderSchema>;

/** 200: who the photos are from, a page of photos, and whether there's a next page to ask for. */
export const PhotoSearchResponseSchema = z.object({
  provider: PhotoProviderSchema,
  photos: z.array(PhotoSearchResultSchema).max(PHOTO_SEARCH_PER_PAGE),
  hasMore: z.boolean(),
});
export type PhotoSearchResponse = z.infer<typeof PhotoSearchResponseSchema>;

export const PHOTO_SEARCH_ERROR_CODES = ['invalid_request', 'rate_limited', 'unavailable', 'search_failed'] as const;
export const PhotoSearchErrorCodeSchema = z.enum(PHOTO_SEARCH_ERROR_CODES);
export type PhotoSearchErrorCode = z.infer<typeof PhotoSearchErrorCodeSchema>;

/** An error response body, the same shape as the other functions'. */
export const PhotoSearchErrorSchema = z.object({
  error: PhotoSearchErrorCodeSchema,
  message: z.string(),
});
export type PhotoSearchError = z.infer<typeof PhotoSearchErrorSchema>;

/** The cache key for a search: lowercased, with runs of whitespace as one space, trimmed. */
export function photoSearchKey(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}
