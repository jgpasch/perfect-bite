// Spec 4.6, By recipe view. Pure: no React, SQLite or network.

import type { Amount } from './quantity-display';
import { summarizeAmounts } from './quantity-math';

type Contribution = Amount & { source: string; recipeId: string | null; recipeName: string | null; createdAt: Date };

/** Same rule as the row total (`itemTotal`): a recipe link with no quantity isn't an amount. */
const total = (cs: readonly Contribution[]) =>
  summarizeAmounts(cs.filter((c) => !(c.source === 'recipe' && c.quantity === null)));

export type RecipeEntry<I> = {
  item: I;
  /** This section's share of the item: the recipe's amounts, or all amounts under Other items. */
  amountText: string;
  /** The item's other recipes, for the "also in: Tacos" hint. */
  alsoIn: string[];
};

export type RecipeSection<I> = {
  /** null: the final Other items section. */
  recipeId: string | null;
  name: string;
  entries: RecipeEntry<I>[];
};

/**
 * One section per recipe with an amount on the list, most recently added first, then Other
 * items: items with no recipe amounts at all. An item from several recipes appears under each,
 * with that recipe's amount. Items keep their order within a section.
 */
export function groupByRecipe<I extends { contributions: readonly Contribution[] }>(
  items: readonly I[],
): RecipeSection<I>[] {
  const sections = new Map<string, { name: string; latest: number; entries: RecipeEntry<I>[] }>();
  const other: RecipeEntry<I>[] = [];

  for (const item of items) {
    const byRecipe = new Map<string, Contribution[]>();
    for (const c of item.contributions) {
      if (c.recipeId === null) continue;
      byRecipe.set(c.recipeId, [...(byRecipe.get(c.recipeId) ?? []), c]);
    }
    if (byRecipe.size === 0) {
      other.push({ item, amountText: total(item.contributions), alsoIn: [] });
      continue;
    }
    const names = [...byRecipe.values()].map((cs) => cs[0].recipeName ?? '');
    for (const [recipeId, cs] of byRecipe) {
      const name = cs[0].recipeName ?? '';
      const latest = Math.max(...cs.map((c) => c.createdAt.getTime()));
      const section = sections.get(recipeId) ?? { name, latest, entries: [] };
      section.latest = Math.max(section.latest, latest);
      section.entries.push({ item, amountText: total(cs), alsoIn: names.filter((n) => n !== name) });
      sections.set(recipeId, section);
    }
  }

  const ordered: RecipeSection<I>[] = [...sections.entries()]
    .sort(([, a], [, b]) => b.latest - a.latest)
    .map(([recipeId, s]) => ({ recipeId, name: s.name, entries: s.entries }));
  if (other.length > 0) ordered.push({ recipeId: null, name: 'Other items', entries: other });
  return ordered;
}
