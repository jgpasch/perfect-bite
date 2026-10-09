// Spec 5 ("Effective category") and 4.3.3. Pure: no React, SQLite or network.

import { OTHER_CATEGORY_ID } from '@/shared';

/**
 * The section an item shows under for one user: their override, else the ingredient's global
 * default, else Other. TODO(M6): unknown and pending ingredients show "Sorting..." instead.
 */
export function effectiveCategoryId(overrideId: string | null, defaultId: string | null): string {
  return overrideId ?? defaultId ?? OTHER_CATEGORY_ID;
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

/**
 * Groups items into sections in category order, hiding empty sections (spec 4.6). Items keep
 * their order within a section. An item whose category is unknown goes to Other.
 */
export function groupByCategory<C extends { id: string }, I extends { categoryId: string }>(
  orderedCategories: readonly C[],
  items: readonly I[],
): Section<C, I>[] {
  const known = new Set(orderedCategories.map((c) => c.id));
  const byCategory = new Map<string, I[]>();
  for (const item of items) {
    const id = known.has(item.categoryId) ? item.categoryId : OTHER_CATEGORY_ID;
    byCategory.set(id, [...(byCategory.get(id) ?? []), item]);
  }
  return orderedCategories
    .filter((c) => byCategory.has(c.id))
    .map((category) => ({ category, items: byCategory.get(category.id)! }));
}
