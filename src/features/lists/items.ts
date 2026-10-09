// List items (spec 4.2): local reads and writes. M5 adds the outbox write beside each of these.
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, max, ne, or } from 'drizzle-orm';

import { db, ingredients, listItemContributions, listItems, lists, userCategoryOverrides, type ListItem } from '@/db';
import { effectiveCategoryId } from '@/domain/category-resolver';
import { formatAmounts, type Amount } from '@/domain/quantity-display';
import { clearCategoryOverride, setCategoryOverride } from '@/features/categories/categories';
import { newId } from '@/lib/id';
import { normalizeIngredientName, parseAmount, parseQuantity } from '@/shared';

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

export type AddItemResult = { itemId: string; combined: boolean };

/**
 * Adds typed or dictated text to a list: `2 lbs chicken thighs` → item `chicken thighs` with a
 * 2 lb contribution. If the ingredient is already open on the list, the amount is added to that
 * item instead (Combine). M3 adds the toast, quantity math and the checked-item rule (spec 4.4).
 * Returns null for text with nothing to add.
 */
export function addItem(
  listId: string,
  text: string,
  userId: string | null,
  source: 'manual' | 'siri' = 'manual',
): AddItemResult | null {
  const { quantity, unit, name } = parseQuantity(text);
  const ingredientName = normalizeIngredientName(name);
  if (!ingredientName) return null;

  return db.transaction((tx) => {
    const list = tx.select({ householdId: lists.householdId }).from(lists).where(eq(lists.id, listId)).get();
    if (!list) throw new Error(`No list ${listId}`);

    const existing = findOpenItem(tx, listId, ingredientName);
    const itemId = existing?.id ?? newId();
    if (!existing) {
      tx.insert(listItems)
        .values({
          id: itemId,
          listId,
          householdId: list.householdId,
          ingredientName,
          displayName: name,
          addedBy: userId,
        })
        .run();
    }
    tx.insert(listItemContributions)
      .values({ id: newId(), listItemId: itemId, householdId: list.householdId, source, quantity, unit, addedBy: userId })
      .run();
    return { itemId, combined: !!existing };
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
    if (edit.amount.trim() === formatAmounts(contributions)) return;
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
  for (const item of items) item.amountText = formatAmounts(item.amounts);
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
    amount: formatAmounts(amounts),
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
