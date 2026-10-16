// Filtering the Recipes tab (spec 4.14): the filter sheet, the active filter chips and the
// untagged footer. Pure: no React, SQLite or network. The in-memory store is `recipe-filter-store.ts`.
import {
  emptyRecipeTags,
  RECIPE_TAG_FACETS,
  recipeTagLabel,
  TIME_BUCKETS,
  timeBucket,
  type RecipeTagFacetKey,
  type RecipeTags,
  type TimeBucket,
} from '@/shared/recipe-tags';
import { i18n } from '@/i18n';
import { tagFacetLabel, tagLabel } from '@/i18n/vocabulary';

const TIME_BUCKET_KEYS = { 'under-30': 'under30', 'under-60': 'under60', 'over-60': 'over60' } as const;

/** A time bucket's label in the app's language: "Under 30 min", "Under 1 hour", "Over 1 hour". */
export function timeBucketLabel(bucket: TimeBucket): string {
  return i18n.t(`recipes.timeBuckets.${TIME_BUCKET_KEYS[bucket]}`);
}

/** The Time facet's name, after the tag facets. */
export function timeFacetLabel(): string {
  return i18n.t('recipes.filters.time');
}

/**
 * The picked values: OR within a facet, AND across facets. `untagged` shows only recipes without
 * tags or a time, and is never combined with values.
 */
export type RecipeFilters = { tags: RecipeTags; time: TimeBucket[]; untagged: boolean };

/** What filtering reads from a recipe. */
export type FilterableRecipe = { tags: RecipeTags | null; totalMinutes: number | null };

/** The sheet's facets: the six tag facets (Saved first), then Time. */
export type FilterFacetKey = RecipeTagFacetKey | 'time';

export function noRecipeFilters(): RecipeFilters {
  return { tags: emptyRecipeTags(), time: [], untagged: false };
}

/** Only the recipes without tags (the untagged footer's tap). */
export function untaggedOnlyFilters(): RecipeFilters {
  return { ...noRecipeFilters(), untagged: true };
}

/** How many filters are on: one per picked value, and one for Untagged. */
export function activeFilterCount(filters: RecipeFilters): number {
  const values = RECIPE_TAG_FACETS.reduce((n, f) => n + filters.tags[f.key].length, 0) + filters.time.length;
  return values + (filters.untagged ? 1 : 0);
}

/** No known tag in any facet and no time: nothing a filter could match. */
export function isUntaggedRecipe(recipe: FilterableRecipe): boolean {
  if (timeBucket(recipe.totalMinutes)) return false;
  if (!recipe.tags) return true;
  return RECIPE_TAG_FACETS.every((f) => !(recipe.tags![f.key] ?? []).some((slug) => recipeTagLabel(f.key, slug)));
}

function facetValues(recipe: FilterableRecipe, facet: FilterFacetKey): string[] {
  if (facet === 'time') {
    const bucket = timeBucket(recipe.totalMinutes);
    return bucket ? [bucket] : [];
  }
  return recipe.tags?.[facet] ?? [];
}

function picked(filters: RecipeFilters, facet: FilterFacetKey): readonly string[] {
  return facet === 'time' ? filters.time : filters.tags[facet];
}

const FACET_KEYS: readonly FilterFacetKey[] = [...RECIPE_TAG_FACETS.map((f) => f.key), 'time'];

/** Whether a recipe passes: any picked value in each facet that has some (no filters passes all). */
export function matchesRecipeFilters(recipe: FilterableRecipe, filters: RecipeFilters): boolean {
  if (filters.untagged) return isUntaggedRecipe(recipe);
  return FACET_KEYS.every((facet) => {
    const want = picked(filters, facet);
    if (want.length === 0) return true;
    const has = facetValues(recipe, facet);
    return want.some((v) => has.includes(v));
  });
}

export function filterRecipes<R extends FilterableRecipe>(recipes: readonly R[], filters: RecipeFilters): R[] {
  return recipes.filter((r) => matchesRecipeFilters(r, filters));
}

export type FilterFacet = {
  key: FilterFacetKey;
  label: string;
  values: { slug: string; label: string }[];
};

/**
 * The sheet's groups: each facet's values that some recipe has, in display order, with a facet
 * left out when none are. A picked value stays, so it can be turned off.
 */
export function availableFilterFacets(recipes: readonly FilterableRecipe[], filters: RecipeFilters): FilterFacet[] {
  const all: { key: FilterFacetKey; label: string; values: readonly { slug: string; label: string }[] }[] = [
    ...RECIPE_TAG_FACETS.map((f) => ({
      key: f.key,
      label: tagFacetLabel(f.key),
      values: f.values.map((v) => ({ slug: v.slug, label: tagLabel(f.key, v.slug)! })),
    })),
    { key: 'time', label: timeFacetLabel(), values: TIME_BUCKETS.map((b) => ({ slug: b.key, label: timeBucketLabel(b.key) })) },
  ];
  const facets: FilterFacet[] = [];
  for (const facet of all) {
    const present = new Set(recipes.flatMap((r) => facetValues(r, facet.key)));
    for (const v of picked(filters, facet.key)) present.add(v);
    const values = facet.values.filter((v) => present.has(v.slug)).map((v) => ({ slug: v.slug, label: v.label }));
    if (values.length > 0) facets.push({ key: facet.key, label: facet.label, values });
  }
  return facets;
}

export function isFilterPicked(filters: RecipeFilters, facet: FilterFacetKey, slug: string): boolean {
  return picked(filters, facet).includes(slug);
}

/** Turns a value on or off. Picking a value leaves Untagged. */
export function toggleRecipeFilter(filters: RecipeFilters, facet: FilterFacetKey, slug: string): RecipeFilters {
  const current = picked(filters, facet);
  const next = current.includes(slug) ? current.filter((v) => v !== slug) : [...current, slug];
  if (facet === 'time') return { ...filters, time: next as TimeBucket[], untagged: false };
  return { ...filters, tags: { ...filters.tags, [facet]: next }, untagged: false };
}

export type FilterChip = {
  key: string;
  facet: FilterFacetKey | 'untagged';
  slug: string;
  /** "Dinner", "Under 30 min", "Untagged". */
  label: string;
  /** "Remove Dinner filter". */
  accessibilityLabel: string;
};

/** The chips under the search field, one per active filter, in the sheet's order. */
export function recipeFilterChips(filters: RecipeFilters): FilterChip[] {
  const chip = (facet: FilterChip['facet'], slug: string, label: string): FilterChip => ({
    key: `${facet}:${slug}`,
    facet,
    slug,
    label,
    accessibilityLabel: i18n.t('recipes.filters.removeChip', { label }),
  });
  if (filters.untagged) return [chip('untagged', 'untagged', i18n.t('recipes.filters.untagged'))];
  const chips: FilterChip[] = [];
  for (const facet of RECIPE_TAG_FACETS) {
    for (const v of facet.values) if (filters.tags[facet.key].includes(v.slug)) chips.push(chip(facet.key, v.slug, tagLabel(facet.key, v.slug)!));
  }
  for (const b of TIME_BUCKETS) if (filters.time.includes(b.key)) chips.push(chip('time', b.key, timeBucketLabel(b.key)));
  return chips;
}

/** The filters without one chip's value. */
export function removeFilterChip(filters: RecipeFilters, chip: FilterChip): RecipeFilters {
  if (chip.facet === 'untagged') return { ...filters, untagged: false };
  if (!isFilterPicked(filters, chip.facet, chip.slug)) return filters;
  return toggleRecipeFilter(filters, chip.facet, chip.slug);
}

/** "Filters", or "Filters · 2" while some are on. */
export function filtersPillLabel(count: number): string {
  return count > 0 ? i18n.t('recipes.filters.pill', { count }) : i18n.t('recipes.filters.title');
}

/** What VoiceOver reads for the pill: "Filters, 2 active". */
export function filtersPillAccessibilityLabel(count: number): string {
  return count > 0 ? i18n.t('recipes.filters.pillLabel', { count }) : i18n.t('recipes.filters.title');
}

/** The sheet's CTA: "Show 1 recipe", "Show 12 recipes". */
export function showRecipesLabel(count: number): string {
  return i18n.t('recipes.filters.show', { count });
}

/** The footer under filtered results: "3 recipes without tags aren't shown". */
export function untaggedFootnote(count: number): string {
  return i18n.t('recipes.tab.untagged', { count });
}
