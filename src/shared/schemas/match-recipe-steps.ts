import { z } from 'zod';

import { MAX_RECIPE_STEP_LENGTH, MAX_RECIPE_STEPS } from '../recipe-jsonld.ts';
import { MAX_RECIPE_INGREDIENTS, ResetsAtSchema } from './recipe-import.ts';
import { SuggestRecipeTagsIngredientSchema } from './suggest-recipe-tags.ts';

// Spec 4.5, 6.8. The match-recipe-steps Edge Function and the app share these: the request the
// app builds from a recipe on the device, and the response it saves as `recipes.step_ingredients`.

/** The longest ingredient id, as `recipes.step_ingredients` allows it. */
export const MAX_STEP_MATCH_ID_LENGTH = 64;

/** A step's text, trimmed and cut to the steps column's limit (in code points). */
const StepTextSchema = z.string().transform((s) => Array.from(s.trim()).slice(0, MAX_RECIPE_STEP_LENGTH).join('').trimEnd());

/** An ingredient as the tags request reads it, with the recipe ingredient's id. */
export const MatchRecipeStepsIngredientSchema = SuggestRecipeTagsIngredientSchema.extend({
  id: z.string().min(1).max(MAX_STEP_MATCH_ID_LENGTH),
});
export type MatchRecipeStepsIngredient = z.infer<typeof MatchRecipeStepsIngredientSchema>;

/**
 * `POST /match-recipe-steps`. The recipe as the device has it: its steps (1 to 100, at least one
 * not blank; a blank step is kept, so the answer lines up, and uses nothing) and its live
 * ingredients (ids unique; ones with an empty name dropped, then the first 80; at least one left).
 */
export const MatchRecipeStepsRequestSchema = z.object({
  steps: z
    .array(StepTextSchema)
    .min(1, 'A recipe needs at least one step')
    .max(MAX_RECIPE_STEPS)
    .refine((steps) => steps.some((s) => s !== ''), 'A recipe needs at least one step'),
  ingredients: z
    .array(MatchRecipeStepsIngredientSchema)
    .refine((items) => new Set(items.map((i) => i.id)).size === items.length, 'Ingredient ids must be unique')
    .transform((items) => items.filter((i) => i.name !== '').slice(0, MAX_RECIPE_INGREDIENTS))
    .refine((items) => items.length > 0, 'A recipe needs at least one ingredient'),
});
export type MatchRecipeStepsRequest = z.infer<typeof MatchRecipeStepsRequestSchema>;
/** What the app sends, before the schema trims and cuts it. */
export type MatchRecipeStepsRequestInput = z.input<typeof MatchRecipeStepsRequestSchema>;

/**
 * 200. One entry per request step, in order: the ids of the ingredients it uses, in the request's
 * order, each with the step's share in the ingredient's own unit (null = all of it or not stated).
 */
export const MatchRecipeStepsResponseSchema = z.object({
  steps: z.array(z.array(z.object({ id: z.string(), quantity: z.number().positive().nullable() }))),
  promptVersion: z.string(),
});
export type MatchRecipeStepsResponse = z.infer<typeof MatchRecipeStepsResponseSchema>;

export const MATCH_RECIPE_STEPS_ERROR_CODES = ['invalid_request', 'not_entitled', 'rate_limited', 'daily_limit', 'limit_reached', 'unavailable'] as const;
export const MatchRecipeStepsErrorCodeSchema = z.enum(MATCH_RECIPE_STEPS_ERROR_CODES);
export type MatchRecipeStepsErrorCode = z.infer<typeof MatchRecipeStepsErrorCodeSchema>;

/** An error response body, the same shape as the other functions'. */
export const MatchRecipeStepsErrorSchema = z.object({
  error: MatchRecipeStepsErrorCodeSchema,
  message: z.string(),
  resets_at: ResetsAtSchema,
});
export type MatchRecipeStepsError = z.infer<typeof MatchRecipeStepsErrorSchema>;
