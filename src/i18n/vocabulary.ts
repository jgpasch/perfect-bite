// Spec 4.15: fixed vocabularies are stored as slugs or unit keys and shown in the app's language.
// Nothing here changes what's stored: the database keeps the slug and the English name.
import type { Unit } from '@/shared';
import { RECIPE_TAG_FACETS, type CuisineRegion, type RecipeTagFacetKey } from '@/shared/recipe-tags';
import { SYSTEM_CATEGORIES, type CategorySlug } from '@/shared/seed/categories';

import { en } from './en';
import { es } from './es';
import { i18n } from './index';

const AISLE_SLUGS = new Set<string>(SYSTEM_CATEGORIES.map((c) => c.slug));

function isAisleSlug(slug: string | null | undefined): slug is CategorySlug {
  return slug != null && AISLE_SLUGS.has(slug);
}

/**
 * A category's name to show: a system aisle's in the app's language, by slug; a custom aisle's
 * (no slug, or one this app doesn't know) as the household typed it.
 */
export function aisleName(category: { slug: string | null; name: string }): string {
  return isAisleSlug(category.slug) ? i18n.t(`vocab.aisles.${category.slug}`) : category.name;
}

/** The categories with `aisleName`'s names, everything else kept. */
export function withAisleNames<T extends { slug: string | null; name: string }>(categories: readonly T[]): T[] {
  return categories.map((c) => ({ ...c, name: aisleName(c) }));
}

/** Lowercase, accents and extra spaces dropped: `  LÁCTEOS ` → `lacteos`. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Every language's name for each system aisle, folded, to the aisle's slug. */
const AISLE_BY_NAME = new Map<string, CategorySlug>(
  [en, es].flatMap((strings) =>
    Object.entries(strings.vocab.aisles).map(([slug, name]) => [fold(name), slug as CategorySlug] as const),
  ),
);

/**
 * The system aisle a typed name means, in English or Spanish whatever the app's language,
 * ignoring case and accents (`lacteos` → `dairy-eggs`); null when it's none of them.
 */
export function systemAisleSlug(name: string): CategorySlug | null {
  return AISLE_BY_NAME.get(fold(name)) ?? null;
}

/** A tag facet's name: `meal` → "Meal". */
export function tagFacetLabel(facet: RecipeTagFacetKey): string {
  return i18n.t(`vocab.tagFacets.${facet}`);
}

/** A known tag's label in the app's language (`dinner` → "Dinner"), else null. */
export function tagLabel(facet: RecipeTagFacetKey, slug: string): string | null {
  const values: readonly { slug: string }[] = RECIPE_TAG_FACETS.find((f) => f.key === facet)!.values;
  if (!values.some((v) => v.slug === slug)) return null;
  return i18n.t(`vocab.tags.${facet}.${slug}` as `vocab.tags.meal.dinner`);
}

/** A cuisine region's name (spec 11.5): `latin` → "Latin". */
export function cuisineRegionLabel(region: CuisineRegion): string {
  return i18n.t(`vocab.cuisineRegions.${region}`);
}

const UNIT_KEYS = { 'fl oz': 'flOz' } as const;

/**
 * A unit after an amount: `cup` → "cup" in English (the key), "taza" or "tazas" in Spanish. One or
 * less reads singular (*½ taza*, *1 taza*, *1½ tazas*); abbreviations (`kg`, `lb`, `gal`) don't change.
 */
export function unitName(unit: Unit, quantity = 1): string {
  const key = unit === 'fl oz' ? UNIT_KEYS[unit] : unit;
  return i18n.t(`vocab.units.${key}`, { count: Math.max(quantity, 1) });
}
