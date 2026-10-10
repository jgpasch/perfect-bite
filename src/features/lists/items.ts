// List items (spec 4.2, 4.4): local reads and writes. M5 adds the outbox write beside each of these.
import { and, asc, eq, inArray, isNotNull, isNull, like, ne, or } from 'drizzle-orm';

import {
  db,
  households,
  ingredientUnitUsage,
  ingredientUsage,
  ingredients,
  listItemContributions,
  listItems,
  lists,
  recipes,
  userCategoryOverrides,
  type ListItem,
} from '@/db';
import { effectiveCategoryId } from '@/domain/category-resolver';
import { detectDuplicate, planBulkAdd, type AddDecision } from '@/domain/duplicate-detector';
import type { Amount } from '@/domain/quantity-display';
import { combineAmounts, stepAmount, summarizeAmounts } from '@/domain/quantity-math';
import { rankHistory } from '@/domain/suggestion-rank';
import { usualUnit } from '@/domain/usual-unit';
import { clearCategoryOverride, ensureLocalIngredient, setCategoryOverride } from '@/features/categories/categories';
import { recordUsage, unrecordUsage } from '@/features/lists/usage';
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
  /** The item's name and its total amount after this add (combine only), for the toast. */
  existingName?: string;
  totalAmountText?: string;
  /** What reopening replaced, so Undo can put it back. */
  reopened?: { checkedAt: Date; checkedBy: string | null; contributionIds: string[] };
  /** The name, if this add was the first to record it (pending), for `categorizePending`. */
  pendingNames: string[];
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

/**
 * An item's total as it reads on its row. A recipe link with no quantity (from "Keep
 * existing", or "Make recipe..." on an existing item) records the recipe, not an amount, so it
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
  const rows = tx
    .select()
    .from(ingredientUnitUsage)
    .where(and(eq(ingredientUnitUsage.householdId, householdId), eq(ingredientUnitUsage.ingredientName, ingredientName)))
    .all();
  return usualUnit(rows) ?? null;
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
  meta: { userId: string | null; source: Source; recipeId?: string | null; at?: Date },
): AddItemResult {
  const at = meta.at ?? new Date();
  const contributionId = newId();
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
    const itemId = newId();
    tx.insert(listItems)
      .values({
        id: itemId,
        listId: list.id,
        householdId: list.householdId,
        ingredientName: add.ingredientName,
        displayName: add.displayName,
        addedBy: meta.userId,
        createdAt: at,
      })
      .run();
    tx.insert(listItemContributions).values({ ...contribution, listItemId: itemId }).run();
    return { itemId, contributionId, kind: 'new', pendingNames };
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
      totalAmountText: itemTotal(
        [...previous, contribution],
        usualUnitFor(tx, list.householdId, item.ingredientName),
      ),
      pendingNames,
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
    pendingNames,
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

/** Toast "Undo" (spec 4.4): removes the add entirely, restoring what it changed, and its use. */
export function undoAdd(result: AddItemResult): void {
  db.transaction((tx) => {
    const now = new Date();
    const item = getItem(tx, result.itemId);
    const undone = tx
      .select({ quantity: listItemContributions.quantity, unit: listItemContributions.unit })
      .from(listItemContributions)
      .where(eq(listItemContributions.id, result.contributionId))
      .get();
    unrecordUsage(tx, item.householdId, item.ingredientName, undone);
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

export type BulkConflict = {
  /** Index into the adds. */
  index: number;
  ingredientName: string;
  displayName: string;
  /** The open item's current amounts, and the incoming one. */
  existingAmountText: string;
  incomingAmountText: string;
  /**
   * The item's total after Combine, and after Keep existing, as its row would read. Both count
   * the batch's later adds of the same ingredient, which fold into this one as `addItemsBulk` does.
   */
  combinedAmountText: string;
  keptAmountText: string;
};

/** What a bulk add would conflict with, for the bulk sheet. Reads only. */
export function planBulkAddToList(listId: string, adds: readonly BulkAdd[]): BulkConflict[] {
  return db.transaction((tx) => {
    const parsed = adds.map(parseBulkAdd);
    const list = getListForAdd(tx, listId);
    const live = liveItemsForList(tx, listId);
    const { decisions, conflicts } = planBulkAdd(
      parsed.map((p) => p?.ingredientName ?? ''),
      live,
    );
    const amountOf = (i: number) => ({ source: adds[i].source ?? 'manual', quantity: parsed[i]!.quantity, unit: parsed[i]!.unit });
    return conflicts
      .filter((i) => parsed[i] !== null)
      .map((index) => {
        const p = parsed[index]!;
        const existing = live.find((l) => l.ingredientName === p.ingredientName && l.checkedAt === null)!;
        const contributions = liveContributions(tx, existing.id);
        const usual = usualUnitFor(tx, list.householdId, p.ingredientName);
        const repeats = decisions.flatMap((d, i) =>
          d.kind === 'sameAsEarlier' && d.index === index && parsed[i] !== null ? [amountOf(i)] : [],
        );
        // Keep existing drops a typed add and its repeats; a recipe keeps a link (no amount), so its repeats still add.
        const keepsRepeats = (adds[index].source ?? 'manual') === 'recipe';
        return {
          index,
          ingredientName: p.ingredientName,
          displayName: getItem(tx, existing.id).displayName,
          existingAmountText: itemTotal(contributions, usual),
          incomingAmountText: summarizeAmounts([p]),
          combinedAmountText: itemTotal([...contributions, amountOf(index), ...repeats], usual),
          keptAmountText: itemTotal(keepsRepeats ? [...contributions, ...repeats] : contributions, usual),
        };
      });
  });
}

/**
 * Adds many items in one transaction. Conflicts Combine unless their index is in
 * `keepExisting` (the bulk sheet's per-row toggle). Returns one result per add (null if the add
 * was empty or kept nothing). The adds share one timestamp, so Newest (spec 4.6) keeps them
 * together in the order given.
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
 * open item for the same ingredient, and a plain Error for an unreadable amount. Returns the new
 * name if the rename recorded it as pending, for `categorizePending`.
 */
export function updateItem(itemId: string, edit: ItemEdit, userId: string | null = null): string[] {
  const name = edit.name.trim().replace(/\s+/g, ' ');
  const ingredientName = normalizeIngredientName(name);
  if (!ingredientName) throw new Error('An item needs a name');

  return db.transaction((tx) => {
    const item = getItem(tx, itemId);
    if (item.checkedAt === null && findOpenItem(tx, item.listId, ingredientName, item.id)) {
      throw new DuplicateItemError(name);
    }
    tx.update(listItems)
      .set({ displayName: name, ingredientName, note: edit.note.trim() || null })
      .where(eq(listItems.id, itemId))
      .run();
    const pendingNames =
      ingredientName !== item.ingredientName && ensureLocalIngredient(tx, ingredientName, name) ? [ingredientName] : [];

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
    // Compared with the total the sheet showed, so with the usual unit of the name it opened with.
    if (edit.amount.trim() === itemTotal(contributions, usualUnitFor(tx, item.householdId, item.ingredientName))) {
      return pendingNames;
    }
    const amount = parseAmount(edit.amount);
    if (!amount) throw new Error(`"${edit.amount.trim()}" isn't an amount, like 2 or 1 lb`);
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
    .values({ id: newId(), listItemId: item.id, householdId: item.householdId, source: 'manual', ...amount })
    .run();
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
      ingredientStatus: ingredients.status,
      overrideCategoryId: userCategoryOverrides.categoryId,
      quantity: listItemContributions.quantity,
      unit: listItemContributions.unit,
      contributionId: listItemContributions.id,
      source: listItemContributions.source,
      recipeId: listItemContributions.recipeId,
      recipeName: recipes.name,
      contributedAt: listItemContributions.createdAt,
    })
    .from(listItems)
    .leftJoin(
      listItemContributions,
      and(eq(listItemContributions.listItemId, listItems.id), liveContribution),
    )
    .leftJoin(recipes, and(eq(recipes.id, listItemContributions.recipeId), isNull(recipes.deletedAt)))
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
export const LIST_ITEMS_QUERY_TABLES = [listItems, listItemContributions, ingredients, userCategoryOverrides, recipes];

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
  /** This user's section (spec 5, "Effective category"). */
  categoryId: string;
  displayName: string;
  note: string | null;
  checkedAt: Date | null;
  /** When the item row was made; Newest (spec 4.6) goes by its amounts and falls back to this. */
  createdAt: Date;
  amounts: Amount[];
  /** The household's usual unit for the ingredient (null: a count, or nothing known). */
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
};

/**
 * Groups `listItemsQuery` rows into items, unchecked (oldest first) then checked (most recent
 * first). `usualUnits` is `usualUnitsByKey` over `usualUnitsQuery`.
 */
export function groupItems(
  rows: readonly ItemRow[],
  usualUnits: ReadonlyMap<string, Unit | null> = new Map(),
): { unchecked: ItemView[]; checked: ItemView[] } {
  const byId = new Map<string, ItemView>();
  for (const row of rows) {
    let item = byId.get(row.id);
    if (!item) {
      item = {
        id: row.id,
        ingredientName: row.ingredientName,
        categoryId: effectiveCategoryId(row.overrideCategoryId, row.defaultCategoryId, row.ingredientStatus),
        displayName: row.displayName,
        note: row.note,
        checkedAt: row.checkedAt,
        createdAt: row.createdAt,
        amounts: [],
        usualUnit: usualUnits.get(row.ingredientName) ?? null,
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
 * The item edit sheet's starting values (category untouched), plus the item's ingredient key and
 * usual unit, which the sheet's live total uses.
 */
export function getItemEdit(
  itemId: string,
): (ItemEdit & { ingredientName: string; usualUnit: Unit | null }) | null {
  return db.transaction((tx) => {
    const rows = listItemsQueryForItem(tx, itemId);
    if (rows.length === 0) return null;
    const amounts = rows
      .filter((r) => r.contributionId)
      .map((r) => ({ quantity: r.quantity, unit: r.unit, source: r.source! }));
    const unit = usualUnitFor(tx, rows[0].householdId, rows[0].ingredientName);
    return {
      name: rows[0].displayName,
      amount: itemTotal(amounts, unit),
      note: rows[0].note ?? '',
      ingredientName: rows[0].ingredientName,
      usualUnit: unit,
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

/** "Check all" in a recipe section (spec 4.6). */
export function checkItems(itemIds: readonly string[], userId: string | null): void {
  if (itemIds.length === 0) return;
  db.update(listItems)
    .set({ checkedAt: new Date(), checkedBy: userId })
    .where(and(inArray(listItems.id, [...itemIds]), isNull(listItems.checkedAt)))
    .run();
}

/**
 * "Remove recipe from list" (spec 4.6): removes that recipe's amounts from the list's items;
 * items left with no amounts are deleted.
 */
export function removeRecipeFromList(listId: string, recipeId: string): void {
  db.transaction((tx) => {
    const now = new Date();
    const affected = tx
      .select({ itemId: listItemContributions.listItemId, id: listItemContributions.id })
      .from(listItemContributions)
      .innerJoin(listItems, eq(listItems.id, listItemContributions.listItemId))
      .where(and(eq(listItems.listId, listId), liveItem, eq(listItemContributions.recipeId, recipeId), liveContribution))
      .all();
    if (affected.length === 0) return;
    tx.update(listItemContributions)
      .set({ deletedAt: now })
      .where(inArray(listItemContributions.id, affected.map((a) => a.id)))
      .run();
    for (const itemId of new Set(affected.map((a) => a.itemId))) {
      if (liveContributions(tx, itemId).length === 0) {
        tx.update(listItems).set({ deletedAt: now }).where(eq(listItems.id, itemId)).run();
      }
    }
  });
}
