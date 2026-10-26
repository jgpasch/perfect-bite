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
import { currentLanguage, i18n } from '@/i18n';
import { tagFacetLabel, tagLabel } from '@/i18n/vocabulary';
import { foldAccents } from '@/shared/ingredient-normalizer';

import type { CollectionsByRecipe } from './collections';
import type { FavoritesByRecipe } from './favorites';

const NO_FAVORITES: FavoritesByRecipe = new Map();
const NO_COLLECTIONS: CollectionsByRecipe = new Map();

/** How collection names compare: ignoring case and accents, for duplicates and for the Collections group. */
export function collectionNameKey(name: string): string {
  return foldAccents(name).toLocaleLowerCase();
}

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
 * facet, with its tags. `collections` holds picked collection names (recipe collections board E): a
 * name matches every collection called that in the user's households, ignoring case and accents.
 * `untagged` shows only recipes without tags, a favorite or a time, and is never combined with values.
 */
export type RecipeFilters = {
  tags: RecipeTags;
  favorites: FavoriteFilter[];
  collections: string[];
  time: TimeBucket[];
  untagged: boolean;
};

/** What filtering reads from a recipe (its favorites come by `id`). */
export type FilterableRecipe = { id: string; tags: RecipeTags | null; totalMinutes: number | null };

/** The sheet's facets: the six tag facets (Saved first, then Collections), then Time. */
export type FilterFacetKey = RecipeTagFacetKey | 'collections' | 'time';

export function noRecipeFilters(): RecipeFilters {
  return { tags: emptyRecipeTags(), favorites: [], collections: [], time: [], untagged: false };
}

/** Only the recipes without tags (the untagged footer's tap). */
export function untaggedOnlyFilters(): RecipeFilters {
  return { ...noRecipeFilters(), untagged: true };
}

/** How many filters are on: one per picked value, and one for Untagged. */
export function activeFilterCount(filters: RecipeFilters): number {
  const values =
    RECIPE_TAG_FACETS.reduce((n, f) => n + filters.tags[f.key].length, 0) +
    filters.favorites.length +
    filters.collections.length +
    filters.time.length;
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

/** What filtering reads beside the recipes: their favorites and the names of the collections they're in. */
type Lookups = { favorites: FavoritesByRecipe; collections: CollectionsByRecipe };

/** The recipe's values in the facet; the Collections group's as name keys. */
function facetValues(recipe: FilterableRecipe, facet: FilterFacetKey, { favorites, collections }: Lookups): string[] {
  if (facet === 'collections') return (collections.get(recipe.id) ?? []).map(collectionNameKey);
  if (facet === 'time') {
    const bucket = timeBucket(recipe.totalMinutes);
    return bucket ? [bucket] : [];
  }
  const tags = recipe.tags?.[facet] ?? [];
  return facet === 'saved' ? [...favoriteValues(recipe, favorites), ...tags] : tags;
}

/** The facet's picked values; the Collections group's as name keys. */
function picked(filters: RecipeFilters, facet: FilterFacetKey): readonly string[] {
  if (facet === 'collections') return filters.collections.map(collectionNameKey);
  if (facet === 'time') return filters.time;
  return facet === 'saved' ? [...filters.favorites, ...filters.tags.saved] : filters.tags[facet];
}

const FACET_KEYS: readonly FilterFacetKey[] = [...RECIPE_TAG_FACETS.map((f) => f.key), 'collections', 'time'];

/**
 * Whether a recipe passes: any picked value in each facet that has some (no filters passes all).
 * `favorites`: every recipe's, as `useRecipeFavorites` gives them. `collections`: the names of the
 * collections each recipe is in, as `useCollectionsByRecipe` gives them.
 */
export function matchesRecipeFilters(
  recipe: FilterableRecipe,
  filters: RecipeFilters,
  favorites: FavoritesByRecipe = NO_FAVORITES,
  collections: CollectionsByRecipe = NO_COLLECTIONS,
): boolean {
  if (filters.untagged) return isUntaggedRecipe(recipe, favorites);
  return FACET_KEYS.every((facet) => {
    const want = picked(filters, facet);
    if (want.length === 0) return true;
    const has = facetValues(recipe, facet, { favorites, collections });
    return want.some((v) => has.includes(v));
  });
}

export function filterRecipes<R extends FilterableRecipe>(
  recipes: readonly R[],
  filters: RecipeFilters,
  favorites: FavoritesByRecipe = NO_FAVORITES,
  collections: CollectionsByRecipe = NO_COLLECTIONS,
): R[] {
  return recipes.filter((r) => matchesRecipeFilters(r, filters, favorites, collections));
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

/** The Collections group's name, after Saved. */
export function collectionsFacetLabel(): string {
  return i18n.t('recipes.filters.collections');
}

/**
 * The Collections group's values, A–Z: one per name (ignoring case and accents) that a collection holding
 * one of `recipes` has, so two households' collections called the same show once, and any picked name
 * besides. The slug is the name as shown (its first spelling A–Z) and matches every collection called that.
 */
function collectionOptions(
  recipes: readonly FilterableRecipe[],
  filters: RecipeFilters,
  collections: CollectionsByRecipe,
): { slug: string; label: string }[] {
  // Full sensitivity, so of two spellings of a name the unaccented, lowercase one comes first.
  const collator = new Intl.Collator(currentLanguage(), { numeric: true });
  const names = [...recipes.flatMap((r) => collections.get(r.id) ?? []), ...filters.collections].sort(
    (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0),
  );
  const byKey = new Map<string, string>();
  for (const name of names) if (!byKey.has(collectionNameKey(name))) byKey.set(collectionNameKey(name), name);
  return [...byKey.values()].map((name) => ({ slug: name, label: name }));
}

/**
 * The sheet's groups: each facet's values that some recipe has, in display order, with a facet
 * left out when none are. My favorites only while some recipe has another member's favorite (until
 * then it matches the same as Favorites). Collections, right after Saved, only with `collections`
 * given (the collection screen's sheet leaves it out). A picked value stays, so it can be turned off.
 */
export function availableFilterFacets(
  recipes: readonly FilterableRecipe[],
  filters: RecipeFilters,
  favorites: FavoritesByRecipe = NO_FAVORITES,
  collections: CollectionsByRecipe = NO_COLLECTIONS,
): FilterFacet[] {
  const lookups = { favorites, collections };
  const all: { key: FilterFacetKey; label: string; values: readonly { slug: string; label: string }[] }[] = [
    ...RECIPE_TAG_FACETS.map((f) => ({ key: f.key, label: tagFacetLabel(f.key), values: facetOptions(f.key) })),
    { key: 'time', label: timeFacetLabel(), values: TIME_BUCKETS.map((b) => ({ slug: b.key, label: timeBucketLabel(b.key) })) },
  ];
  const othersFavorite = recipes.some((r) => (favorites.get(r.id)?.others.length ?? 0) > 0);
  const facets: FilterFacet[] = [];
  for (const facet of all) {
    const present = new Set(recipes.flatMap((r) => facetValues(r, facet.key, lookups)));
    if (!othersFavorite) present.delete('my-favorites');
    for (const v of picked(filters, facet.key)) present.add(v);
    const values = facet.values.filter((v) => present.has(v.slug)).map((v) => ({ slug: v.slug, label: v.label }));
    if (values.length > 0) facets.push({ key: facet.key, label: facet.label, values });
    if (facet.key === 'saved') {
      const names = collectionOptions(recipes, filters, collections);
      if (names.length > 0) facets.push({ key: 'collections', label: collectionsFacetLabel(), values: names });
    }
  }
  return facets;
}

/** Whether a value is on; a collection name by its key, so any spelling of a picked name is on. */
export function isFilterPicked(filters: RecipeFilters, facet: FilterFacetKey, slug: string): boolean {
  return picked(filters, facet).includes(facet === 'collections' ? collectionNameKey(slug) : slug);
}

/** Turns a value on or off. Picking a value leaves Untagged. */
export function toggleRecipeFilter(filters: RecipeFilters, facet: FilterFacetKey, slug: string): RecipeFilters {
  if (facet === 'collections') {
    const key = collectionNameKey(slug);
    const others = filters.collections.filter((name) => collectionNameKey(name) !== key);
    const next = others.length < filters.collections.length ? others : [...filters.collections, slug];
    return { ...filters, collections: next, untagged: false };
  }
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
    if (facet.key === 'saved') for (const name of filters.collections) chips.push(chip('collections', name, name));
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

/**
 * The filters without the picked collection names no live collection has any more (it was deleted, or
 * renamed); `liveNames`: every live collection's name in the user's households. The same object when
 * nothing drops out.
 */
export function withoutGoneCollections(filters: RecipeFilters, liveNames: readonly string[]): RecipeFilters {
  const live = new Set(liveNames.map(collectionNameKey));
  const kept = filters.collections.filter((name) => live.has(collectionNameKey(name)));
  return kept.length === filters.collections.length ? filters : { ...filters, collections: kept };
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
