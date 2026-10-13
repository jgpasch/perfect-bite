import { z } from 'zod';

// Spec 4.14. The fixed tag list, shared by the app, the import-recipe Edge Function and the Zod
// schemas. Each value has a slug (stored in `recipes.tags`) and a label (shown). Tags are never
// free-form: adding a value means adding it here; the database only checks the facets' shape, so
// that needs no migration, and older apps ignore slugs they don't know (`knownTags`).

/** A facet's values, in display order. */
const MEAL = [
  { slug: 'breakfast', label: 'Breakfast' },
  { slug: 'lunch', label: 'Lunch' },
  { slug: 'dinner', label: 'Dinner' },
  { slug: 'side', label: 'Side' },
  { slug: 'dessert', label: 'Dessert' },
  { slug: 'snack', label: 'Snack' },
  { slug: 'drink', label: 'Drink' },
] as const;

const CUISINE = [
  { slug: 'american', label: 'American' },
  { slug: 'mexican', label: 'Mexican' },
  { slug: 'latin-american', label: 'Latin American' },
  { slug: 'caribbean', label: 'Caribbean' },
  { slug: 'italian', label: 'Italian' },
  { slug: 'french', label: 'French' },
  { slug: 'spanish', label: 'Spanish' },
  { slug: 'greek', label: 'Greek' },
  { slug: 'mediterranean', label: 'Mediterranean' },
  { slug: 'middle-eastern', label: 'Middle Eastern' },
  { slug: 'indian', label: 'Indian' },
  { slug: 'chinese', label: 'Chinese' },
  { slug: 'japanese', label: 'Japanese' },
  { slug: 'korean', label: 'Korean' },
  { slug: 'thai', label: 'Thai' },
  { slug: 'vietnamese', label: 'Vietnamese' },
  { slug: 'african', label: 'African' },
] as const;

const PROTEIN = [
  { slug: 'chicken', label: 'Chicken' },
  { slug: 'turkey', label: 'Turkey' },
  { slug: 'beef', label: 'Beef' },
  { slug: 'pork', label: 'Pork' },
  { slug: 'lamb', label: 'Lamb' },
  { slug: 'fish', label: 'Fish' },
  { slug: 'shellfish', label: 'Shellfish' },
  { slug: 'eggs', label: 'Eggs' },
  { slug: 'tofu-tempeh', label: 'Tofu & tempeh' },
  { slug: 'beans-lentils', label: 'Beans & lentils' },
] as const;

// No gluten-free, dairy-free or nut-free: a wrong guess could hurt someone with an allergy.
const DIET = [
  { slug: 'vegetarian', label: 'Vegetarian' },
  { slug: 'vegan', label: 'Vegan' },
] as const;

const METHOD = [
  { slug: 'pressure-cooker', label: 'Instant Pot' },
  { slug: 'slow-cooker', label: 'Slow cooker' },
  { slug: 'sheet-pan', label: 'Sheet pan' },
  { slug: 'one-pot', label: 'One pot' },
  { slug: 'grill', label: 'Grill' },
  { slug: 'air-fryer', label: 'Air fryer' },
  { slug: 'no-cook', label: 'No cook' },
] as const;

/** The facets in display order, each with its values and how many a recipe may have. */
export const RECIPE_TAG_FACETS = [
  { key: 'meal', label: 'Meal', max: 2, values: MEAL },
  { key: 'cuisine', label: 'Cuisine', max: 2, values: CUISINE },
  { key: 'protein', label: 'Protein', max: 3, values: PROTEIN },
  { key: 'diet', label: 'Diet', max: 2, values: DIET },
  { key: 'method', label: 'Method', max: 2, values: METHOD },
] as const;

export type RecipeTagFacet = (typeof RECIPE_TAG_FACETS)[number];
export type RecipeTagFacetKey = RecipeTagFacet['key'];
export const RECIPE_TAG_FACET_KEYS = RECIPE_TAG_FACETS.map((f) => f.key) as readonly RecipeTagFacetKey[];

export type MealTag = (typeof MEAL)[number]['slug'];
export type CuisineTag = (typeof CUISINE)[number]['slug'];
export type ProteinTag = (typeof PROTEIN)[number]['slug'];
export type DietTag = (typeof DIET)[number]['slug'];
export type MethodTag = (typeof METHOD)[number]['slug'];

/** The broad region of each cuisine, for the Later "by category" view (spec 11.5). */
export const CUISINE_REGIONS = {
  american: 'american',
  mexican: 'latin',
  'latin-american': 'latin',
  caribbean: 'latin',
  italian: 'european',
  french: 'european',
  spanish: 'european',
  greek: 'european',
  mediterranean: 'european',
  'middle-eastern': 'middle-eastern',
  indian: 'asian',
  chinese: 'asian',
  japanese: 'asian',
  korean: 'asian',
  thai: 'asian',
  vietnamese: 'asian',
  african: 'african',
} as const satisfies Record<CuisineTag, string>;

export type CuisineRegion = (typeof CUISINE_REGIONS)[CuisineTag];

export const CUISINE_REGION_LABELS: Record<CuisineRegion, string> = {
  american: 'American',
  latin: 'Latin',
  european: 'European',
  'middle-eastern': 'Middle Eastern',
  asian: 'Asian',
  african: 'African',
};

/**
 * A recipe's tags, as `recipes.tags` stores them: every facet an array of slugs. The arrays are
 * strings, not the enums, so a slug a newer app added survives a save by this one.
 */
export type RecipeTags = Record<RecipeTagFacetKey, string[]>;

/**
 * Validates stored or edited tags: keeps the five facets (a missing one becomes `[]`), drops any
 * other key (the database refuses them), and keeps every slug, known or not.
 */
export const RecipeTagsSchema = z.object({
  meal: z.array(z.string()).default([]),
  cuisine: z.array(z.string()).default([]),
  protein: z.array(z.string()).default([]),
  diet: z.array(z.string()).default([]),
  method: z.array(z.string()).default([]),
}) satisfies z.ZodType<RecipeTags, unknown>;

export function emptyRecipeTags(): RecipeTags {
  return { meal: [], cuisine: [], protein: [], diet: [], method: [] };
}

/**
 * The tags to show: each facet's known slugs in the facet's display order, unknown ones dropped.
 * Only for display; save the stored value, not this. Null stays null (never tagged).
 */
export function knownTags(tags: RecipeTags | null): RecipeTags | null {
  if (!tags) return null;
  const out = emptyRecipeTags();
  for (const facet of RECIPE_TAG_FACETS) {
    const stored = new Set(tags[facet.key] ?? []);
    out[facet.key] = facet.values.filter((v) => stored.has(v.slug)).map((v) => v.slug);
  }
  return out;
}

/** The label of a known slug in a facet, else null. */
export function recipeTagLabel(facet: RecipeTagFacetKey, slug: string): string | null {
  const values: readonly { slug: string; label: string }[] = RECIPE_TAG_FACETS.find((f) => f.key === facet)!.values;
  return values.find((v) => v.slug === slug)?.label ?? null;
}

/** `recipes.total_minutes` bounds (the database checks them too). */
export const MIN_TOTAL_MINUTES = 1;
export const MAX_TOTAL_MINUTES = 2880;

/** Time isn't a tag: it's worked out from `total_minutes`. */
export const TIME_BUCKETS = [
  { key: 'under-30', label: 'Under 30 min' },
  { key: 'under-60', label: 'Under 1 hour' },
  { key: 'over-60', label: 'Over 1 hour' },
] as const;

export type TimeBucket = (typeof TIME_BUCKETS)[number]['key'];

/** Under 30 minutes; 30 to 60; over 60. Null (no time) has no bucket. */
export function timeBucket(totalMinutes: number | null | undefined): TimeBucket | null {
  if (totalMinutes == null || !Number.isFinite(totalMinutes)) return null;
  if (totalMinutes < 30) return 'under-30';
  if (totalMinutes <= 60) return 'under-60';
  return 'over-60';
}
