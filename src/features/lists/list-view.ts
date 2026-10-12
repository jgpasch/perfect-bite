// What the Pantry lists home and list screen show (boards 01–03). Pure, so it can be tested
// without rendering.

import type { IconName } from '@/components/icon';
import { sectionAccessibilityLabel, SORTING_CATEGORY } from '@/domain/category-resolver';
import { displayItemName, normalizeIngredientName, parseQuantity } from '@/shared';

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

/**
 * What the Lists home shows. With one household there is no household UI: just its lists. With more,
 * one section per household, always open, even when it has no lists yet (it still gets a New list
 * tile). The primary household comes first, then the rest by name.
 */
export type ListsOverview<L> =
  | { kind: 'single'; householdId: string | null; lists: L[] }
  | { kind: 'multi'; sections: HouseholdGroup<L>[] };

export function listsOverview<L extends { householdId: string }>(
  householdRows: readonly { id: string; name: string }[],
  lists: readonly L[],
  primaryId: string | null,
): ListsOverview<L> {
  if (householdRows.length <= 1) return { kind: 'single', householdId: householdRows[0]?.id ?? null, lists: [...lists] };
  const byName = (a: { id: string; name: string }, b: { id: string; name: string }) =>
    (a.id === primaryId ? -1 : 0) - (b.id === primaryId ? -1 : 0) ||
    a.name.localeCompare(b.name) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    kind: 'multi',
    sections: [...householdRows].sort(byName).map((h) => ({
      householdId: h.id,
      name: h.name,
      lists: lists.filter((l) => l.householdId === h.id),
    })),
  };
}

/** What VoiceOver reads for a household's section header: "test fam, 2 members", or just the name when the members aren't known. */
export function householdHeaderLabel(name: string, memberCount?: number): string {
  return memberCount === undefined ? name : `${name}, ${memberCount} ${memberCount === 1 ? 'member' : 'members'}`;
}

/** A household's New list tile is the short one when it would sit alone on a new row. */
export function newListTileIsCompact(listCount: number): boolean {
  return listCount % 2 === 0;
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

/** The list screen's views (spec 4.6), in menu order, each with its menu icon. */
export const LIST_VIEW_MODES: readonly { value: ListViewMode; label: string; icon: IconName }[] = [
  { value: 'newest', label: 'As added', icon: 'clock' },
  { value: 'category', label: 'By aisle', icon: 'cart' },
  { value: 'recipe', label: 'By recipe', icon: 'fork.knife' },
];

/** A list with no saved choice on this device opens in As added. */
export const DEFAULT_LIST_VIEW_MODE: ListViewMode = 'newest';

/** The view's name, as the view button and the menu show it: `As added`. */
export function viewModeLabel(mode: ListViewMode): string {
  return LIST_VIEW_MODES.find((m) => m.value === mode)?.label ?? '';
}

/** What VoiceOver reads for the view button: `View: As added`. */
export function viewButtonAccessibilityLabel(mode: ListViewMode): string {
  return `View: ${viewModeLabel(mode)}`;
}

export const VIEW_BUTTON_HINT = 'Changes how the list is grouped';

/** The compact add-mode header's second line: the count and the view, `8 to get · As added`. */
export function compactHeaderSubtitle(uncheckedCount: number, mode: ListViewMode): string {
  return [toGetLabel(uncheckedCount), viewModeLabel(mode)].filter(Boolean).join(' · ');
}

/**
 * While typing in the add bar, the ingredient key that unchecked items are checked against for the "already on
 * list" highlight: the typed name without its amount, normalized like an add (`2 lbs Chi` → `chi`). Null under
 * 2 characters, as autocomplete.
 */
export function duplicateQuery(text: string): string | null {
  const key = normalizeIngredientName(parseQuantity(text).name);
  return key.length >= 2 ? key : null;
}

/** Shown in place of the amount on an item that matches the add text. */
export const ALREADY_ON_LIST_LABEL = 'already on list';

/** An unchecked item whose key starts with or contains the typed key is already on the list. */
export function isAlreadyOnList(item: { ingredientName: string; checkedAt: Date | null }, query: string | null): boolean {
  return query !== null && item.checkedAt === null && item.ingredientName.includes(query);
}

/** Where the device setting for a list's view mode lives. Saved choices from before As added still read. */
export const viewModeKey = (listId: string) => `list.${listId}.viewMode`;

/**
 * Where By aisle shows each aisle's colour: tinting every unchecked row (the default), or only the card's
 * header, with plain rows under it. A device setting, like the view mode.
 */
export type AisleColorStyle = 'rows' | 'header';

export const AISLE_COLORS_KEY = 'list.aisleColors';

export const DEFAULT_AISLE_COLOR_STYLE: AisleColorStyle = 'rows';

/** The choices on Settings > Aisle colours, in order. */
export const AISLE_COLOR_STYLES: readonly { value: AisleColorStyle; label: string }[] = [
  { value: 'rows', label: 'Whole row' },
  { value: 'header', label: 'Header only' },
];

/** The saved aisle colours choice, read defensively: anything unknown is the default. */
export function readAisleColorStyle(saved: unknown): AisleColorStyle {
  return AISLE_COLOR_STYLES.some((s) => s.value === saved) ? (saved as AisleColorStyle) : DEFAULT_AISLE_COLOR_STYLE;
}

/** The choice's label, for the Settings row. */
export function aisleColorStyleLabel(style: AisleColorStyle): string {
  return AISLE_COLOR_STYLES.find((s) => s.value === style)?.label ?? '';
}

/** The view modes with sections that fold away (spec 4.6); As added has none. */
export type SectionedViewMode = Exclude<ListViewMode, 'newest'>;

/** Where the device setting for a list's collapsed sections in one view mode lives. */
export const collapsedSectionsKey = (listId: string, mode: SectionedViewMode) => `list.${listId}.collapsed.${mode}`;

/** A By aisle section's key, as saved: `c-<categoryId>`. */
export const aisleSectionKey = (categoryId: string) => `c-${categoryId}`;

/** A By recipe section's key, as saved: `r-<recipeId>`, or `r-other` for Other items. */
export const recipeSectionKey = (recipeId: string | null) => `r-${recipeId ?? 'other'}`;

/** The saved collapsed section keys, read defensively: anything that isn't a list of strings counts as none. */
export function readCollapsedSections(saved: unknown): string[] {
  if (!Array.isArray(saved)) return [];
  return [...new Set(saved.filter((key): key is string => typeof key === 'string'))];
}

/** Folds the section away, or opens it if it was folded. */
export function toggleCollapsedSection(saved: readonly string[], key: string): string[] {
  return saved.includes(key) ? saved.filter((k) => k !== key) : [...saved, key];
}

/** Opens the section; the saved keys come back unchanged if it wasn't folded. */
export function expandSection(saved: readonly string[], key: string): readonly string[] {
  return saved.includes(key) ? saved.filter((k) => k !== key) : saved;
}

/**
 * The sections showing now that are folded. Saved keys for sections that aren't showing (a recipe
 * removed from the list, an aisle with nothing left to get) are ignored but kept, so the section is
 * still folded if it comes back.
 */
export function collapsedShowing(saved: readonly string[], sectionKeys: readonly string[]): Set<string> {
  const showing = new Set(sectionKeys);
  return new Set(saved.filter((key) => showing.has(key)));
}

type NewestItem = {
  id: string;
  createdAt: Date;
  checkedAt: Date | null;
  contributions: readonly { id: string; createdAt: Date }[];
};

/**
 * The As added view (spec 4.6): unchecked items, latest first by the earliest of each item's current
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

/**
 * The second line on a checked item from a recipe: "From Tacos". Checking leaves an item's recipe
 * amounts in place, so it still knows its recipes while it sits in Checked.
 */
export function fromRecipesHint(contributions: readonly { recipeId: string | null; recipeName: string | null }[]): string | undefined {
  const names = [...new Set(contributions.flatMap((c) => (c.recipeId !== null && c.recipeName ? [c.recipeName] : [])))];
  return names.length > 0 ? `From ${names.join(', ')}` : undefined;
}

/** How long a just-checked row stays where it was, struck through, so a second tap can take it back. */
export const CHECK_LINGER_MS = 1000;

/**
 * The items each view places, given the ids checked a moment ago: those stay in their unchecked
 * place (as if unchecked, for placement only) and leave Checked until the linger ends.
 */
export function withLingering<I extends { id: string; checkedAt: Date | null }>(
  unchecked: readonly I[],
  checked: readonly I[],
  lingering: ReadonlySet<string>,
): { placed: I[]; checked: I[] } {
  if (lingering.size === 0) return { placed: [...unchecked], checked: [...checked] };
  return {
    placed: [...unchecked, ...checked.filter((i) => lingering.has(i.id)).map((i) => ({ ...i, checkedAt: null }))],
    checked: checked.filter((i) => !lingering.has(i.id)),
  };
}

/** The label on each row in the Sorting… card. */
export const SORTING_LABEL = 'Sorting…';

/**
 * What VoiceOver reads for an item row: name, amount, note and hint, then its aisle (As added shows it
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

/** The toast after an add merged into an item: "Added to Milk, now 1 gal + 1"; the name is set in bold. */
export function addedToast(storedName: string, totalAmountText: string | null | undefined): { message: string; emphasis: string } {
  const name = displayItemName(storedName);
  return { message: totalAmountText ? `Added to ${name}, now ${totalAmountText}` : `Added to ${name}`, emphasis: name };
}

/**
 * The toast on the list an item moved to: a Combine reads as an add would ("Added to milk, now
 * 2 gal"); otherwise "Moved Milk from Groceries".
 */
export function movedToast(move: {
  kind: 'new' | 'combine' | 'reopen';
  name: string;
  totalAmountText?: string;
  fromListName: string;
}): { message: string; emphasis: string } {
  if (move.kind === 'combine') return addedToast(move.name, move.totalAmountText);
  const name = displayItemName(move.name);
  return { message: move.fromListName ? `Moved ${name} from ${move.fromListName}` : `Moved ${name}`, emphasis: name };
}

/** The toast after an item was deleted: "Deleted Milk", with Undo; the name is set in bold. */
export function deletedToast(storedName: string): { message: string; emphasis: string } {
  const name = displayItemName(storedName);
  return { message: `Deleted ${name}`, emphasis: name };
}

/** The toast after Clear checked items (spec 4.6): "Cleared 3 items", with Undo. */
export function clearedToast(count: number): { message: string } {
  return { message: `Cleared ${count} ${count === 1 ? 'item' : 'items'}` };
}

/** The toast after a section's Check all (spec 4.6): "Checked 3 items", with Undo. */
export function checkedAllToast(count: number): { message: string } {
  return { message: `Checked ${count} ${count === 1 ? 'item' : 'items'}` };
}

/** The toast after Remove recipe from list (spec 4.6): "Removed Tacos from the list", with Undo; the name in bold. */
export function removedRecipeToast(recipeName: string): { message: string; emphasis: string } {
  return { message: `Removed ${recipeName} from the list`, emphasis: recipeName };
}

/** The Checked header's Clear button and long-press action, for VoiceOver: "Clear 3 checked items". */
export function clearCheckedLabel(count: number): string {
  return `Clear ${count} checked ${count === 1 ? 'item' : 'items'}`;
}

/** The toast on a list screen after the Siri queue drained (spec 4.9): "Siri added 2 items". */
export function siriAddedToast(count: number): { message: string } {
  return { message: `Siri added ${count} ${count === 1 ? 'item' : 'items'}` };
}
