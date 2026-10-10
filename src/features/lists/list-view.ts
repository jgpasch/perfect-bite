// What the Pantry lists home and list screen show (boards 01–03). Pure, so it can be tested
// without rendering.

import { sectionAccessibilityLabel, SORTING_CATEGORY } from '@/domain/category-resolver';

// --- Lists home ----------------------------------------------------------------------------

export type HouseholdGroup<L> = { householdId: string; name: string; lists: L[] };

/**
 * Lists grouped under their household, keeping the user's list order inside each group. Households
 * come in the order their first list does.
 */
export function groupListsByHousehold<L extends { householdId: string; householdName: string }>(
  lists: readonly L[],
): HouseholdGroup<L>[] {
  const groups = new Map<string, HouseholdGroup<L>>();
  for (const list of lists) {
    const group = groups.get(list.householdId) ?? { householdId: list.householdId, name: list.householdName, lists: [] };
    group.lists.push(list);
    groups.set(list.householdId, group);
  }
  return [...groups.values()];
}

/** Grid cells two to a row; the last row may have one. */
export function pairs<T>(cells: readonly T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < cells.length; i += 2) rows.push(cells.slice(i, i + 2));
  return rows;
}

/** A tile's headline: the count of items to get, or "All done" when there are none. */
export function tileCount(count: number): { kind: 'count'; text: string } | { kind: 'done'; text: string } {
  return count > 0 ? { kind: 'count', text: String(count) } : { kind: 'done', text: 'All done' };
}

/** What VoiceOver reads for a list tile: "Groceries, 12 items to get, Siri list". */
export function tileAccessibilityLabel(
  name: string,
  count: number,
  { isDefault = false, archived = false }: { isDefault?: boolean; archived?: boolean } = {},
): string {
  const parts = [name, count > 0 ? `${count} ${count === 1 ? 'item' : 'items'} to get` : 'all done'];
  if (isDefault) parts.push('Siri list');
  if (archived) parts.push('archived');
  return parts.join(', ');
}

// --- List screen ---------------------------------------------------------------------------

/** "12 to get" beside the list's title; nothing when the list has nothing to get. */
export function toGetLabel(uncheckedCount: number): string | null {
  return uncheckedCount > 0 ? `${uncheckedCount} to get` : null;
}

/** The second line on an item that is in other recipes too (By recipe). */
export function alsoInHint(alsoIn: readonly string[]): string | undefined {
  return alsoIn.length > 0 ? `Also in ${alsoIn.join(', ')}` : undefined;
}

/** The label on each row in the Sorting… card. */
export const SORTING_LABEL = 'Sorting…';

/**
 * What VoiceOver reads for an item row: name, amount, note and hint, and for an item still waiting
 * for an aisle, the Sorting section's label.
 */
export function itemRowLabel(
  parts: { name: string; amountText?: string; note?: string | null; hint?: string },
  sorting = false,
): string {
  return [parts.name, parts.amountText, parts.note, parts.hint, sorting ? sectionAccessibilityLabel(SORTING_CATEGORY) : null]
    .filter(Boolean)
    .join(', ');
}

/** The toast after an add merged into an item: "Added to milk, now 1 gal + 1"; the name is set in bold. */
export function addedToast(name: string, totalAmountText: string | null | undefined): { message: string; emphasis: string } {
  return { message: totalAmountText ? `Added to ${name}, now ${totalAmountText}` : `Added to ${name}`, emphasis: name };
}
