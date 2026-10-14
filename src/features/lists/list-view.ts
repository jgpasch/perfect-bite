// What the list screen and the Your lists sheet show (boards 02–03, E, G). Pure, so it can be tested
// without rendering.

import type { ItemRowStyle } from '@/components/appearance';
import type { IconName } from '@/components/icon';
import { sectionAccessibilityLabel, SORTING_CATEGORY } from '@/domain/category-resolver';
import type { MatchParts } from '@/domain/text-match';
import { i18n, onLanguageChanged } from '@/i18n';
import { displayItemName, normalizeIngredientName, parseQuantity, singularize } from '@/shared';

// --- Your lists sheet ------------------------------------------------------------------------

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
 * What the Your lists sheet shows. With one household there is no household UI: just its lists. With
 * more, one group per household, even when it has no lists yet. The primary household comes first,
 * then the rest by name.
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
  return memberCount === undefined ? name : i18n.t('lists.sheet.members', { name, count: memberCount });
}

/** A list's count in the Your lists sheet: the items to get, or "Done" when there are none. */
export function listRowCount(count: number): string {
  return count > 0 ? String(count) : i18n.t('lists.sheet.rowDone');
}

/** What VoiceOver reads for a list in the Your lists sheet: "Groceries, 12 items to get, Siri list, current". */
export function listRowAccessibilityLabel(
  name: string,
  count: number,
  { isDefault = false, archived = false, current = false }: { isDefault?: boolean; archived?: boolean; current?: boolean } = {},
): string {
  const parts = [name, count > 0 ? i18n.t('lists.sheet.toGet', { count }) : i18n.t('lists.sheet.allDone')];
  if (isDefault) parts.push(i18n.t('lists.sheet.siriList'));
  if (archived) parts.push(i18n.t('lists.sheet.archivedState'));
  if (current) parts.push(i18n.t('lists.sheet.current'));
  return parts.join(', ');
}

/** What VoiceOver reads for the list's name in its header, which opens the Your lists sheet. */
export function switcherAccessibilityLabel(name: string, invites: number): string {
  if (invites === 0) return i18n.t('lists.screen.switchList', { name });
  return i18n.t('lists.screen.switchListInvites', { name, count: invites });
}

// --- Launch --------------------------------------------------------------------------------

/**
 * The list a cold launch opens (spec 4.1): the last one opened, else the default list, else the
 * first list. Only ids still in `lists` (the open lists, in order) count; null when there are none.
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

/** "12 to get" beside the list's title, "All done" once everything on it is checked; nothing on an empty list. */
export function toGetLabel(uncheckedCount: number, checkedCount = 0): string | null {
  if (uncheckedCount > 0) return i18n.t('lists.screen.toGet', { count: uncheckedCount });
  return checkedCount > 0 ? i18n.t('lists.screen.allDone') : null;
}

/**
 * Spec 4.6: the Checked section is open by the user's own choice (a tap on its header), or else while
 * nothing is left to get, or always with Settings > Shopping > Always show checked items on.
 */
export function checkedSectionOpen(choice: boolean | null, allDone: boolean, alwaysShow: boolean): boolean {
  return choice ?? (alwaysShow || allDone);
}

/**
 * The user's choice once the list becomes all done, or stops being: a fold by hand is forgotten, so the
 * section opens when the last item is checked and folds again when something is added; an open by hand stays.
 */
export function checkedChoiceAfterAllDoneChange(choice: boolean | null): boolean | null {
  return choice === true ? true : null;
}

export type ListViewMode = 'newest' | 'category' | 'recipe';

/** The list screen's views (spec 4.6), in menu order, each with its menu icon and its name in the app's language. */
export const LIST_VIEW_MODES: readonly { value: ListViewMode; readonly label: string; icon: IconName }[] = (
  [
    { value: 'newest', icon: 'clock' },
    { value: 'category', icon: 'cart' },
    { value: 'recipe', icon: 'fork.knife' },
  ] as const
).map(({ value, icon }) => ({
  value,
  icon,
  // A getter, read each time (no object spread here: Babel's would read it once, at load).
  get label() {
    return i18n.t(`lists.viewModes.${value}`);
  },
}));

/** A list with no saved choice on this device opens in As added. */
export const DEFAULT_LIST_VIEW_MODE: ListViewMode = 'newest';

/** The view's name, as the view button and the menu show it: `As added`. */
export function viewModeLabel(mode: ListViewMode): string {
  return LIST_VIEW_MODES.find((m) => m.value === mode)?.label ?? '';
}

/** What VoiceOver reads for the view button: `View: As added`. */
export function viewButtonAccessibilityLabel(mode: ListViewMode): string {
  return i18n.t('lists.viewModes.button', { mode: viewModeLabel(mode) });
}

// Module-level strings follow the app's language (a live binding, set once i18n is initialized).
export let VIEW_BUTTON_HINT = '';
/** The label on each row in the Sorting… card. */
export let SORTING_LABEL = '';
onLanguageChanged(() => {
  VIEW_BUTTON_HINT = i18n.t('lists.viewModes.buttonHint');
  SORTING_LABEL = i18n.t('lists.sections.sorting');
});

/** The compact add-mode header's second line: the count and the view, `8 to get · As added`. */
export function compactHeaderSubtitle(uncheckedCount: number, mode: ListViewMode, checkedCount = 0): string {
  return [toGetLabel(uncheckedCount, checkedCount), viewModeLabel(mode)].filter(Boolean).join(' · ');
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
export let ALREADY_ON_LIST_LABEL = '';
onLanguageChanged(() => {
  ALREADY_ON_LIST_LABEL = i18n.t('addBar.alreadyOnList');
});

/**
 * Where the typed key's words start as a run of whole words in `words`, or -1. The run's last word is compared
 * singularized, as the key's last word is: `egg` is in `eggs benedict`.
 */
function wordRunIndex(words: readonly string[], query: string): number {
  const q = query.split(' ');
  const last = q.length - 1;
  for (let i = 0; i + last < words.length; i++) {
    if (q.every((word, j) => (j === last ? singularize(words[i + j]) === word : words[i + j] === word))) return i;
  }
  return -1;
}

/**
 * An unchecked item whose key is the typed key, or has it as a run of whole words, is already on the list:
 * `cumin` marks Cumin and Ground cumin, `cum` marks nothing, `pea` marks Peas but not Peanut butter.
 */
export function isAlreadyOnList(item: { ingredientName: string; checkedAt: Date | null }, query: string | null): boolean {
  return query !== null && item.checkedAt === null && wordRunIndex(item.ingredientName.split(' '), query) !== -1;
}

/**
 * The row's name split around the words the typed key matched, for the green highlight: `chicken` in
 * `Chicken Thighs` → `Chicken`, `pea` in `Peas` → `Peas`. Null when the name has no such run.
 */
export function alreadyOnListParts(name: string, query: string): MatchParts | null {
  const tokens = [...name.matchAll(/[\p{L}\p{N}'’]+/gu)]
    .map((m) => ({ start: m.index, end: m.index + m[0].length, word: m[0].toLowerCase().normalize('NFC').replace(/['’]/g, '') }))
    .filter((t) => t.word);
  const i = wordRunIndex(
    tokens.map((t) => t.word),
    query,
  );
  if (i === -1) return null;
  const start = tokens[i].start;
  const end = tokens[i + query.split(' ').length - 1].end;
  return { before: name.slice(0, start), match: name.slice(start, end), after: name.slice(end) };
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

export const ITEM_ROW_STYLE_KEY = 'list.itemRowStyle';

export const DEFAULT_ITEM_ROW_STYLE: ItemRowStyle = 'bands';

/** The choices on Settings > Aisle colours > Item rows, in order. */
export const ITEM_ROW_STYLES: readonly { value: ItemRowStyle; label: string }[] = [
  { value: 'bands', label: 'Colour bands' },
  { value: 'white', label: 'White rows' },
];

/** The saved item row style, read defensively: anything unknown is the default. */
export function readItemRowStyle(saved: unknown): ItemRowStyle {
  // White tiles became White rows.
  if (saved === 'tiles') return 'white';
  return ITEM_ROW_STYLES.some((s) => s.value === saved) ? (saved as ItemRowStyle) : DEFAULT_ITEM_ROW_STYLE;
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

export type NewestItem = {
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
      const first = earliestAmount(item);
      return { item, at: first.createdAt.getTime(), tie: first.id };
    });
  const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  keyed.sort((a, b) => b.at - a.at || byId(a.tie, b.tie) || byId(a.item.id, b.item.id));
  return keyed.map((k) => k.item);
}

/** The item's earliest current amount (ties by id), or the item itself when it has none. */
function earliestAmount(item: NewestItem): { id: string; createdAt: Date } {
  let first: { id: string; createdAt: Date } | undefined;
  for (const c of item.contributions) {
    const t = c.createdAt.getTime();
    if (!first || t < first.createdAt.getTime() || (t === first.createdAt.getTime() && c.id < first.id)) first = c;
  }
  return first ?? item;
}

/** When the item was added, as As added sorts it (ms): its earliest current amount's `createdAt`, else its own. */
export function addedAt(item: NewestItem): number {
  return earliestAmount(item).createdAt.getTime();
}

/**
 * One place in the user's own As added order: the item, and the `addedAt` its place was based on. When
 * `addedAt` changes (a checked item re-added gets new amounts) the item counts as a new add.
 */
export type ManualOrderEntry = { id: string; at: number };

/** Where the device setting for a list's manual As added order lives. */
export const manualOrderKey = (listId: string) => `list.${listId}.manualOrder`;

/**
 * The saved manual order, read defensively: anything that isn't a list of `{ id, at }` counts as none.
 * An id saved twice keeps its first place.
 */
export function readManualOrder(saved: unknown): ManualOrderEntry[] {
  if (!Array.isArray(saved)) return [];
  const valid = saved.every(
    (e: unknown) =>
      typeof e === 'object' &&
      e !== null &&
      typeof (e as ManualOrderEntry).id === 'string' &&
      typeof (e as ManualOrderEntry).at === 'number' &&
      Number.isFinite((e as ManualOrderEntry).at),
  );
  if (!valid) return [];
  const seen = new Set<string>();
  const entries: ManualOrderEntry[] = [];
  for (const { id, at } of saved as ManualOrderEntry[]) {
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, at });
  }
  return entries;
}

/**
 * The As added view in the user's order. `ordered` is `orderByNewest`'s result. Items saved with their
 * current `addedAt` take their saved places; the rest (never placed, or re-added since) go above them,
 * newest first. A Combine keeps `addedAt`, so a combined item stays put. Saved entries for items not
 * showing are skipped, so an unchecked item comes back to its place.
 */
export function applyManualOrder<T extends NewestItem>(ordered: readonly T[], saved: readonly ManualOrderEntry[]): T[] {
  if (saved.length === 0) return [...ordered];
  const place = new Map(saved.map((e, i) => [e.id, { at: e.at, index: i }]));
  const fresh: T[] = [];
  const pinned: { item: T; index: number }[] = [];
  for (const item of ordered) {
    const p = place.get(item.id);
    if (p && p.at === addedAt(item)) pinned.push({ item, index: p.index });
    else fresh.push(item);
  }
  pinned.sort((a, b) => a.index - b.index);
  return [...fresh, ...pinned.map((p) => p.item)];
}

/**
 * The entries to save after a drop: every item in `visibleIds` (the order on screen), so the whole
 * order is pinned, plus the previous entries for checked items, each kept just after the item it
 * followed, so it returns there when unchecked. Entries for anything else (deleted, never synced
 * here) are dropped.
 */
export function manualOrderEntries(
  visibleIds: readonly string[],
  items: readonly NewestItem[],
  previous: readonly ManualOrderEntry[],
): ManualOrderEntry[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const visible: ManualOrderEntry[] = [];
  const shown = new Set<string>();
  for (const id of visibleIds) {
    const item = byId.get(id);
    if (!item || shown.has(id)) continue;
    shown.add(id);
    visible.push({ id, at: addedAt(item) });
  }
  // Checked entries, grouped under the nearest shown entry before them in the previous order.
  const after = new Map<string | null, ManualOrderEntry[]>();
  let anchor: string | null = null;
  for (const e of previous) {
    if (shown.has(e.id)) {
      anchor = e.id;
      continue;
    }
    if (byId.get(e.id)?.checkedAt == null) continue;
    after.set(anchor, [...(after.get(anchor) ?? []), e]);
  }
  return [...(after.get(null) ?? []), ...visible.flatMap((e) => [e, ...(after.get(e.id) ?? [])])];
}

/** The second line on an item that is in other recipes too (By recipe). */
export function alsoInHint(alsoIn: readonly string[]): string | undefined {
  return alsoIn.length > 0 ? i18n.t('lists.sections.alsoIn', { names: alsoIn.join(', ') }) : undefined;
}

/**
 * The second line on a checked item from a recipe: "From Tacos". Checking leaves an item's recipe
 * amounts in place, so it still knows its recipes while it sits in Checked.
 */
export function fromRecipesHint(contributions: readonly { recipeId: string | null; recipeName: string | null }[]): string | undefined {
  const names = [...new Set(contributions.flatMap((c) => (c.recipeId !== null && c.recipeName ? [c.recipeName] : [])))];
  return names.length > 0 ? i18n.t('lists.sections.fromRecipes', { names: names.join(', ') }) : undefined;
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
  return i18n.t('lists.row.checkOff', { name });
}

/** The custom action on an item row that toggles its check: "Check off", or "Uncheck" once it's checked. */
export function toggleActionLabel(checked: boolean): string {
  return checked ? i18n.t('lists.row.uncheckAction') : i18n.t('lists.row.checkOffAction');
}

/** The toast after an add merged into an item: "Added to Milk, now 1 gal + 1"; the name is set in bold. */
export function addedToast(storedName: string, totalAmountText: string | null | undefined): { message: string; emphasis: string } {
  const name = displayItemName(storedName);
  return {
    message: totalAmountText
      ? i18n.t('lists.toasts.addedToNow', { name, amount: totalAmountText })
      : i18n.t('lists.toasts.addedTo', { name }),
    emphasis: name,
  };
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
  return {
    message: move.fromListName
      ? i18n.t('lists.toasts.movedFrom', { name, list: move.fromListName })
      : i18n.t('lists.toasts.moved', { name }),
    emphasis: name,
  };
}

/** The toast after an item was deleted: "Deleted Milk", with Undo; the name is set in bold. */
export function deletedToast(storedName: string): { message: string; emphasis: string } {
  const name = displayItemName(storedName);
  return { message: i18n.t('lists.toasts.deleted', { name }), emphasis: name };
}

/** The toast after Clear checked items (spec 4.6): "Cleared 3 items", with Undo. */
export function clearedToast(count: number): { message: string } {
  return { message: i18n.t('lists.toasts.cleared', { count }) };
}

/** The toast after a section's Check all (spec 4.6): "Checked 3 items", with Undo. */
export function checkedAllToast(count: number): { message: string } {
  return { message: i18n.t('lists.toasts.checkedAll', { count }) };
}

/** The toast after the Checked section's Uncheck all (spec 4.6): "Unchecked 6 items", with Undo. */
export function uncheckedAllToast(count: number): { message: string } {
  return { message: i18n.t('lists.toasts.uncheckedAll', { count }) };
}

/** The toast after Remove recipe from list (spec 4.6): "Removed Tacos from the list", with Undo; the name in bold. */
export function removedRecipeToast(recipeName: string): { message: string; emphasis: string } {
  return { message: i18n.t('lists.toasts.removedRecipe', { name: recipeName }), emphasis: recipeName };
}

/** The Checked header's Clear button and long-press action, for VoiceOver: "Clear 3 checked items". */
export function clearCheckedLabel(count: number): string {
  return i18n.t('lists.checked.clearLabel', { count });
}

/** The Checked section's header for VoiceOver: "Checked, 2 items". */
export function checkedHeaderLabel(count: number): string {
  return i18n.t('lists.checked.label', { count });
}

/** The toast on a list screen after the Siri queue drained (spec 4.9): "Siri added 2 items". */
export function siriAddedToast(count: number): { message: string } {
  return { message: i18n.t('lists.toasts.siriAdded', { count }) };
}
