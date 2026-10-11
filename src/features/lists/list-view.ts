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

// --- Launch --------------------------------------------------------------------------------

/**
 * The list a cold launch opens (spec 4.1): the last one opened, else the default list, else the
 * first list. Only ids still in `lists` (the open lists, in order) count; null means the Lists home.
 */
export function launchListId(
  lastOpenedId: string | null,
  defaultId: string | null,
  lists: readonly { id: string }[],
): string | null {
  const open = (id: string | null) => id !== null && lists.some((l) => l.id === id);
  if (open(lastOpenedId)) return lastOpenedId;
  if (open(defaultId)) return defaultId;
  return lists[0]?.id ?? null;
}

// --- List screen ---------------------------------------------------------------------------

/** "12 to get" beside the list's title; nothing when the list has nothing to get. */
export function toGetLabel(uncheckedCount: number): string | null {
  return uncheckedCount > 0 ? `${uncheckedCount} to get` : null;
}

export type ListViewMode = 'newest' | 'category' | 'recipe';

/** The list screen's segments (spec 4.6), in order; each is a tab, so the hint says what it shows. */
export const LIST_VIEW_MODES: readonly { value: ListViewMode; label: string; hint?: string }[] = [
  { value: 'newest', label: 'Newest', hint: 'Items you added most recently first' },
  { value: 'category', label: 'By aisle' },
  { value: 'recipe', label: 'By recipe' },
];

/** A list with no saved choice on this device opens in Newest. */
export const DEFAULT_LIST_VIEW_MODE: ListViewMode = 'newest';

/** Where the device setting for a list's view mode lives. Saved choices from before Newest still read. */
export const viewModeKey = (listId: string) => `list.${listId}.viewMode`;

type NewestItem = {
  id: string;
  createdAt: Date;
  checkedAt: Date | null;
  contributions: readonly { id: string; createdAt: Date }[];
};

/**
 * The Newest view (spec 4.6): unchecked items, latest first by the earliest of each item's current
 * amounts. A Combine adds a later amount, so the item keeps its place; re-adding a checked item
 * replaces its amounts, so it moves to the top. A recipe add shares one timestamp and its amounts'
 * ids (UUIDv7) count up in ingredient order, so ties go by that id, then the item's id. An item with
 * no amounts goes by its own `createdAt` and id.
 */
export function orderByNewest<T extends NewestItem>(items: readonly T[]): T[] {
  const keyed = items
    .filter((item) => item.checkedAt === null)
    .map((item) => {
      let first: { id: string; createdAt: Date } | undefined;
      for (const c of item.contributions) {
        const t = c.createdAt.getTime();
        if (!first || t < first.createdAt.getTime() || (t === first.createdAt.getTime() && c.id < first.id)) first = c;
      }
      return { item, at: (first ?? item).createdAt.getTime(), tie: (first ?? item).id };
    });
  const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  keyed.sort((a, b) => b.at - a.at || byId(a.tie, b.tie) || byId(a.item.id, b.item.id));
  return keyed.map((k) => k.item);
}

/** The second line on an item that is in other recipes too (By recipe). */
export function alsoInHint(alsoIn: readonly string[]): string | undefined {
  return alsoIn.length > 0 ? `Also in ${alsoIn.join(', ')}` : undefined;
}

/** The label on each row in the Sorting… card. */
export const SORTING_LABEL = 'Sorting…';

/**
 * What VoiceOver reads for an item row: name, amount, note and hint, then its aisle (Newest shows it
 * as a dot) or, for an item still waiting for an aisle, the Sorting section's label.
 */
export function itemRowLabel(
  parts: { name: string; amountText?: string; note?: string | null; hint?: string; aisle?: string },
  sorting = false,
): string {
  return [parts.name, parts.amountText, parts.note, parts.hint, sorting ? sectionAccessibilityLabel(SORTING_CATEGORY) : parts.aisle]
    .filter(Boolean)
    .join(', ');
}

/** What VoiceOver reads for an item's round check: "Check off Limes" (its checked state is read separately). */
export function checkOffLabel(name: string): string {
  return `Check off ${name}`;
}

/** The custom action on an item row that toggles its check: "Check off", or "Uncheck" once it's checked. */
export function toggleActionLabel(checked: boolean): string {
  return checked ? 'Uncheck' : 'Check off';
}

/** The toast after an add merged into an item: "Added to milk, now 1 gal + 1"; the name is set in bold. */
export function addedToast(name: string, totalAmountText: string | null | undefined): { message: string; emphasis: string } {
  return { message: totalAmountText ? `Added to ${name}, now ${totalAmountText}` : `Added to ${name}`, emphasis: name };
}

/**
 * The toast on the list an item moved to: a Combine reads as an add would ("Added to milk, now
 * 2 gal"); otherwise "Moved milk from Groceries".
 */
export function movedToast(move: {
  kind: 'new' | 'combine' | 'reopen';
  name: string;
  totalAmountText?: string;
  fromListName: string;
}): { message: string; emphasis: string } {
  if (move.kind === 'combine') return addedToast(move.name, move.totalAmountText);
  return { message: move.fromListName ? `Moved ${move.name} from ${move.fromListName}` : `Moved ${move.name}`, emphasis: move.name };
}

/** The toast on a list screen after the Siri queue drained (spec 4.9): "Siri added 2 items". */
export function siriAddedToast(count: number): { message: string } {
  return { message: `Siri added ${count} ${count === 1 ? 'item' : 'items'}` };
}
