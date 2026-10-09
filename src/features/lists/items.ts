// List items (spec 4.2, 4.4): local reads and writes. M5 adds the outbox write beside each of these.
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, max, ne, or } from 'drizzle-orm';

import { db, ingredients, listItemContributions, listItems, lists, userCategoryOverrides, type ListItem } from '@/db';
import { effectiveCategoryId } from '@/domain/category-resolver';
import { detectDuplicate, planBulkAdd, type AddDecision } from '@/domain/duplicate-detector';
import type { Amount } from '@/domain/quantity-display';
import { summarizeAmounts } from '@/domain/quantity-math';
import { clearCategoryOverride, setCategoryOverride } from '@/features/categories/categories';
import { newId } from '@/lib/id';
import { normalizeIngredientName, parseAmount, parseQuantity, type Unit } from '@/shared';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const liveItem = isNull(listItems.deletedAt);
const liveContribution = isNull(listItemContributions.deletedAt);

export class DuplicateItemError extends Error {
  constructor(name: string) {
    super(`${name} is already on this list`);
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
  /** The item's name and its amounts before this add (combine only), for the toast. */
  existingName?: string;
  existingAmountText?: string;
  /** What reopening replaced, so Undo can put it back. */
  reopened?: { checkedAt: Date; checkedBy: string | null; contributionIds: string[] };
};

function liveItemsForList(tx: Tx, listId: string) {
  return tx
    .select({ id: listItems.id, ingredientName: listItems.ingredientName, checkedAt: listItems.checkedAt })
    .from(listItems)
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

export type ParsedAdd = { ingredientName: string; displayName: string; quantity: number | null; unit: Unit | null };

function parseAdd(text: string): ParsedAdd | null {
  const { quantity, unit, name } = parseQuantity(text);
  const ingredientName = normalizeIngredientName(name);
  return ingredientName ? { ingredientName, displayName: name, quantity, unit } : null;
}

/** Applies one add inside a transaction, following `decision`. */
function applyAdd(
  tx: Tx,
  list: { id: string; householdId: string },
  add: ParsedAdd,
  decision: AddDecision,
  meta: { userId: string | null; source: Source; recipeId?: string | null },
): AddItemResult {
  const contributionId = newId();
  const contribution = {
    id: contributionId,
    householdId: list.householdId,
    source: meta.source,
    recipeId: meta.recipeId ?? null,
    quantity: add.quantity,
    unit: add.unit,
    addedBy: meta.userId,
  };

  if (decision.kind === 'new') {
    const itemId = newId();
    tx.insert(listItems)
      .values({
        id: itemId,
        listId: list.id,
        householdId: list.householdId,
        ingredientName: add.ingredientName,
        displayName: add.displayName,
        addedBy: meta.userId,
      })
      .run();
    tx.insert(listItemContributions).values({ ...contribution, listItemId: itemId }).run();
    return { itemId, contributionId, kind: 'new' };
  }

  const item = getItem(tx, decision.itemId);
  const previous = liveContributions(tx, item.id);

  if (decision.kind === 'combine') {
    tx.insert(listItemContributions).values({ ...contribution, listItemId: item.id }).run();
    return {
      itemId: item.id,
      contributionId,
      kind: 'combine',
      existingName: item.displayName,
      existingAmountText: summarizeAmounts(previous),
    };
  }

  // Reopen: you bought it before and need it again, so the old amounts no longer apply.
  if (previous.length > 0) {
    tx.update(listItemContributions)
      .set({ deletedAt: new Date() })
      .where(inArray(listItemContributions.id, previous.map((c) => c.id)))
      .run();
  }
  tx.update(listItems).set({ checkedAt: null, checkedBy: null }).where(eq(listItems.id, item.id)).run();
  tx.insert(listItemContributions).values({ ...contribution, listItemId: item.id }).run();
  return {
    itemId: item.id,
    contributionId,
    kind: 'reopen',
    reopened: { checkedAt: item.checkedAt!, checkedBy: item.checkedBy, contributionIds: previous.map((c) => c.id) },
  };
}

function getListForAdd(tx: Tx, listId: string) {
  const list = tx.select({ id: lists.id, householdId: lists.householdId }).from(lists).where(eq(lists.id, listId)).get();
  if (!list) throw new Error(`No list ${listId}`);
  return list;
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
    const decision = detectDuplicate(add.ingredientName, liveItemsForList(tx, listId));
    return applyAdd(tx, list, add, decision, { userId, source });
  });
}

/** Toast "Undo" (spec 4.4): removes the add entirely, restoring what it changed. */
export function undoAdd(result: AddItemResult): void {
  db.transaction((tx) => {
    const now = new Date();
    tx.update(listItemContributions).set({ deletedAt: now }).where(eq(listItemContributions.id, result.contributionId)).run();
    if (result.kind === 'new') {
      tx.update(listItems).set({ deletedAt: now }).where(eq(listItems.id, result.itemId)).run();
    } else if (result.kind === 'reopen' && result.reopened) {
      const { checkedAt, checkedBy, contributionIds } = result.reopened;
      tx.update(listItems).set({ checkedAt, checkedBy }).where(eq(listItems.id, result.itemId)).run();
      if (contributionIds.length > 0) {
        tx.update(listItemContributions)
          .set({ deletedAt: null })
          .where(inArray(listItemContributions.id, contributionIds))
          .run();
      }
    }
  });
}

/**
 * Toast "Keep existing" (spec 4.4): drops the new amount. An amount from a recipe keeps its
 * recipe link with no quantity, so the By recipe view stays accurate.
 */
export function keepExisting(contributionId: string): void {
  const c = db.select().from(listItemContributions).where(eq(listItemContributions.id, contributionId)).get();
  if (!c) return;
  if (c.source === 'recipe') {
    db.update(listItemContributions).set({ quantity: null, unit: null }).where(eq(listItemContributions.id, contributionId)).run();
  } else {
    db.update(listItemContributions).set({ deletedAt: new Date() }).where(eq(listItemContributions.id, contributionId)).run();
  }
}

/** The edit sheet's per-amount delete control (spec 4.4). */
export function deleteContribution(contributionId: string): void {
  db.update(listItemContributions).set({ deletedAt: new Date() }).where(eq(listItemContributions.id, contributionId)).run();
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
      createdAt: listItemContributions.createdAt,
    })
    .from(listItemContributions)
    .where(and(eq(listItemContributions.listItemId, itemId), liveContribution))
    .orderBy(asc(listItemContributions.createdAt));
}

// --- Bulk add (spec 4.4, used by "Add recipe to list" in M4) --------------------------------

/** One add in a bulk add: typed text, or an ingredient that is already parsed (a recipe's). */
export type BulkAdd = ({ text: string } | { parsed: ParsedAdd }) & { source?: Source; recipeId?: string | null };

const parseBulkAdd = (a: BulkAdd): ParsedAdd | null => ('parsed' in a ? a.parsed : parseAdd(a.text));

export type BulkConflict = {
  /** Index into the adds. */
  index: number;
  ingredientName: string;
  displayName: string;
  /** The open item's current amounts, and the incoming one. */
  existingAmountText: string;
  incomingAmountText: string;
};

/** What a bulk add would conflict with, for the bulk sheet. Reads only. */
export function planBulkAddToList(listId: string, adds: readonly BulkAdd[]): BulkConflict[] {
  return db.transaction((tx) => {
    const parsed = adds.map(parseBulkAdd);
    const live = liveItemsForList(tx, listId);
    const { conflicts } = planBulkAdd(
      parsed.map((p) => p?.ingredientName ?? ''),
      live,
    );
    return conflicts
      .filter((i) => parsed[i] !== null)
      .map((index) => {
        const p = parsed[index]!;
        const existing = live.find((l) => l.ingredientName === p.ingredientName && l.checkedAt === null)!;
        return {
          index,
          ingredientName: p.ingredientName,
          displayName: getItem(tx, existing.id).displayName,
          existingAmountText: summarizeAmounts(liveContributions(tx, existing.id)),
          incomingAmountText: summarizeAmounts([p]),
        };
      });
  });
}

/**
 * Adds many items in one transaction. Conflicts Combine unless their index is in
 * `keepExisting` (the bulk sheet's per-row toggle). Returns one result per add (null if the add
 * was empty or kept nothing).
 */
export function addItemsBulk(
  listId: string,
  adds: readonly BulkAdd[],
  userId: string | null,
  keepExistingIndexes: ReadonlySet<number> = new Set(),
): (AddItemResult | null)[] {
  return db.transaction((tx) => {
    const list = getListForAdd(tx, listId);
    const parsed = adds.map(parseBulkAdd);
    const { decisions } = planBulkAdd(
      parsed.map((p) => p?.ingredientName ?? ''),
      liveItemsForList(tx, listId),
    );
    const results: (AddItemResult | null)[] = [];
    parsed.forEach((add, i) => {
      if (!add) return results.push(null);
      const meta = { userId, source: adds[i].source ?? 'manual', recipeId: adds[i].recipeId };
      const decision = decisions[i];
      if (decision.kind === 'sameAsEarlier') {
        const first = results[decision.index];
        if (!first) return results.push(null);
        return results.push(applyAdd(tx, list, add, { kind: 'combine', itemId: first.itemId }, meta));
      }
      if (decision.kind === 'combine' && keepExistingIndexes.has(i)) {
        // Keep existing: no new amount, but a recipe still records its link (no quantity).
        if (meta.source !== 'recipe') return results.push(null);
        return results.push(applyAdd(tx, list, { ...add, quantity: null, unit: null }, decision, meta));
      }
      results.push(applyAdd(tx, list, add, decision, meta));
    });
    return results;
  });
}

/**
 * Makes an item live and unchecked (or live and checked, for undoing a delete of a checked
 * item). If the same ingredient is already open on the list, the item's amounts move onto that
 * one instead, since a list holds one open item per ingredient.
 */
function restoreItem(tx: Tx, item: ListItem, checked: boolean): void {
  if (!checked) {
    const open = findOpenItem(tx, item.listId, item.ingredientName, item.id);
    if (open) {
      tx.update(listItemContributions)
        .set({ listItemId: open.id })
        .where(and(eq(listItemContributions.listItemId, item.id), liveContribution))
        .run();
      tx.update(listItems).set({ deletedAt: item.deletedAt ?? new Date() }).where(eq(listItems.id, item.id)).run();
      return;
    }
  }
  tx.update(listItems)
    .set({
      deletedAt: null,
      checkedAt: checked ? (item.checkedAt ?? new Date()) : null,
      checkedBy: checked ? item.checkedBy : null,
    })
    .where(eq(listItems.id, item.id))
    .run();
}

export function setItemChecked(itemId: string, checked: boolean, userId: string | null): void {
  db.transaction((tx) => {
    const item = getItem(tx, itemId);
    if (checked) {
      tx.update(listItems).set({ checkedAt: new Date(), checkedBy: userId }).where(eq(listItems.id, itemId)).run();
    } else {
      restoreItem(tx, item, false);
    }
  });
}

export function deleteItem(itemId: string): void {
  db.update(listItems).set({ deletedAt: new Date() }).where(eq(listItems.id, itemId)).run();
}

/** Undoes `deleteItem`, putting the item back checked or unchecked as it was. */
export function undeleteItem(itemId: string): void {
  db.transaction((tx) => {
    const item = getItem(tx, itemId);
    if (item.deletedAt === null) return;
    restoreItem(tx, item, item.checkedAt !== null);
  });
}

/** "Clear checked items": deletes every checked item on the list. Returns how many. */
export function clearChecked(listId: string): number {
  const now = new Date();
  return db
    .update(listItems)
    .set({ deletedAt: now })
    .where(and(eq(listItems.listId, listId), liveItem, isNotNull(listItems.checkedAt)))
    .run().changes;
}

/** "Uncheck all". */
export function uncheckAll(listId: string): void {
  db.transaction((tx) => {
    const checked = tx
      .select()
      .from(listItems)
      .where(and(eq(listItems.listId, listId), liveItem, isNotNull(listItems.checkedAt)))
      .orderBy(asc(listItems.checkedAt))
      .all();
    for (const item of checked) restoreItem(tx, item, false);
  });
}

export type ItemEdit = {
  name: string;
  amount: string;
  note: string;
  /**
   * Category choice from the sheet: a category id (the user's override), null for "Reset to
   * default", or undefined when the user didn't touch it.
   */
  categoryId?: string | null;
};

/**
 * Saves the item edit sheet. The amount is text (`2 lb`); when it changes, the item's amounts
 * are replaced by that one amount. Throws `DuplicateItemError` if a rename would make a second
 * open item for the same ingredient, and a plain Error for an unreadable amount.
 */
export function updateItem(itemId: string, edit: ItemEdit, userId: string | null = null): void {
  const name = edit.name.trim().replace(/\s+/g, ' ');
  const ingredientName = normalizeIngredientName(name);
  if (!ingredientName) throw new Error('An item needs a name');

  db.transaction((tx) => {
    const item = getItem(tx, itemId);
    if (item.checkedAt === null && findOpenItem(tx, item.listId, ingredientName, item.id)) {
      throw new DuplicateItemError(name);
    }
    tx.update(listItems)
      .set({ displayName: name, ingredientName, note: edit.note.trim() || null })
      .where(eq(listItems.id, itemId))
      .run();

    // Spec 4.3.2: a per-user override for the ingredient, on every list.
    if (userId && edit.categoryId !== undefined) {
      if (edit.categoryId === null) clearCategoryOverride(userId, ingredientName);
      else setCategoryOverride(userId, ingredientName, edit.categoryId);
    }

    const contributions = tx
      .select()
      .from(listItemContributions)
      .where(and(eq(listItemContributions.listItemId, itemId), liveContribution))
      .orderBy(asc(listItemContributions.createdAt))
      .all();
    // Unchanged (including a combined `1 gal + 1`, which isn't itself a parseable amount).
    if (edit.amount.trim() === summarizeAmounts(contributions)) return;
    const amount = parseAmount(edit.amount);
    if (!amount) throw new Error(`"${edit.amount.trim()}" isn't an amount, like 2 or 1 lb`);

    if (contributions.length === 1) {
      tx.update(listItemContributions).set(amount).where(eq(listItemContributions.id, contributions[0].id)).run();
      return;
    }
    if (contributions.length > 1) {
      tx.update(listItemContributions)
        .set({ deletedAt: new Date() })
        .where(inArray(listItemContributions.id, contributions.map((c) => c.id)))
        .run();
    }
    tx.insert(listItemContributions)
      .values({ id: newId(), listItemId: itemId, householdId: item.householdId, source: 'manual', ...amount })
      .run();
  });
}

// --- Reads ---------------------------------------------------------------------------------

/** One row per (item, contribution), with this user's category; group with `groupItems`. */
export function listItemsQuery(listId: string, userId: string | null) {
  return db
    .select({
      id: listItems.id,
      ingredientName: listItems.ingredientName,
      displayName: listItems.displayName,
      note: listItems.note,
      checkedAt: listItems.checkedAt,
      createdAt: listItems.createdAt,
      defaultCategoryId: ingredients.defaultCategoryId,
      overrideCategoryId: userCategoryOverrides.categoryId,
      quantity: listItemContributions.quantity,
      unit: listItemContributions.unit,
      contributionId: listItemContributions.id,
    })
    .from(listItems)
    .leftJoin(
      listItemContributions,
      and(eq(listItemContributions.listItemId, listItems.id), liveContribution),
    )
    .leftJoin(ingredients, eq(ingredients.normalizedName, listItems.ingredientName))
    .leftJoin(
      userCategoryOverrides,
      and(
        eq(userCategoryOverrides.ingredientName, listItems.ingredientName),
        eq(userCategoryOverrides.userId, userId ?? ''),
      ),
    )
    .where(and(eq(listItems.listId, listId), liveItem))
    .orderBy(asc(listItems.createdAt), asc(listItems.id), asc(listItemContributions.createdAt));
}

/** Tables `listItemsQuery` reads, for `useLiveQueryOn`. */
export const LIST_ITEMS_QUERY_TABLES = [listItems, listItemContributions, ingredients, userCategoryOverrides];

type ItemRow = Awaited<ReturnType<typeof listItemsQuery>>[number];

export type ItemView = {
  id: string;
  ingredientName: string;
  /** This user's section (spec 5, "Effective category"). */
  categoryId: string;
  displayName: string;
  note: string | null;
  checkedAt: Date | null;
  amounts: Amount[];
  /** `2 lb`, `1 gal + 1`, or empty. */
  amountText: string;
};

/** Groups `listItemsQuery` rows into items, unchecked (oldest first) then checked (most recent first). */
export function groupItems(rows: readonly ItemRow[]): { unchecked: ItemView[]; checked: ItemView[] } {
  const byId = new Map<string, ItemView>();
  for (const row of rows) {
    let item = byId.get(row.id);
    if (!item) {
      item = {
        id: row.id,
        ingredientName: row.ingredientName,
        categoryId: effectiveCategoryId(row.overrideCategoryId, row.defaultCategoryId),
        displayName: row.displayName,
        note: row.note,
        checkedAt: row.checkedAt,
        amounts: [],
        amountText: '',
      };
      byId.set(row.id, item);
    }
    if (row.contributionId) item.amounts.push({ quantity: row.quantity, unit: row.unit });
  }
  const items = [...byId.values()];
  for (const item of items) item.amountText = summarizeAmounts(item.amounts);
  return {
    unchecked: items.filter((i) => !i.checkedAt),
    checked: items
      .filter((i) => i.checkedAt)
      .sort((a, b) => b.checkedAt!.getTime() - a.checkedAt!.getTime()),
  };
}

/** The item edit sheet's starting values (category untouched), plus the item's ingredient key. */
export function getItemEdit(itemId: string): (ItemEdit & { ingredientName: string }) | null {
  const rows = listItemsQueryForItem(itemId);
  if (rows.length === 0) return null;
  const amounts = rows.filter((r) => r.contributionId).map((r) => ({ quantity: r.quantity, unit: r.unit }));
  return {
    name: rows[0].displayName,
    amount: summarizeAmounts(amounts),
    note: rows[0].note ?? '',
    ingredientName: rows[0].ingredientName,
  };
}

function listItemsQueryForItem(itemId: string) {
  return db
    .select({
      displayName: listItems.displayName,
      ingredientName: listItems.ingredientName,
      note: listItems.note,
      quantity: listItemContributions.quantity,
      unit: listItemContributions.unit,
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
 * Autocomplete, first source (spec 4.2): names this household has added before, most recent
 * first, matching `prefix` at the start of the name or of a word.
 */
export function searchRecentItems(householdId: string, prefix: string, limit: number) {
  const p = prefix.trim().toLowerCase().replace(/[%_]/g, '');
  if (!p) return [];
  return db
    .select({ key: listItems.ingredientName, displayName: max(listItems.displayName) })
    .from(listItems)
    .where(
      and(
        eq(listItems.householdId, householdId),
        or(like(listItems.displayName, `${p}%`), like(listItems.displayName, `% ${p}%`)),
      ),
    )
    .groupBy(listItems.ingredientName)
    .orderBy(desc(max(listItems.createdAt)))
    .limit(limit)
    .all()
    .map((r) => ({ key: r.key, displayName: r.displayName ?? r.key }));
}
