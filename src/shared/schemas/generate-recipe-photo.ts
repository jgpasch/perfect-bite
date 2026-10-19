import { z } from 'zod';

import { ResetsAtSchema } from './recipe-import.ts';

// Spec 4.5, 6.11. The generate-recipe-photo Edge Function and the app share these. The app sends
// only the recipe's id: the server reads the recipe itself, so no text the app sends reaches a model.

/**
 * `POST /generate-recipe-photo`: the recipe to make a photo for, lowercased (Storage paths and
 * `recipes_photo_path_shape` use lowercase ids).
 */
export const GenerateRecipePhotoRequestSchema = z.object({
  recipeId: z.guid().transform((id) => id.toLowerCase()),
});
export type GenerateRecipePhotoRequest = z.infer<typeof GenerateRecipePhotoRequestSchema>;

/** `<household_id>/<recipe_id>/<uuid>.jpg` in `recipe-photos`, the `photo_path` shape. */
export const RECIPE_PHOTO_PATH_PATTERN = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/;

/** 200: the uploaded photo's path. The app sets it as the recipe's `photo_path`; the server never writes `recipes`. */
export const GenerateRecipePhotoResponseSchema = z.object({
  path: z.string().regex(RECIPE_PHOTO_PATH_PATTERN),
});
export type GenerateRecipePhotoResponse = z.infer<typeof GenerateRecipePhotoResponseSchema>;

/**
 * `not_found` (404): no such live recipe in the caller's households. `already_generated` (409): it
 * has had its one AI photo, or one is being made. `not_food` (422): the recipe isn't food, or its
 * text isn't something to put in a food photo, or the image model refused it.
 * `generation_failed` (502): a model failed or timed out; the slot was released, so try again.
 * `limit_reached` (429, with `resets_at`): the user has made their plan's AI photos this month.
 * `unavailable` (503, with Retry-After): a kill switch.
 */
export const GENERATE_RECIPE_PHOTO_ERROR_CODES = [
  'invalid_request',
  'not_entitled',
  'not_found',
  'already_generated',
  'not_food',
  'generation_failed',
  'limit_reached',
  'unavailable',
] as const;
export const GenerateRecipePhotoErrorCodeSchema = z.enum(GENERATE_RECIPE_PHOTO_ERROR_CODES);
export type GenerateRecipePhotoErrorCode = z.infer<typeof GenerateRecipePhotoErrorCodeSchema>;

/** An error response body, the same shape as the other functions'. */
export const GenerateRecipePhotoErrorSchema = z.object({
  error: GenerateRecipePhotoErrorCodeSchema,
  message: z.string(),
  resets_at: ResetsAtSchema,
});
export type GenerateRecipePhotoError = z.infer<typeof GenerateRecipePhotoErrorSchema>;
