import { z } from 'zod';

// Spec 4.10, 6.10. The import-recipe-photo Edge Function and the app share these: the request the
// app sends (the response is `RecipeImportResponse`, as for a link) and its caps.

/** The image types a photo import takes. HEIC is converted to JPEG on the device first. */
export const RECIPE_PHOTO_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type RecipePhotoMediaType = (typeof RECIPE_PHOTO_MEDIA_TYPES)[number];

/** A recipe often spans two pages; at most three. */
export const MAX_PHOTO_IMPORT_IMAGES = 3;
/** Each image, decoded. */
export const MAX_PHOTO_IMPORT_IMAGE_BYTES = 2 * 1024 * 1024;
/** The whole request body (`413` beyond it). */
export const MAX_PHOTO_IMPORT_BODY_BYTES = 8 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The decoded size of standard, padded base64 (`A-Z a-z 0-9 + /`, `=` padding, length a multiple
 * of 4), without decoding it. Null for anything else: URL-safe base64, whitespace, a data URL,
 * missing padding, or nothing at all.
 */
export function base64DecodedBytes(data: string): number | null {
  if (data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data)) return null;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

export const RecipePhotoSchema = z.object({
  mediaType: z.enum(RECIPE_PHOTO_MEDIA_TYPES),
  /** The image bytes, standard base64. */
  data: z
    .string()
    .refine((data) => base64DecodedBytes(data) !== null, 'Not base64')
    .refine((data) => (base64DecodedBytes(data) ?? 0) <= MAX_PHOTO_IMPORT_IMAGE_BYTES, 'Image over 2 MB'),
});
export type RecipePhoto = z.infer<typeof RecipePhotoSchema>;

/** `POST /import-recipe-photo`: the pages of one recipe, in order. */
export const RecipePhotoImportRequestSchema = z.object({
  images: z.array(RecipePhotoSchema).min(1).max(MAX_PHOTO_IMPORT_IMAGES),
  /** The household the recipe is saved to, where the plan is checked and the import counted (spec 4.12). */
  householdId: z.uuid(),
});
export type RecipePhotoImportRequest = z.infer<typeof RecipePhotoImportRequestSchema>;
