import { z } from 'zod';

import { UNITS } from '../quantity-parser.ts';
import {
  emptyRecipeTags,
  MAX_TOTAL_MINUTES,
  MIN_TOTAL_MINUTES,
  RECIPE_TAG_FACETS,
  RecipeTagsSchema,
  type RecipeTagFacet,
  type RecipeTags,
} from '../recipe-tags.ts';

// Spec 4.10, 6.6. The import-recipe Edge Function and the app share these: the request the app
// sends, the extract-recipe LLM output, the response, and the canonical form of a recipe URL.

/** Request caps (spec 6.6). Sizes are UTF-8 bytes. */
export const MAX_JSON_LD_BLOCKS = 10;
export const MAX_JSON_LD_BLOCK_BYTES = 200 * 1024;
export const MAX_PAGE_TEXT_BYTES = 50 * 1024;

/** LLM output caps (spec 6.6, LLM boundaries: output). */
export const MAX_RECIPE_NAME_LENGTH = 120;
export const MAX_RECIPE_INGREDIENTS = 80;
export const MAX_RECIPE_INGREDIENT_NAME_LENGTH = 64;
export const MAX_RECIPE_NOTE_LENGTH = 120;

/** Query parameters dropped from a recipe URL; a trailing `*` matches any suffix. */
const TRACKING_PARAMS = ['utm_*', 'fbclid', 'gclid', 'ref', 'mc_*'];

function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  return TRACKING_PARAMS.some((p) => (p.endsWith('*') ? k.startsWith(p.slice(0, -1)) : k === p));
}

/**
 * The canonical form of a recipe URL (spec 4.10), used as `recipes.source_url` and the
 * `recipe_imports` cache key: lowercase host without `www.`, no fragment, no tracking
 * parameters, no trailing slash. Null for anything that isn't an `http`/`https` URL.
 */
export function canonicalRecipeUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!hostname) return null;
  const port = parsed.port ? `:${parsed.port}` : '';
  const path = parsed.pathname.replace(/\/+$/, '');
  const params = new URLSearchParams(parsed.search);
  for (const key of [...params.keys()]) {
    if (isTrackingParam(key)) params.delete(key);
  }
  const query = params.toString();
  return `${parsed.protocol}//${hostname}${port}${path}${query ? `?${query}` : ''}`;
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

export const HttpUrlSchema = z.string().refine((u) => canonicalRecipeUrl(u) !== null, 'Not an http(s) URL');

/** A page captured on the device (Safari's share sheet or the device fallback), within the caps. */
export const RecipeImportPageSchema = z.object({
  title: z.string().optional(),
  jsonLd: z
    .array(z.string().refine((b) => utf8Bytes(b) <= MAX_JSON_LD_BLOCK_BYTES, 'JSON-LD block too large'))
    .max(MAX_JSON_LD_BLOCKS)
    .optional(),
  text: z
    .string()
    .refine((t) => utf8Bytes(t) <= MAX_PAGE_TEXT_BYTES, 'Page text too large')
    .optional(),
});
export type RecipeImportPage = z.infer<typeof RecipeImportPageSchema>;

/** `POST /import-recipe`. `page` is what Safari already captured, so the server needn't fetch. */
export const RecipeImportRequestSchema = z.object({
  url: HttpUrlSchema,
  page: RecipeImportPageSchema.optional(),
});
export type RecipeImportRequest = z.infer<typeof RecipeImportRequestSchema>;

/**
 * One facet of the extracted tags (spec 4.14): its slugs without repeats, cut to the facet's
 * maximum. A facet with a slug the list doesn't have, or that isn't an array of strings, is `[]`,
 * so one bad facet costs only itself and the import still succeeds.
 */
function extractedFacetSchema(facet: RecipeTagFacet) {
  const known = new Set<string>(facet.values.map((v) => v.slug));
  return z
    .array(z.string())
    .refine((slugs) => slugs.every((slug) => known.has(slug)))
    .transform((slugs) => [...new Set(slugs)].slice(0, facet.max))
    .catch([]);
}

/** The extracted tags: every facet, each checked on its own; anything but an object is untagged facets. */
export const ExtractedRecipeTagsSchema = z
  .object(
    Object.fromEntries(RECIPE_TAG_FACETS.map((facet) => [facet.key, extractedFacetSchema(facet)])) as Record<
      RecipeTagFacet['key'],
      ReturnType<typeof extractedFacetSchema>
    >,
  )
  .catch(() => emptyRecipeTags()) satisfies z.ZodType<RecipeTags, unknown>;

/** `recipes.total_minutes`: whole minutes, 1 to 2880 (spec 4.14). */
export const TotalMinutesSchema = z.number().int().min(MIN_TOTAL_MINUTES).max(MAX_TOTAL_MINUTES);

/** The extract-recipe LLM output. A unit the app doesn't support is null, its wording in `note`. */
export const ExtractedRecipeSchema = z.object({
  is_recipe: z.boolean(),
  name: z.string().max(MAX_RECIPE_NAME_LENGTH),
  servings: z.number().nullable(),
  ingredients: z
    .array(
      z.object({
        name: z.string().max(MAX_RECIPE_INGREDIENT_NAME_LENGTH),
        quantity: z.number().nullable(),
        unit: z.enum(UNITS).nullable(),
        note: z.string().max(MAX_RECIPE_NOTE_LENGTH),
      }),
    )
    .max(MAX_RECIPE_INGREDIENTS),
  tags: ExtractedRecipeTagsSchema,
  total_minutes: TotalMinutesSchema.nullable(),
});
export type ExtractedRecipe = z.infer<typeof ExtractedRecipeSchema>;

export const RecipeImportResponseSchema = z.object({
  name: z.string(),
  /** Canonical (`canonicalRecipeUrl`). */
  sourceUrl: z.string(),
  servings: z.number().nullable(),
  ingredients: z.array(
    z.object({
      /** The normalized key (`normalizeIngredientName`). */
      ingredientName: z.string().min(1),
      displayName: z.string(),
      quantity: z.number().nullable(),
      unit: z.enum(UNITS).nullable(),
      note: z.string(),
      categoryId: z.string().nullable(),
      status: z.enum(['pending', 'categorized', 'failed']),
    }),
  ),
  /**
   * What the extraction tagged (spec 4.14), saved on a recipe the import creates. Null when the
   * server sent none or something unreadable (an older server), so the recipe stays untagged.
   */
  tags: RecipeTagsSchema.nullable().catch(null),
  /** Minutes, from the page's JSON-LD or the model; null when neither said, or it's out of range. */
  totalMinutes: TotalMinutesSchema.nullable().catch(null),
});
export type RecipeImportResponse = z.infer<typeof RecipeImportResponseSchema>;

export const RECIPE_IMPORT_ERROR_CODES = [
  'invalid_url',
  'fetch_failed',
  'not_a_recipe',
  'rate_limited',
  'unavailable',
  'not_entitled',
] as const;
export const RecipeImportErrorCodeSchema = z.enum(RECIPE_IMPORT_ERROR_CODES);
export type RecipeImportErrorCode = z.infer<typeof RecipeImportErrorCodeSchema>;

/** An error response body, the same shape as categorize-ingredients'. */
export const RecipeImportErrorSchema = z.object({
  error: RecipeImportErrorCodeSchema,
  message: z.string(),
});
export type RecipeImportError = z.infer<typeof RecipeImportErrorSchema>;
