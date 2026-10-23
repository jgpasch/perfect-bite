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

import type { FavoritesByRecipe } from './favorites';

const NO_FAVORITES: FavoritesByRecipe = new Map();

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
 * The Saved group's favorites values (4.14), before its tags: **Favorites** (a favorite of any
 * current member of the recipe's household, the user included) and **My favorites** (the user's own).
 * Filter values, not tags.
 */
export const FAVORITE_FILTERS = ['favorites', 'my-favorites'] as const;
export type FavoriteFilter = (typeof FAVORITE_FILTERS)[number];

const FAVORITE_FILTER_KEYS = { favorites: 'favorites', 'my-favorites': 'myFavorites' } as const;

function favoriteFilterLabel(value: FavoriteFilter): string {
  return i18n.t(`recipes.filters.${FAVORITE_FILTER_KEYS[value]}`);
}

/**
 * The picked values: OR within a facet, AND across facets; the favorites values are in the Saved
 * facet, with its tags. `untagged` shows only recipes without tags, a favorite or a time, and is
 * never combined with values.
 */
export type RecipeFilters = { tags: RecipeTags; favorites: FavoriteFilter[]; time: TimeBucket[]; untagged: boolean };

/** What filtering reads from a recipe (its favorites come by `id`). */
export type FilterableRecipe = { id: string; tags: RecipeTags | null; totalMinutes: number | null };

/** The sheet's facets: the six tag facets (Saved first), then Time. */
export type FilterFacetKey = RecipeTagFacetKey | 'time';

export function noRecipeFilters(): RecipeFilters {
  return { tags: emptyRecipeTags(), favorites: [], time: [], untagged: false };
}

/** Only the recipes without tags (the untagged footer's tap). */
export function untaggedOnlyFilters(): RecipeFilters {
  return { ...noRecipeFilters(), untagged: true };
}

/** How many filters are on: one per picked value, and one for Untagged. */
export function activeFilterCount(filters: RecipeFilters): number {
  const values =
    RECIPE_TAG_FACETS.reduce((n, f) => n + filters.tags[f.key].length, 0) + filters.favorites.length + filters.time.length;
  return values + (filters.untagged ? 1 : 0);
}

/** No known tag in any facet, no favorite and no time: nothing a filter could match. */
export function isUntaggedRecipe(recipe: FilterableRecipe, favorites: FavoritesByRecipe = NO_FAVORITES): boolean {
  if (timeBucket(recipe.totalMinutes) || favorites.has(recipe.id)) return false;
  if (!recipe.tags) return true;
  return RECIPE_TAG_FACETS.every((f) => !(recipe.tags![f.key] ?? []).some((slug) => recipeTagLabel(f.key, slug)));
}

/** The recipe's favorites values: Favorites with anyone's, My favorites with the user's own. */
function favoriteValues(recipe: FilterableRecipe, favorites: FavoritesByRecipe): FavoriteFilter[] {
  const favorite = favorites.get(recipe.id);
  if (!favorite) return [];
  return favorite.mine ? ['favorites', 'my-favorites'] : ['favorites'];
}

function facetValues(recipe: FilterableRecipe, facet: FilterFacetKey, favorites: FavoritesByRecipe): string[] {
  if (facet === 'time') {
    const bucket = timeBucket(recipe.totalMinutes);
    return bucket ? [bucket] : [];
  }
  const tags = recipe.tags?.[facet] ?? [];
  return facet === 'saved' ? [...favoriteValues(recipe, favorites), ...tags] : tags;
}

function picked(filters: RecipeFilters, facet: FilterFacetKey): readonly string[] {
  if (facet === 'time') return filters.time;
  return facet === 'saved' ? [...filters.favorites, ...filters.tags.saved] : filters.tags[facet];
}

const FACET_KEYS: readonly FilterFacetKey[] = [...RECIPE_TAG_FACETS.map((f) => f.key), 'time'];

/**
 * Whether a recipe passes: any picked value in each facet that has some (no filters passes all).
 * `favorites`: every recipe's, as `useRecipeFavorites` gives them.
 */
export function matchesRecipeFilters(
  recipe: FilterableRecipe,
  filters: RecipeFilters,
  favorites: FavoritesByRecipe = NO_FAVORITES,
): boolean {
  if (filters.untagged) return isUntaggedRecipe(recipe, favorites);
  return FACET_KEYS.every((facet) => {
    const want = picked(filters, facet);
    if (want.length === 0) return true;
    const has = facetValues(recipe, facet, favorites);
    return want.some((v) => has.includes(v));
  });
}

export function filterRecipes<R extends FilterableRecipe>(
  recipes: readonly R[],
  filters: RecipeFilters,
  favorites: FavoritesByRecipe = NO_FAVORITES,
): R[] {
  return recipes.filter((r) => matchesRecipeFilters(r, filters, favorites));
}

export type FilterFacet = {
  key: FilterFacetKey;
  label: string;
  values: { slug: string; label: string }[];
};

/** A facet's values in display order: the Saved facet's favorites values before its tags. */
function facetOptions(facet: RecipeTagFacetKey): { slug: string; label: string }[] {
  const tags = RECIPE_TAG_FACETS.find((f) => f.key === facet)!.values.map((v) => ({ slug: v.slug, label: tagLabel(facet, v.slug)! }));
  return facet === 'saved' ? [...FAVORITE_FILTERS.map((v) => ({ slug: v, label: favoriteFilterLabel(v) })), ...tags] : tags;
}

/**
 * The sheet's groups: each facet's values that some recipe has, in display order, with a facet
 * left out when none are. My favorites only while some recipe has another member's favorite (until
 * then it matches the same as Favorites). A picked value stays, so it can be turned off.
 */
export function availableFilterFacets(
  recipes: readonly FilterableRecipe[],
  filters: RecipeFilters,
  favorites: FavoritesByRecipe = NO_FAVORITES,
): FilterFacet[] {
  const all: { key: FilterFacetKey; label: string; values: readonly { slug: string; label: string }[] }[] = [
    ...RECIPE_TAG_FACETS.map((f) => ({ key: f.key, label: tagFacetLabel(f.key), values: facetOptions(f.key) })),
    { key: 'time', label: timeFacetLabel(), values: TIME_BUCKETS.map((b) => ({ slug: b.key, label: timeBucketLabel(b.key) })) },
  ];
  const othersFavorite = recipes.some((r) => (favorites.get(r.id)?.others.length ?? 0) > 0);
  const facets: FilterFacet[] = [];
  for (const facet of all) {
    const present = new Set(recipes.flatMap((r) => facetValues(r, facet.key, favorites)));
    if (!othersFavorite) present.delete('my-favorites');
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
  if (facet === 'saved') {
    const isFavorite = (v: string): v is FavoriteFilter => (FAVORITE_FILTERS as readonly string[]).includes(v);
    return {
      ...filters,
      favorites: next.filter(isFavorite),
      tags: { ...filters.tags, saved: next.filter((v) => !isFavorite(v)) },
      untagged: false,
    };
  }
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
    for (const v of facetOptions(facet.key)) if (isFilterPicked(filters, facet.key, v.slug)) chips.push(chip(facet.key, v.slug, v.label));
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
