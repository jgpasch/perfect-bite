// Spec 5 ("Effective category") and 4.3.3. Pure: no React, SQLite or network.

import { i18n } from '@/i18n';
import { OTHER_CATEGORY_ID } from '@/shared';

/** The "Sorting..." section's id: not a real category, for ingredients awaiting categorization. */
export const SORTING_CATEGORY_ID = 'sorting';

export type IngredientStatus = 'pending' | 'categorized' | 'failed';

/**
 * The section an item shows under for one user: their household's override (read under the
 * ingredient's family key, spec 4.15, so linked names share it), else the ingredient's global
 * default, else "Sorting..." while it is pending or has no ingredient row (spec 4.3.1), else
 * Other (categorization failed). `sorts` false (the user's plan has no `categorize`, spec 4.12):
 * nothing is waiting for an aisle, so those go to Other too.
 */
export function effectiveCategoryId(
  overrideId: string | null,
  defaultId: string | null,
  status: IngredientStatus | null,
  sorts = true,
): string {
  const chosen = overrideId ?? defaultId;
  if (chosen) return chosen;
  return sorts && (status === 'pending' || status === null) ? SORTING_CATEGORY_ID : OTHER_CATEGORY_ID;
}

export type OrderableCategory = {
  id: string;
  name: string;
  /** The user's position, if they have reordered. */
  position: number | null;
  /** Store-walk order for system categories; null for custom ones. */
  defaultRank: number | null;
};

/**
 * A user's category order: categories they have placed, by position; then system categories by
 * store-walk order; then custom ones by name. With no reordering this is the 6.2 order.
 */
export function orderCategories<T extends OrderableCategory>(categories: readonly T[]): T[] {
  const tier = (c: T) => (c.position !== null ? 0 : c.defaultRank !== null ? 1 : 2);
  return [...categories].sort((a, b) => {
    if (tier(a) !== tier(b)) return tier(a) - tier(b);
    if (a.position !== null && b.position !== null) return a.position - b.position;
    if (a.defaultRank !== null && b.defaultRank !== null) return a.defaultRank - b.defaultRank;
    return a.name.localeCompare(b.name);
  });
}

export type Section<C, I> = { category: C; items: I[] };

/** The "Sorting..." section's category, which isn't stored. */
export type SortingCategory = { id: typeof SORTING_CATEGORY_ID; name: string };
export const SORTING_CATEGORY: SortingCategory = { id: SORTING_CATEGORY_ID, name: 'Sorting...' };

/** What VoiceOver reads for a section header: the "Sorting..." section says what it's for. */
export function sectionAccessibilityLabel(category: { id: string; name: string }): string {
  return category.id === SORTING_CATEGORY_ID ? 'Sorting, finding a section for these items' : category.name;
}

/** A category's name by id: "Sorting..." for the Sorting section, else Other when it isn't found. */
export function categoryNameById(categories: readonly { id: string; name: string }[], id: string): string {
  if (id === SORTING_CATEGORY_ID) return SORTING_CATEGORY.name;
  return categories.find((c) => c.id === id)?.name ?? i18n.t('vocab.aisles.other');
}

/**
 * Groups items into sections in category order, hiding empty sections (spec 4.6). Items keep
 * their order within a section. A "Sorting..." section comes first, whatever the user's order
 * (spec 4.3.1), when it has items. An item whose category is unknown goes to Other.
 */
export function groupByCategory<C extends { id: string }, I extends { categoryId: string }>(
  orderedCategories: readonly C[],
  items: readonly I[],
): Section<C | SortingCategory, I>[] {
  const known = new Set([SORTING_CATEGORY_ID, ...orderedCategories.map((c) => c.id)]);
  const byCategory = new Map<string, I[]>();
  for (const item of items) {
    const id = known.has(item.categoryId) ? item.categoryId : OTHER_CATEGORY_ID;
    byCategory.set(id, [...(byCategory.get(id) ?? []), item]);
  }
  return [SORTING_CATEGORY, ...orderedCategories]
    .filter((c) => byCategory.has(c.id))
    .map((category) => ({ category, items: byCategory.get(category.id)! }));
}
