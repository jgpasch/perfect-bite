import { z } from 'zod';

import { UNITS } from '../quantity-parser.ts';
import { AiRecipeTagsSchema } from '../recipe-tags.ts';
import {
  MAX_RECIPE_INGREDIENT_NAME_LENGTH,
  MAX_RECIPE_INGREDIENTS,
  MAX_RECIPE_NAME_LENGTH,
  MAX_RECIPE_NOTE_LENGTH,
  ResetsAtSchema,
} from './recipe-import.ts';

// Spec 4.14, 6.7. The suggest-recipe-tags Edge Function and the app share these: the request the
// app builds from a recipe on the device, and the response.

/** Recipe notes past this are cut before they reach the model (spec 6.7: input). */
export const MAX_SUGGEST_TAGS_NOTES_LENGTH = 4_000;

/** The first `max` UTF-16 units of `s`, without splitting a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

/** Trimmed, then cut to `max`: long text is truncated, never refused (spec 6.7). */
const text = (max: number) => z.string().transform((s) => cut(s.trim(), max).trimEnd());

export const SuggestRecipeTagsIngredientSchema = z.object({
  /** The display name, as the recipe shows it. */
  name: text(MAX_RECIPE_INGREDIENT_NAME_LENGTH),
  quantity: z.number().nullable(),
  unit: z.enum(UNITS).nullable(),
  /** `null` or missing is no note. */
  note: text(MAX_RECIPE_NOTE_LENGTH).nullish().transform((n) => n ?? ''),
});
export type SuggestRecipeTagsIngredient = z.infer<typeof SuggestRecipeTagsIngredientSchema>;

/**
 * `POST /suggest-recipe-tags`. The recipe as the device has it: name (required, cut to 120),
 * notes (cut to 4,000) and its live ingredients (the first 80; ones with an empty name dropped).
 */
export const SuggestRecipeTagsRequestSchema = z.object({
  name: text(MAX_RECIPE_NAME_LENGTH).refine((n) => n !== '', 'A recipe name is required'),
  notes: text(MAX_SUGGEST_TAGS_NOTES_LENGTH)
    .nullish()
    .transform((n) => n || null),
  ingredients: z
    .array(SuggestRecipeTagsIngredientSchema)
    .transform((items) => items.filter((i) => i.name !== '').slice(0, MAX_RECIPE_INGREDIENTS)),
  /** The recipe's household, only recorded on `ai_calls` (spec 6.4); ignored when the caller isn't in it. Optional for old builds. */
  householdId: z.uuid().optional(),
});
export type SuggestRecipeTagsRequest = z.infer<typeof SuggestRecipeTagsRequestSchema>;
/** What the app sends, before the schema trims and cuts it. */
export type SuggestRecipeTagsRequestInput = z.input<typeof SuggestRecipeTagsRequestSchema>;

/**
 * 200. `tags` holds only known slugs, each facet within its maximum; all empty when nothing fit.
 * Never `saved`, a person's own: one in the response is dropped.
 */
export const SuggestRecipeTagsResponseSchema = z.object({
  tags: AiRecipeTagsSchema,
  promptVersion: z.string(),
});
export type SuggestRecipeTagsResponse = z.infer<typeof SuggestRecipeTagsResponseSchema>;

export const SUGGEST_RECIPE_TAGS_ERROR_CODES = ['invalid_request', 'not_entitled', 'rate_limited', 'daily_limit', 'limit_reached', 'unavailable'] as const;
export const SuggestRecipeTagsErrorCodeSchema = z.enum(SUGGEST_RECIPE_TAGS_ERROR_CODES);
export type SuggestRecipeTagsErrorCode = z.infer<typeof SuggestRecipeTagsErrorCodeSchema>;

/** An error response body, the same shape as the other functions'. */
export const SuggestRecipeTagsErrorSchema = z.object({
  error: SuggestRecipeTagsErrorCodeSchema,
  message: z.string(),
  resets_at: ResetsAtSchema,
});
export type SuggestRecipeTagsError = z.infer<typeof SuggestRecipeTagsErrorSchema>;
