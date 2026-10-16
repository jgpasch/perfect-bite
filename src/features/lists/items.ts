// List items (spec 4.2, 4.4): local reads, and writes through the sync helpers (outbox, spec 7.1).
import { and, asc, eq, inArray, isNotNull, isNull, like, ne, or, sql } from 'drizzle-orm';

import {
  db,
  householdCategoryOverrides,
  households,
  ingredientUnitUsage,
  ingredientUsage,
  ingredients,
  listItemContributions,
  listItems,
  lists,
  recipes,
  type ListItem,
} from '@/db';
import { effectiveCategoryId, SORTING_CATEGORY_ID } from '@/domain/category-resolver';
import { detectDuplicate, planBulkAdd, type AddDecision } from '@/domain/duplicate-detector';
import type { Amount } from '@/domain/quantity-display';
import { combineAmounts, stepAmount, summarizeAmounts } from '@/domain/quantity-math';
import { rankHistory } from '@/domain/suggestion-rank';
import { usualUnit, withDefaultUnit } from '@/domain/usual-unit';
import {
  clearCategoryOverride,
  ensureLocalIngredient,
  householdCombinesLanguages,
  localFamilyKey,
  setCategoryOverride,
} from '@/features/categories/categories';
import { recordUsage, unrecordUsage } from '@/features/lists/usage';
import { i18n } from '@/i18n';
import { newId } from '@/lib/id';
import type { Exec } from '@/sync/clock';
import { insertRow, updateRows } from '@/sync/mutate';
import { displayItemName, familyKey, normalizeIngredientName, OTHER_CATEGORY_ID, parseAmount, parseQuantity, type Unit } from '@/shared';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const liveItem = isNull(listItems.deletedAt);
const liveContribution = isNull(listItemContributions.deletedAt);

export class DuplicateItemError extends Error {
  constructor(name: string) {
    super(i18n.t('errors.alreadyOnList', { name }));
    this.name = 'DuplicateItemError';
  }
}

function findOpenItem(tx: Tx, listId: string, ingredientName: string, exceptId?: string) {
  return tx
    .select()
    .from(listItems)
    .where(
      and(
        eq(listItems.listId, listId),
        eq(listItems.ingredientName, ingredientName),
        liveItem,
        isNull(listItems.checkedAt),
        exceptId ? ne(listItems.id, exceptId) : undefined,
      ),
    )
    .get();
}

/**
 * The oldest open item on `item`'s list for another name of its family (spec 4.15), if any. None
 * when the household doesn't combine languages.
 */
function findOpenTwin(tx: Tx, item: ListItem) {
  if (!householdCombinesLanguages(tx, item.householdId)) return undefined;
  return tx
    .select({ id: listItems.id })
    .from(listItems)
    .leftJoin(ingredients, eq(ingredients.normalizedName, listItems.ingredientName))
    .where(
      and(
        eq(listItems.listId, item.listId),
        eq(sql`coalesce(${ingredients.sameAs}, ${listItems.ingredientName})`, localFamilyKey(tx, item.ingredientName)),
        ne(listItems.ingredientName, item.ingredientName),
        liveItem,
        isNull(listItems.checkedAt),
      ),
    )
    .orderBy(asc(listItems.createdAt), asc(listItems.id))
    .get();
}

function getItem(tx: Tx, id: string): ListItem {
  const item = tx.select().from(listItems).where(eq(listItems.id, id)).get();
  if (!item) throw new Error(`No list item ${id}`);
  return item;
}

type Source = 'manual' | 'recipe' | 'siri';

export type AddItemResult = {
  itemId: string;
  /** The new amount (contribution) this add created. */
  contributionId: string;
  /** What the add did (spec 4.4): a new item, Combine into an open one, or reopen a checked one. */
  kind: AddDecision['kind'];
  /** The item's name and its total amount after this add (combine only), for the toast. */
  existingName?: string;
  totalAmountText?: string;
  /** What reopening replaced, so Undo can put it back. */
  reopened?: { checkedAt: Date; checkedBy: string | null; contributionIds: string[] };
  /** The name, if this add was the first to record it (pending), for `categorizePending`. */
  pendingNames: string[];
  /**
   * The key this add counted a use of: its own, which isn't the item's when it combined into a
   * twin (spec 4.15). Left out, the item's.
   */
  ingredientName?: string;
};

/**
 * A list's live items for `detectDuplicate`, each with its family key (spec 4.15) when `combine`
 * (the household combines languages), else its own key.
 */
function liveItemsForList(tx: Tx, listId: string, combine: boolean) {
  return tx
    .select({
      id: listItems.id,
      ingredientName: listItems.ingredientName,
      familyKey: combine
        ? sql<string>`coalesce(${ingredients.sameAs}, ${listItems.ingredientName})`
        : listItems.ingredientName,
      checkedAt: listItems.checkedAt,
    })
    .from(listItems)
    .leftJoin(ingredients, eq(ingredients.normalizedName, listItems.ingredientName))
    .where(and(eq(listItems.listId, listId), liveItem))
    .all();
}

function liveContributions(tx: Tx, itemId: string) {
  return tx
    .select()
    .from(listItemContributions)
    .where(and(eq(listItemContributions.listItemId, itemId), liveContribution))
    .orderBy(asc(listItemContributions.createdAt))
    .all();
}

/**
 * An item's total as it reads on its row. A recipe link with no quantity (a recipe ingredient
 * with no amount, or "Make recipe..." on an existing item) records the recipe, not an amount, so it
 * doesn't count: `2 lb` plus a link reads `2 lb`, not `2 lb + 1`. An add with no amount counts as
 * one of the ingredient's `usualUnit` (`summarizeAmounts`).
 */
export function itemTotal(
  contributions: readonly (Amount & { source: string })[],
  usualUnit: Unit | null = null,
): string {
  return summarizeAmounts(contributions.filter(countsInTotal), usualUnit);
}

/** False for a recipe link with no quantity, which records the recipe, not an amount. */
function countsInTotal(c: Amount & { source: string }): boolean {
  return !(c.source === 'recipe' && c.quantity === null);
}

/**
 * The one amount an item's total is, for the edit sheet's − / + (spec 4.4): `2 lb + 8 oz` →
 * `2.5 lb`, no amounts → 1 of `usualUnit`. Null when the total isn't a single amount (`2 cans +
 * 400 g`), which disables the stepper. Recipe links with no quantity don't count, as in `itemTotal`.
 */
export function steppableAmount(
  contributions: readonly (Amount & { source: string })[],
  usualUnit: Unit | null = null,
): Amount | null {
  return combineAmounts(contributions.filter(countsInTotal), usualUnit);
}

/** The household's usual unit for one ingredient (spec 4.2), or null when none is known. */
function usualUnitFor(tx: Tx, householdId: string, ingredientName: string): Unit | null {
  return knownUsualUnit(tx, householdId, ingredientName) ?? null;
}

/**
 * `usualUnit` for one ingredient, falling back to its catalog default unit: null for a plain count,
 * undefined when nothing is known.
 */
function knownUsualUnit(tx: Tx, householdId: string, ingredientName: string): Unit | null | undefined {
  const rows = tx
    .select()
    .from(ingredientUnitUsage)
    .where(and(eq(ingredientUnitUsage.householdId, householdId), eq(ingredientUnitUsage.ingredientName, ingredientName)))
    .all();
  const catalog = tx
    .select({ defaultUnit: ingredients.defaultUnit })
    .from(ingredients)
    .where(eq(ingredients.normalizedName, ingredientName))
    .get();
  return withDefaultUnit(usualUnit(rows), catalog?.defaultUnit);
}

export type ParsedAdd = { ingredientName: string; displayName: string; quantity: number | null; unit: Unit | null };

function parseAdd(text: string): ParsedAdd | null {
  const { quantity, unit, name } = parseQuantity(text);
  const ingredientName = normalizeIngredientName(name);
  return ingredientName ? { ingredientName, displayName: name, quantity, unit } : null;
}

/**
 * Applies one add inside a transaction, following `decision`. Every add counts one use in the
 * household's ingredient history (spec 4.2), whatever the decision, plus a use of its unit if it
 * has a quantity; `undoAdd` takes them back.
 */
function applyAdd(
  tx: Tx,
  list: { id: string; householdId: string },
  add: ParsedAdd,
  decision: AddDecision,
  meta: { userId: string | null; source: Source; recipeId?: string | null; at?: Date; ids?: AddIds },
): AddItemResult {
  const at = meta.at ?? new Date();
  const contributionId = meta.ids?.contributionId ?? newId();
  const contribution = {
    id: contributionId,
    createdAt: at,
    householdId: list.householdId,
    source: meta.source,
    recipeId: meta.recipeId ?? null,
    quantity: add.quantity,
    unit: add.unit,
    addedBy: meta.userId,
  };
  recordUsage(tx, list.householdId, add.ingredientName, add.displayName, at, contribution);
  const pendingNames = ensureLocalIngredient(tx, add.ingredientName, add.displayName) ? [add.ingredientName] : [];

  if (decision.kind === 'new') {
    const itemId = meta.ids?.itemId ?? newId();
    insertRow(tx, listItems, {
      id: itemId,
      listId: list.id,
      householdId: list.householdId,
      ingredientName: add.ingredientName,
      displayName: add.displayName,
      addedBy: meta.userId,
      createdAt: at,
    });
    insertRow(tx, listItemContributions, { ...contribution, listItemId: itemId });
    return { itemId, contributionId, kind: 'new', pendingNames };
  }

  const item = getItem(tx, decision.itemId);
  const previous = liveContributions(tx, item.id);
  const twin = add.ingredientName !== item.ingredientName ? { ingredientName: add.ingredientName } : {};

  if (decision.kind === 'combine') {
    insertRow(tx, listItemContributions, { ...contribution, listItemId: item.id });
    return {
      itemId: item.id,
      contributionId,
      kind: 'combine',
      existingName: item.displayName,
      totalAmountText: itemTotal(
        [...previous, contribution],
        usualUnitFor(tx, list.householdId, item.ingredientName),
      ),
      pendingNames,
      ...twin,
    };
  }

  // Reopen: you bought it before and need it again, so the old amounts no longer apply.
  if (previous.length > 0) {
    updateRows(tx, listItemContributions, inArray(listItemContributions.id, previous.map((c) => c.id)), {
      deletedAt: new Date(),
    });
  }
  updateRows(tx, listItems, eq(listItems.id, item.id), { checkedAt: null, checkedBy: null });
  insertRow(tx, listItemContributions, { ...contribution, listItemId: item.id });
  return {
    itemId: item.id,
    contributionId,
    kind: 'reopen',
    reopened: { checkedAt: item.checkedAt!, checkedBy: item.checkedBy, contributionIds: previous.map((c) => c.id) },
    pendingNames,
    ...twin,
  };
}

function getListForAdd(tx: Tx, listId: string) {
  const list = tx.select({ id: lists.id, householdId: lists.householdId }).from(lists).where(eq(lists.id, listId)).get();
  if (!list) throw new Error(`No list ${listId}`);
  return list;
}

/**
 * Spec 4.4 for one add to `list`, matching twins by family key (4.15) only when the list's
 * household combines languages.
 */
function decideAdd(tx: Tx, list: { id: string; householdId: string }, ingredientName: string): AddDecision {
  const combine = householdCombinesLanguages(tx, list.householdId);
  const family = combine ? localFamilyKey(tx, ingredientName) : ingredientName;
  return detectDuplicate(ingredientName, liveItemsForList(tx, list.id, combine), family);
}

/**
 * Adds typed or dictated text to a list: `2 lbs chicken thighs` → item `chicken thighs` with a
 * 2 lb amount. Duplicates follow spec 4.4: an open match gets the amount added (Combine); a
 * checked match is unchecked with its amounts replaced. Returns null for text with nothing to add.
 */
export function addItem(
  listId: string,
  text: string,
  userId: string | null,
  source: 'manual' | 'siri' = 'manual',
): AddItemResult | null {
  const add = parseAdd(text);
  if (!add) return null;
  return db.transaction((tx) => {
    const list = getListForAdd(tx, listId);
    const decision = decideAdd(tx, list, add.ingredientName);
    return applyAdd(tx, list, add, decision, { userId, source });
  });
}

/** Ids an add uses instead of new ones: the item's (if the add makes a new item) and its amount's. */
export type AddIds = { itemId: string; contributionId: string };

/**
 * A Siri add (spec 4.9): `addItem` from Siri (Combine silently), but with ids derived from its
 * queue envelope and the time it was spoken, so applying the same envelope twice adds once. Returns
 * `'applied'` when its amount already exists (an earlier drain, or `siri-add` via sync), even if
 * since deleted, and null for text with nothing to add.
 */
export function addSiriItem(
  listId: string,
  text: string,
  userId: string | null,
  ids: AddIds,
  at: Date,
): AddItemResult | 'applied' | null {
  const add = parseAdd(text);
  if (!add) return null;
  return db.transaction((tx) => {
    const contribution = tx
      .select({ id: listItemContributions.id })
      .from(listItemContributions)
      .where(eq(listItemContributions.id, ids.contributionId))
      .get();
    if (contribution) return 'applied';
    const list = getListForAdd(tx, listId);
    const decision = decideAdd(tx, list, add.ingredientName);
    // The derived item id is taken only if an earlier add made that item, whose amount would exist.
    const taken = tx.select({ id: listItems.id }).from(listItems).where(eq(listItems.id, ids.itemId)).get();
    const itemId = taken ? newId() : ids.itemId;
    return applyAdd(tx, list, add, decision, { userId, source: 'siri', at, ids: { ...ids, itemId } });
  });
}

/** Toast "Undo" (spec 4.4): removes the add entirely, restoring what it changed, and its use. */
export function undoAdd(result: AddItemResult): void {
  db.transaction((tx) => undoAddIn(tx, result, new Date()));
}

/**
 * A bulk add's toast "Undo" (spec 4.4): takes back every add in one step, latest first, so an add
 * folded into an earlier one in the same batch goes before it. Combined items return to their
 * earlier amounts, and reopened ones to checked with their old amounts. `exec`: the caller's transaction.
 */
export function undoAdds(results: readonly (AddItemResult | null)[], exec: Exec = db): void {
  exec.transaction((tx) => {
    const now = new Date();
    for (const result of [...results].reverse()) if (result) undoAddIn(tx, result, now);
  });
}

function undoAddIn(tx: Tx, result: AddItemResult, now: Date): void {
  const item = getItem(tx, result.itemId);
  const undone = tx
    .select({ quantity: listItemContributions.quantity, unit: listItemContributions.unit })
    .from(listItemContributions)
    .where(eq(listItemContributions.id, result.contributionId))
    .get();
  unrecordUsage(tx, item.householdId, result.ingredientName ?? item.ingredientName, undone);
  updateRows(tx, listItemContributions, eq(listItemContributions.id, result.contributionId), { deletedAt: now });
  if (result.kind === 'new') {
    updateRows(tx, listItems, eq(listItems.id, result.itemId), { deletedAt: now });
  } else if (result.kind === 'reopen' && result.reopened) {
    const { checkedAt, checkedBy, contributionIds } = result.reopened;
    updateRows(tx, listItems, eq(listItems.id, result.itemId), { checkedAt, checkedBy });
    if (contributionIds.length > 0) {
      updateRows(tx, listItemContributions, inArray(listItemContributions.id, contributionIds), { deletedAt: null });
    }
  }
}

/** The edit sheet's per-amount delete control (spec 4.4). */
export function deleteContribution(contributionId: string): void {
  updateRows(db, listItemContributions, eq(listItemContributions.id, contributionId), { deletedAt: new Date() });
}

/** An item's live amounts, oldest first, for the edit sheet. */
export function contributionsQuery(itemId: string) {
  return db
    .select({
      id: listItemContributions.id,
      source: listItemContributions.source,
      recipeId: listItemContributions.recipeId,
      quantity: listItemContributions.quantity,
      unit: listItemContributions.unit,
      addedBy: listItemContributions.addedBy,
      /** For the sheet's "Added" rows; null if the recipe is gone. */
      recipeName: recipes.name,
      createdAt: listItemContributions.createdAt,
    })
    .from(listItemContributions)
    .leftJoin(recipes, and(eq(recipes.id, listItemContributions.recipeId), isNull(recipes.deletedAt)))
    .where(and(eq(listItemContributions.listItemId, itemId), liveContribution))
    .orderBy(asc(listItemContributions.createdAt));
}

// --- Bulk add (spec 4.4, used by "Add recipe to list" in M4) --------------------------------

/** One add in a bulk add: typed text, or an ingredient that is already parsed (a recipe's). */
export type BulkAdd = ({ text: string } | { parsed: ParsedAdd }) & { source?: Source; recipeId?: string | null };

const parseBulkAdd = (a: BulkAdd): ParsedAdd | null => ('parsed' in a ? a.parsed : parseAdd(a.text));

/**
 * Adds many items in one transaction, each as a single add would (spec 4.4): an open match
 * Combines, a checked one is reopened with its amounts replaced, and the same ingredient twice in
 * the batch folds into the first. Returns one result per add (null if the add was empty); pass
 * them to `undoAdds` to take the whole add back. The adds share one timestamp, so As added (spec
 * 4.6) keeps them together in the order given. `exec`: the caller's transaction.
 */
export function addItemsBulk(
  listId: string,
  adds: readonly BulkAdd[],
  userId: string | null,
  exec: Exec = db,
): (AddItemResult | null)[] {
  return exec.transaction((tx) => {
    const list = getListForAdd(tx, listId);
    const parsed = adds.map(parseBulkAdd);
    // Twins (spec 4.15) fold together only when the household combines languages.
    const combine = householdCombinesLanguages(tx, list.householdId);
    const decisions = planBulkAdd(
      parsed.map((p) => p?.ingredientName ?? ''),
      liveItemsForList(tx, listId, combine),
      parsed.map((p) => (p ? (combine ? localFamilyKey(tx, p.ingredientName) : p.ingredientName) : '')),
    );
    const results: (AddItemResult | null)[] = [];
    const at = new Date();
    parsed.forEach((add, i) => {
      if (!add) return results.push(null);
      const meta = { userId, source: adds[i].source ?? 'manual', recipeId: adds[i].recipeId, at };
      const decision = decisions[i];
      if (decision.kind === 'sameAsEarlier') {
        const first = results[decision.index];
        if (!first) return results.push(null);
        return results.push(applyAdd(tx, list, add, { kind: 'combine', itemId: first.itemId }, meta));
      }
      results.push(applyAdd(tx, list, add, decision, meta));
    });
    return results;
  });
}

/**
 * Makes an item live and unchecked (or live and checked, for undoing a delete of a checked
 * item). If the same ingredient, or else another name of its family (spec 4.15), is already open on
 * the list, the item's amounts move onto that one instead, since a list holds one open item per
 * ingredient (as `apply_mutations` merges it). Returns that item and the amounts moved onto it, if
 * it merged.
 */
function restoreItem(tx: Tx, item: ListItem, checked: boolean): Merged | undefined {
  if (!checked) {
    const open = findOpenItem(tx, item.listId, item.ingredientName, item.id) ?? findOpenTwin(tx, item);
    if (open) {
      const moved = updateRows(
        tx,
        listItemContributions,
        and(eq(listItemContributions.listItemId, item.id), liveContribution),
        { listItemId: open.id },
      );
      updateRows(tx, listItems, eq(listItems.id, item.id), { deletedAt: item.deletedAt ?? new Date() });
      return { itemId: open.id, contributionIds: moved.map((c) => c.id) };
    }
  }
  updateRows(tx, listItems, eq(listItems.id, item.id), {
    deletedAt: null,
    checkedAt: checked ? (item.checkedAt ?? new Date()) : null,
    checkedBy: checked ? item.checkedBy : null,
  });
}

/** An item `restoreItem` folded into the open item of its ingredient: that item, and the amounts it moved there. */
type Merged = { itemId: string; contributionIds: string[] };

export function setItemChecked(itemId: string, checked: boolean, userId: string | null): void {
  db.transaction((tx) => {
    const item = getItem(tx, itemId);
    if (checked) {
      updateRows(tx, listItems, eq(listItems.id, itemId), { checkedAt: new Date(), checkedBy: userId });
    } else {
      restoreItem(tx, item, false);
    }
  });
}

export function deleteItem(itemId: string): void {
  updateRows(db, listItems, eq(listItems.id, itemId), { deletedAt: new Date() });
}

/** Undoes `deleteItem`, putting the item back checked or unchecked as it was. */
export function undeleteItem(itemId: string): void {
  db.transaction((tx) => {
    const item = getItem(tx, itemId);
    if (item.deletedAt === null) return;
    restoreItem(tx, item, item.checkedAt !== null);
  });
}

/** What "Clear checked items" deleted, for its toast's Undo (`restoreItems`). */
export type ClearedItems = { ids: string[]; deletedAt: Date };

/**
 * "Clear checked items" (spec 4.2, 4.6): deletes every checked item on the list, all at one time.
 * Their amounts stay, so `restoreItems` can bring them back whole.
 */
export function clearChecked(listId: string): ClearedItems {
  const deletedAt = new Date();
  const where = and(eq(listItems.listId, listId), liveItem, isNotNull(listItems.checkedAt));
  return { ids: updateRows(db, listItems, where, { deletedAt }).map((r) => r.id), deletedAt };
}

/**
 * The clear toast's "Undo": puts back the items `clearChecked` deleted at `deletedAt`, checked as
 * they were, with their amounts. An item whose deletion has changed since (deleted again on another
 * device, or gone from this one) stays deleted, and one already back is left alone. Returns how
 * many came back.
 */
export function restoreItems(ids: readonly string[], deletedAt: Date): number {
  if (ids.length === 0) return 0;
  return db.transaction((tx) => {
    const cleared = tx
      .select()
      .from(listItems)
      .where(and(inArray(listItems.id, [...ids]), eq(listItems.deletedAt, deletedAt)))
      .all();
    for (const item of cleared) restoreItem(tx, item, item.checkedAt !== null);
    return cleared.length;
  });
}

/** One item "Uncheck all" unchecked, for its toast's Undo (`recheckItems`). */
export type UncheckedItem = {
  id: string;
  checkedAt: Date;
  checkedBy: string | null;
  /** The row's field clock just after, so Undo can tell it has changed since (here or in a pull). */
  clock: ListItem['fieldClock'];
  /** Set when it merged into an open item of the same ingredient (the row deleted, its amounts moved). */
  merged?: Merged;
};

/**
 * "Uncheck all" (spec 4.6): unchecks every checked item on the list, oldest check first. One whose
 * ingredient is already open merges into that item. Returns what it did, for Undo.
 */
export function uncheckAll(listId: string): UncheckedItem[] {
  return db.transaction((tx) => {
    const checked = tx
      .select()
      .from(listItems)
      .where(and(eq(listItems.listId, listId), liveItem, isNotNull(listItems.checkedAt)))
      .orderBy(asc(listItems.checkedAt))
      .all();
    if (checked.length === 0) return [];
    const merged = new Map(checked.map((item) => [item.id, restoreItem(tx, item, false)]));
    const clocks = new Map(
      tx
        .select({ id: listItems.id, fieldClock: listItems.fieldClock })
        .from(listItems)
        .where(inArray(listItems.id, [...merged.keys()]))
        .all()
        .map((r) => [r.id, r.fieldClock]),
    );
    return checked.map((item) => ({
      id: item.id,
      checkedAt: item.checkedAt!,
      checkedBy: item.checkedBy,
      clock: clocks.get(item.id) ?? {},
      ...(merged.get(item.id) ? { merged: merged.get(item.id) } : {}),
    }));
  });
}

const sameClock = (a: ListItem['fieldClock'], b: ListItem['fieldClock']) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Uncheck all's "Undo": checks the items again with their own check times and checkers, and splits
 * merged ones back out (the row back, checked, with its amounts; the open item keeps what it had).
 * One changed since (checked, unchecked, edited or deleted, here or on another device), or a merged
 * one whose amounts have moved or gone since, is left as it is. Returns how many came back.
 */
export function recheckItems(unchecked: readonly UncheckedItem[]): number {
  if (unchecked.length === 0) return 0;
  return db.transaction((tx) => {
    const rowsById = new Map(
      tx
        .select()
        .from(listItems)
        .where(inArray(listItems.id, unchecked.map((u) => u.id)))
        .all()
        .map((r) => [r.id, r]),
    );
    let count = 0;
    // Split merged items out first: the item one merged into may be another in this batch, still open.
    const ordered = [...unchecked.filter((u) => u.merged), ...unchecked.filter((u) => !u.merged)];
    for (const u of ordered) {
      const row = rowsById.get(u.id);
      if (!row || !sameClock(row.fieldClock, u.clock)) continue;
      const restore = { deletedAt: null, checkedAt: u.checkedAt, checkedBy: u.checkedBy };
      if (u.merged) {
        if (row.deletedAt === null) continue;
        const { itemId, contributionIds } = u.merged;
        const stillThere = tx
          .select({ id: listItemContributions.id })
          .from(listItemContributions)
          .where(
            and(
              inArray(listItemContributions.id, contributionIds),
              eq(listItemContributions.listItemId, itemId),
              liveContribution,
            ),
          )
          .all();
        if (stillThere.length !== contributionIds.length) continue;
        if (contributionIds.length > 0) {
          updateRows(tx, listItemContributions, inArray(listItemContributions.id, contributionIds), { listItemId: u.id });
        }
      } else if (row.deletedAt !== null || row.checkedAt !== null) {
        continue;
      }
      updateRows(tx, listItems, eq(listItems.id, u.id), restore);
      count++;
    }
    return count;
  });
}

export type ItemEdit = {
  name: string;
  amount: string;
  note: string;
  /**
   * Category choice from the sheet: a category id (the household's override), null for "Reset to
   * default", or undefined when the user didn't touch it.
   */
  categoryId?: string | null;
};

/**
 * Saves the item edit sheet. The amount is text (`2 lb`); when it changes, the item's amounts
 * are replaced by that one amount. A category choice is written for the item's household.
 * Throws `DuplicateItemError` if a rename would make a second open item for the same ingredient,
 * and a plain Error for an unreadable amount. Returns the new name if the rename recorded it as
 * pending, for `categorizePending`.
 */
export function updateItem(itemId: string, edit: ItemEdit): string[] {
  const name = edit.name.trim().replace(/\s+/g, ' ');
  const ingredientName = normalizeIngredientName(name);
  if (!ingredientName) throw new Error(i18n.t('errors.itemNeedsName'));

  return db.transaction((tx) => {
    const item = getItem(tx, itemId);
    if (item.checkedAt === null && findOpenItem(tx, item.listId, ingredientName, item.id)) {
      throw new DuplicateItemError(name);
    }
    updateRows(tx, listItems, eq(listItems.id, itemId), {
      displayName: name,
      ingredientName,
      note: edit.note.trim() || null,
    });
    const pendingNames =
      ingredientName !== item.ingredientName && ensureLocalIngredient(tx, ingredientName, name) ? [ingredientName] : [];

    // Spec 4.3.2: the household's override for the ingredient, on every list.
    if (edit.categoryId !== undefined) {
      if (edit.categoryId === null) clearCategoryOverride(item.householdId, ingredientName, tx);
      else setCategoryOverride(item.householdId, ingredientName, edit.categoryId, tx);
    }

    const contributions = tx
      .select()
      .from(listItemContributions)
      .where(and(eq(listItemContributions.listItemId, itemId), liveContribution))
      .orderBy(asc(listItemContributions.createdAt))
      .all();
    // Unchanged (including a combined `1 gal + 1`, which isn't itself a parseable amount).
    // Compared with the total the sheet showed, so with the usual unit of the name it opened with.
    if (edit.amount.trim() === itemTotal(contributions, usualUnitFor(tx, item.householdId, item.ingredientName))) {
      return pendingNames;
    }
    const amount = parseAmount(edit.amount);
    if (!amount) throw new Error(i18n.t('errors.notAnAmount', { amount: edit.amount.trim() }));
    replaceAmounts(tx, item, contributions, amount);
    return pendingNames;
  });
}

/** Replaces `contributions` with the one `amount`: in place if there's one, else a new manual amount. */
function replaceAmounts(
  tx: Tx,
  item: ListItem,
  contributions: readonly { id: string }[],
  amount: Amount,
): void {
  if (contributions.length === 1) {
    updateRows(tx, listItemContributions, eq(listItemContributions.id, contributions[0].id), {
      quantity: amount.quantity,
      unit: amount.unit,
    });
    return;
  }
  if (contributions.length > 1) {
    updateRows(tx, listItemContributions, inArray(listItemContributions.id, contributions.map((c) => c.id)), {
      deletedAt: new Date(),
    });
  }
  insertRow(tx, listItemContributions, {
    id: newId(),
    listItemId: item.id,
    householdId: item.householdId,
    source: 'manual',
    quantity: amount.quantity,
    unit: amount.unit,
  });
}

/**
 * Sets an item's amount to `amount` (the edit sheet's stepper and unit picker, spec 4.4). Its
 * amounts are replaced by that one, as `updateItem` does, but recipe links with no quantity stay,
 * so the By recipe view keeps them. Throws for a missing item.
 */
export function setItemAmount(itemId: string, amount: Amount): void {
  db.transaction((tx) => {
    const item = getItem(tx, itemId);
    replaceAmounts(tx, item, liveContributions(tx, itemId).filter(countsInTotal), amount);
  });
}

/**
 * The edit sheet's − / +: steps the item's total one step (`stepAmount`) and saves it as with
 * `setItemAmount`. Returns the new amount, or null with nothing changed when it can't step: the
 * total isn't one amount (`steppableAmount`), or − is already at one step. Throws for a missing item.
 */
export function stepItemAmount(itemId: string, direction: 1 | -1, usualUnit: Unit | null): Amount | null {
  return db.transaction((tx) => {
    const item = getItem(tx, itemId);
    const counted = liveContributions(tx, itemId).filter(countsInTotal);
    const current = combineAmounts(counted, usualUnit);
    const next = current && stepAmount(current, direction, usualUnit);
    if (!next) return null;
    replaceAmounts(tx, item, counted, next);
    return next;
  });
}

// --- Reads ---------------------------------------------------------------------------------

/** One row per (item, contribution), with the household's category; group with `groupItems`. */
export function listItemsQuery(listId: string) {
  return db
    .select({
      id: listItems.id,
      ingredientName: listItems.ingredientName,
      displayName: listItems.displayName,
      note: listItems.note,
      checkedAt: listItems.checkedAt,
      createdAt: listItems.createdAt,
      defaultCategoryId: ingredients.defaultCategoryId,
      ingredientStatus: ingredients.status,
      sameAs: ingredients.sameAs,
      defaultUnit: ingredients.defaultUnit,
      overrideCategoryId: householdCategoryOverrides.categoryId,
      quantity: listItemContributions.quantity,
      unit: listItemContributions.unit,
      contributionId: listItemContributions.id,
      source: listItemContributions.source,
      recipeId: listItemContributions.recipeId,
      recipeName: recipes.name,
      contributedAt: listItemContributions.createdAt,
      addedBy: listItemContributions.addedBy,
    })
    .from(listItems)
    .leftJoin(
      listItemContributions,
      and(eq(listItemContributions.listItemId, listItems.id), liveContribution),
    )
    .leftJoin(recipes, and(eq(recipes.id, listItemContributions.recipeId), isNull(recipes.deletedAt)))
    .leftJoin(ingredients, eq(ingredients.normalizedName, listItems.ingredientName))
    // The override is the ingredient's family's (spec 4.15: `familyKey`), so `leche` follows `milk`.
    .leftJoin(
      householdCategoryOverrides,
      and(
        eq(householdCategoryOverrides.householdId, listItems.householdId),
        eq(householdCategoryOverrides.ingredientName, sql`coalesce(${ingredients.sameAs}, ${listItems.ingredientName})`),
      ),
    )
    .where(and(eq(listItems.listId, listId), liveItem))
    .orderBy(asc(listItems.createdAt), asc(listItems.id), asc(listItemContributions.createdAt));
}

/**
 * The link of each live recipe with an amount on the list, for the By recipe view's Visit recipe on
 * web (spec 4.6). A deleted recipe has none. Kept apart from `listItemsQuery`, which reads per amount.
 */
export function listRecipeLinksQuery(listId: string) {
  return db
    .selectDistinct({ id: recipes.id, sourceUrl: recipes.sourceUrl })
    .from(listItemContributions)
    .innerJoin(listItems, and(eq(listItems.id, listItemContributions.listItemId), liveItem))
    .innerJoin(recipes, and(eq(recipes.id, listItemContributions.recipeId), isNull(recipes.deletedAt)))
    .where(and(eq(listItems.listId, listId), liveContribution, isNotNull(recipes.sourceUrl)));
}

/** Tables `listRecipeLinksQuery` reads, for `useLiveQueryOn`. */
export const LIST_RECIPE_LINKS_QUERY_TABLES = [listItems, listItemContributions, recipes];

/** Tables `listItemsQuery` reads, for `useLiveQueryOn`. */
export const LIST_ITEMS_QUERY_TABLES = [listItems, listItemContributions, ingredients, householdCategoryOverrides, recipes];

/**
 * The list household's unit history for the ingredients on the list; turn it into a map with
 * `usualUnitsByKey` for `groupItems`. Kept apart from `listItemsQuery`, where joining it would
 * repeat every contribution row once per unit.
 */
export function usualUnitsQuery(listId: string) {
  const keysOnList = db
    .select({ ingredientName: listItems.ingredientName })
    .from(listItems)
    .where(and(eq(listItems.listId, listId), liveItem));
  return db
    .select({
      ingredientName: ingredientUnitUsage.ingredientName,
      unitKey: ingredientUnitUsage.unitKey,
      useCount: ingredientUnitUsage.useCount,
      lastUsedAt: ingredientUnitUsage.lastUsedAt,
    })
    .from(ingredientUnitUsage)
    .innerJoin(lists, and(eq(lists.id, listId), eq(lists.householdId, ingredientUnitUsage.householdId)))
    .where(inArray(ingredientUnitUsage.ingredientName, keysOnList));
}

/** Tables `usualUnitsQuery` reads, for `useLiveQueryOn`. */
export const USUAL_UNITS_QUERY_TABLES = [ingredientUnitUsage, listItems, lists];

type ItemRow = Awaited<ReturnType<typeof listItemsQuery>>[number];

export type ItemView = {
  id: string;
  ingredientName: string;
  /** The ingredient's family key (spec 4.15: `familyKey`): `pepino`'s is `cucumber`. */
  familyKey: string;
  /** This user's section (spec 5, "Effective category"). */
  categoryId: string;
  displayName: string;
  note: string | null;
  checkedAt: Date | null;
  /** When the item row was made; As added (spec 4.6) goes by its amounts and falls back to this. */
  createdAt: Date;
  amounts: Amount[];
  /** The household's usual unit for the ingredient, else its default unit (null: a count, or nothing known). */
  usualUnit: Unit | null;
  /** `2 lb`, `1 gal + 1`, `2 gal` (usually bought by the gallon), or empty. */
  amountText: string;
  /** Each amount with the recipe it came from (null: typed or Siri), for the By recipe view. */
  contributions: ItemContribution[];
};

export type ItemContribution = Amount & {
  id: string;
  source: 'manual' | 'recipe' | 'siri';
  recipeId: string | null;
  recipeName: string | null;
  createdAt: Date;
  /** Who added it (null: unknown, or a deleted user). */
  addedBy: string | null;
};

/**
 * Groups `listItemsQuery` rows into items, unchecked (oldest first) then checked (most recent
 * first). `usualUnits` is `usualUnitsByKey` over `usualUnitsQuery`. `sorts`: whether the user's plan
 * has `categorize`; without it, items waiting for an aisle show in Other (spec 4.12).
 */
export function groupItems(
  rows: readonly ItemRow[],
  usualUnits: ReadonlyMap<string, Unit | null> = new Map(),
  sorts = true,
): { unchecked: ItemView[]; checked: ItemView[] } {
  const byId = new Map<string, ItemView>();
  for (const row of rows) {
    let item = byId.get(row.id);
    if (!item) {
      item = {
        id: row.id,
        ingredientName: row.ingredientName,
        familyKey: familyKey(row.ingredientName, row.sameAs),
        categoryId: effectiveCategoryId(row.overrideCategoryId, row.defaultCategoryId, row.ingredientStatus, sorts),
        displayName: row.displayName,
        note: row.note,
        checkedAt: row.checkedAt,
        createdAt: row.createdAt,
        amounts: [],
        usualUnit: withDefaultUnit(usualUnits.get(row.ingredientName), row.defaultUnit) ?? null,
        amountText: '',
        contributions: [],
      };
      byId.set(row.id, item);
    }
    if (row.contributionId) {
      item.amounts.push({ quantity: row.quantity, unit: row.unit });
      item.contributions.push({
        id: row.contributionId,
        quantity: row.quantity,
        unit: row.unit,
        source: row.source!,
        // A deleted recipe's amounts read as "no recipe" (spec 4.5).
        recipeId: row.recipeName === null ? null : row.recipeId,
        recipeName: row.recipeName,
        createdAt: row.contributedAt!,
        addedBy: row.addedBy,
      });
    }
  }
  const items = [...byId.values()];
  for (const item of items) item.amountText = itemTotal(item.contributions, item.usualUnit);
  return {
    unchecked: items.filter((i) => !i.checkedAt),
    checked: items
      .filter((i) => i.checkedAt)
      .sort((a, b) => b.checkedAt!.getTime() - a.checkedAt!.getTime()),
  };
}

/**
 * Items in the user's aisle order, the same order By aisle uses (spec 4.3.3): Sorting… first, then
 * by the aisle's place in `orderedCategories` (`orderCategories` output; an unknown aisle counts as
 * Other), then by when the item was added. By recipe (spec 4.6) groups these with `groupByRecipe`,
 * which keeps this order inside each card.
 */
export function orderByAisle<I extends { id: string; categoryId: string; createdAt: Date }>(
  items: readonly I[],
  orderedCategories: readonly { id: string }[],
): I[] {
  const rankById = new Map(orderedCategories.map((c, i) => [c.id, i]));
  const otherRank = rankById.get(OTHER_CATEGORY_ID) ?? orderedCategories.length;
  const rank = (categoryId: string) =>
    categoryId === SORTING_CATEGORY_ID ? -1 : (rankById.get(categoryId) ?? otherRank);
  return [...items].sort(
    (a, b) =>
      rank(a.categoryId) - rank(b.categoryId) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * The item edit sheet's starting values (category untouched), plus the item's ingredient key and
 * usual unit, which the sheet's live total uses.
 */
export function getItemEdit(
  itemId: string,
): (ItemEdit & { householdId: string; ingredientName: string; usualUnit: Unit | null; hasUsualUnit: boolean }) | null {
  return db.transaction((tx) => {
    const rows = listItemsQueryForItem(tx, itemId);
    if (rows.length === 0) return null;
    const amounts = rows
      .filter((r) => r.contributionId)
      .map((r) => ({ quantity: r.quantity, unit: r.unit, source: r.source! }));
    const known = knownUsualUnit(tx, rows[0].householdId, rows[0].ingredientName);
    const unit = known ?? null;
    return {
      name: rows[0].displayName,
      amount: itemTotal(amounts, unit),
      note: rows[0].note ?? '',
      householdId: rows[0].householdId,
      ingredientName: rows[0].ingredientName,
      usualUnit: unit,
      // usualUnit is null both for a plain count and when nothing is known; the unit menu marks only a count.
      hasUsualUnit: known !== undefined,
    };
  });
}

/** The name of the household an item's list belongs to, for the item sheet; null if the item is gone. */
export function getItemHouseholdName(itemId: string): string | null {
  const row = db
    .select({ name: households.name })
    .from(listItems)
    .innerJoin(households, eq(households.id, listItems.householdId))
    .where(and(eq(listItems.id, itemId), liveItem))
    .get();
  return row?.name ?? null;
}

function listItemsQueryForItem(tx: Tx, itemId: string) {
  return tx
    .select({
      householdId: listItems.householdId,
      displayName: listItems.displayName,
      ingredientName: listItems.ingredientName,
      note: listItems.note,
      quantity: listItemContributions.quantity,
      unit: listItemContributions.unit,
      source: listItemContributions.source,
      contributionId: listItemContributions.id,
    })
    .from(listItems)
    .leftJoin(
      listItemContributions,
      and(eq(listItemContributions.listItemId, listItems.id), liveContribution),
    )
    .where(and(eq(listItems.id, itemId), liveItem))
    .orderBy(asc(listItemContributions.createdAt))
    .all();
}

/**
 * Autocomplete, first source (spec 4.2): the household's ingredient history, ordered by
 * `rankHistory` (frecency). SQL only pre-filters on the start of the display name or key, or of
 * one of their words, so every row `rankHistory` could match reaches it.
 */
export function searchRecentItems(householdId: string, prefix: string, limit: number, now = new Date()) {
  const p = prefix.trim().toLowerCase().replace(/[%_]/g, '');
  if (!p) return [];
  const candidates = db
    .select()
    .from(ingredientUsage)
    .where(
      and(
        eq(ingredientUsage.householdId, householdId),
        isNull(ingredientUsage.hiddenAt),
        or(
          like(ingredientUsage.displayName, `${p}%`),
          like(ingredientUsage.displayName, `% ${p}%`),
          like(ingredientUsage.ingredientName, `${p}%`),
          like(ingredientUsage.ingredientName, `% ${p}%`),
        ),
      ),
    )
    .all();
  return rankHistory(candidates, p, now)
    .slice(0, limit)
    .map((r) => ({ key: r.ingredientName, displayName: r.displayName }));
}

export type CheckedItems = { ids: string[]; checkedAt: Date };

/** "Check all" on a section (spec 4.6): checks those of `itemIds` still open. Returns them for Undo. */
export function checkItems(itemIds: readonly string[], userId: string | null): CheckedItems {
  const checkedAt = new Date();
  if (itemIds.length === 0) return { ids: [], checkedAt };
  const where = and(inArray(listItems.id, [...itemIds]), liveItem, isNull(listItems.checkedAt));
  return { ids: updateRows(db, listItems, where, { checkedAt, checkedBy: userId }).map((r) => r.id), checkedAt };
}

/**
 * Check all's "Undo": unchecks the items `checkItems` checked at `checkedAt`. One checked or
 * unchecked since (here or on another device) is left as it is.
 */
export function uncheckItems({ ids, checkedAt }: CheckedItems): void {
  if (ids.length === 0) return;
  db.transaction((tx) => {
    const checked = tx
      .select()
      .from(listItems)
      .where(and(inArray(listItems.id, ids), liveItem, eq(listItems.checkedAt, checkedAt)))
      .all();
    for (const item of checked) restoreItem(tx, item, false);
  });
}

export type RemovedRecipe = { contributionIds: string[]; itemIds: string[]; deletedAt: Date };

/**
 * "Remove recipe from list" (spec 4.6): removes that recipe's amounts from the list's items;
 * items left with no amounts are deleted. Returns what it removed, for Undo.
 */
export function removeRecipeFromList(listId: string, recipeId: string): RemovedRecipe {
  const deletedAt = new Date();
  return db.transaction((tx) => {
    const affected = tx
      .select({ itemId: listItemContributions.listItemId, id: listItemContributions.id })
      .from(listItemContributions)
      .innerJoin(listItems, eq(listItems.id, listItemContributions.listItemId))
      .where(and(eq(listItems.listId, listId), liveItem, eq(listItemContributions.recipeId, recipeId), liveContribution))
      .all();
    const removed: RemovedRecipe = { contributionIds: affected.map((a) => a.id), itemIds: [], deletedAt };
    if (affected.length === 0) return removed;
    updateRows(tx, listItemContributions, inArray(listItemContributions.id, removed.contributionIds), { deletedAt });
    for (const itemId of new Set(affected.map((a) => a.itemId))) {
      if (liveContributions(tx, itemId).length === 0) {
        updateRows(tx, listItems, eq(listItems.id, itemId), { deletedAt });
        removed.itemIds.push(itemId);
      }
    }
    return removed;
  });
}

/**
 * Remove recipe's "Undo": brings back the amounts and items `removeRecipeFromList` deleted at
 * `deletedAt`, checked or not as they were. One deleted again since stays deleted; an item whose
 * ingredient has been opened again since gets its amounts on that item.
 */
export function restoreRecipeOnList({ contributionIds, itemIds, deletedAt }: RemovedRecipe): void {
  if (contributionIds.length === 0) return;
  db.transaction((tx) => {
    updateRows(
      tx,
      listItemContributions,
      and(inArray(listItemContributions.id, contributionIds), eq(listItemContributions.deletedAt, deletedAt)),
      { deletedAt: null },
    );
    if (itemIds.length === 0) return;
    const removed = tx
      .select()
      .from(listItems)
      .where(and(inArray(listItems.id, itemIds), eq(listItems.deletedAt, deletedAt)))
      .all();
    for (const item of removed) restoreItem(tx, item, item.checkedAt !== null);
  });
}

// --- Move to another list (edit sheet, spec 4.4) -----------------------------------------------

/** The live item's checked state and list, for the edit sheet's "Got it" toggle and "Checked … by". */
export function itemStatusQuery(itemId: string) {
  return db
    .select({ listId: listItems.listId, checkedAt: listItems.checkedAt, checkedBy: listItems.checkedBy })
    .from(listItems)
    .where(and(eq(listItems.id, itemId), liveItem));
}

/**
 * The lists an item can move to: the other live, unarchived lists in its list's household, in the
 * user's order. Empty when the household has only the one list (the sheet then leaves Move out).
 */
export function getMoveTargets(itemId: string): { id: string; name: string }[] {
  const item = db
    .select({ listId: listItems.listId, householdId: listItems.householdId })
    .from(listItems)
    .where(and(eq(listItems.id, itemId), liveItem))
    .get();
  if (!item) return [];
  return db
    .select({ id: lists.id, name: lists.name })
    .from(lists)
    .where(
      and(eq(lists.householdId, item.householdId), ne(lists.id, item.listId), isNull(lists.deletedAt), isNull(lists.archivedAt)),
    )
    .orderBy(asc(lists.position))
    .all();
}

export type MoveItemResult = {
  /** The item that was moved; deleted when its amounts joined an item already on the other list. */
  itemId: string;
  fromListId: string;
  fromListName: string;
  toListId: string;
  /** What the move did there, as a single add would (spec 4.4): a new item, Combine, or reopen. */
  kind: AddDecision['kind'];
  /** The item the amounts are on now: the moved item itself for 'new'. */
  targetItemId: string;
  /** That item's name, and its total after a Combine, for the toast. */
  name: string;
  totalAmountText?: string;
  /** The moved item's amounts. */
  contributionIds: string[];
  /** What reopening replaced, so Undo can put it back. */
  reopened?: { checkedAt: Date; checkedBy: string | null; contributionIds: string[] };
};

/**
 * "Move to another list…": moves an item and its amounts to another list in the same household. An
 * open item meets that list as a single add would (spec 4.4): an open match gets its amounts
 * (Combine) and the moved item goes; a checked match is unchecked with its amounts replaced; else
 * the item itself moves. A checked item moves as it is. A move isn't a use, so history is unchanged.
 * Throws for a missing item or list, the item's own list, or a list in another household.
 */
export function moveItemToList(itemId: string, toListId: string): MoveItemResult {
  return db.transaction((tx) => {
    const item = getItem(tx, itemId);
    if (item.deletedAt) throw new Error(`No list item ${itemId}`);
    const to = tx
      .select({ id: lists.id, householdId: lists.householdId })
      .from(lists)
      .where(and(eq(lists.id, toListId), isNull(lists.deletedAt)))
      .get();
    if (!to) throw new Error(`No list ${toListId}`);
    if (to.id === item.listId) throw new Error(i18n.t('errors.alreadyOnList', { name: displayItemName(item.displayName) }));
    if (to.householdId !== item.householdId) throw new Error(i18n.t('errors.otherHousehold'));
    const from = tx.select({ name: lists.name }).from(lists).where(eq(lists.id, item.listId)).get();

    const moved = liveContributions(tx, itemId);
    const contributionIds = moved.map((c) => c.id);
    const base = { itemId, fromListId: item.listId, fromListName: from?.name ?? '', toListId, contributionIds };
    // A move compares the item's own key only (spec 4.4), whatever the household's setting.
    const decision: AddDecision =
      item.checkedAt === null ? detectDuplicate(item.ingredientName, liveItemsForList(tx, toListId, false)) : { kind: 'new' };

    if (decision.kind === 'new') {
      updateRows(tx, listItems, eq(listItems.id, itemId), { listId: toListId });
      return { ...base, kind: 'new', targetItemId: itemId, name: item.displayName };
    }

    const target = getItem(tx, decision.itemId);
    const previous = liveContributions(tx, target.id);
    const now = new Date();
    let reopened: MoveItemResult['reopened'];
    if (decision.kind === 'reopen') {
      if (previous.length > 0) {
        updateRows(tx, listItemContributions, inArray(listItemContributions.id, previous.map((c) => c.id)), {
          deletedAt: now,
        });
      }
      updateRows(tx, listItems, eq(listItems.id, target.id), { checkedAt: null, checkedBy: null });
      reopened = { checkedAt: target.checkedAt!, checkedBy: target.checkedBy, contributionIds: previous.map((c) => c.id) };
    }
    if (contributionIds.length > 0) {
      updateRows(tx, listItemContributions, inArray(listItemContributions.id, contributionIds), { listItemId: target.id });
    }
    updateRows(tx, listItems, eq(listItems.id, itemId), { deletedAt: now });
    return {
      ...base,
      kind: decision.kind,
      targetItemId: target.id,
      name: target.displayName,
      totalAmountText:
        decision.kind === 'combine'
          ? itemTotal(liveContributions(tx, target.id), usualUnitFor(tx, item.householdId, item.ingredientName))
          : undefined,
      reopened,
    };
  });
}

/**
 * The move toast's "Undo": the item goes back to its list with its amounts, and an item it joined
 * returns to its earlier amounts (and to checked, if the move reopened it). If the same ingredient
 * has been opened on the first list since, the amounts go onto that item, as `undeleteItem` does.
 */
export function undoMove(result: MoveItemResult): void {
  db.transaction((tx) => {
    if (result.kind === 'new') {
      const item = getItem(tx, result.itemId);
      const open =
        item.checkedAt === null ? findOpenItem(tx, result.fromListId, item.ingredientName, item.id) : undefined;
      if (open) {
        updateRows(tx, listItemContributions, and(eq(listItemContributions.listItemId, item.id), liveContribution), {
          listItemId: open.id,
        });
        updateRows(tx, listItems, eq(listItems.id, item.id), { deletedAt: item.deletedAt ?? new Date() });
      } else {
        updateRows(tx, listItems, eq(listItems.id, item.id), { listId: result.fromListId });
      }
      return;
    }
    if (result.contributionIds.length > 0) {
      updateRows(tx, listItemContributions, inArray(listItemContributions.id, result.contributionIds), {
        listItemId: result.itemId,
      });
    }
    if (result.kind === 'reopen' && result.reopened) {
      const { checkedAt, checkedBy, contributionIds } = result.reopened;
      updateRows(tx, listItems, eq(listItems.id, result.targetItemId), { checkedAt, checkedBy });
      if (contributionIds.length > 0) {
        updateRows(tx, listItemContributions, inArray(listItemContributions.id, contributionIds), { deletedAt: null });
      }
    }
    restoreItem(tx, getItem(tx, result.itemId), false);
  });
}
