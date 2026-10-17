import { z } from 'zod';

import { MAX_IMAGE_URL_LENGTH } from '../recipe-jsonld.ts';
import { HttpUrlSchema } from './recipe-import.ts';

// Spec 4.5, 6.9. The recipe-photos Edge Function and the app's Choose a photo sheet share these.

/** At most this many photos come back (`readImageCandidates`' cap). */
export const MAX_RECIPE_PHOTOS = 12;

/** `POST /recipe-photos`: the recipe's link. */
export const RecipePhotosRequestSchema = z.object({ url: HttpUrlSchema });
export type RecipePhotosRequest = z.infer<typeof RecipePhotosRequestSchema>;

/** 200: the page's photos, best first, each `https://` and at most 2048 characters; empty when it has none. */
export const RecipePhotosResponseSchema = z.object({
  images: z.array(z.string().max(MAX_IMAGE_URL_LENGTH).startsWith('https://')).max(MAX_RECIPE_PHOTOS),
});
export type RecipePhotosResponse = z.infer<typeof RecipePhotosResponseSchema>;

export const RECIPE_PHOTOS_ERROR_CODES = ['invalid_request', 'invalid_url', 'fetch_failed', 'rate_limited', 'unavailable'] as const;
export const RecipePhotosErrorCodeSchema = z.enum(RECIPE_PHOTOS_ERROR_CODES);
export type RecipePhotosErrorCode = z.infer<typeof RecipePhotosErrorCodeSchema>;

/** An error response body, the same shape as the other functions'. */
export const RecipePhotosErrorSchema = z.object({
  error: RecipePhotosErrorCodeSchema,
  message: z.string(),
});
export type RecipePhotosError = z.infer<typeof RecipePhotosErrorSchema>;
