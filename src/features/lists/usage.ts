// Household ingredient history for autocomplete (spec 4.2). Callers write it inside the same
// transaction as the add it counts.
//
// What counts as a use: adding an ingredient to a list (addItem, addItemsBulk) counts one, and so
// does adding one to a recipe (addRecipeIngredient, addParsedRecipeIngredients, which "Make recipe"
// and "Add to recipe" go through). Adding that recipe to a list counts again through addItemsBulk,
// since putting it on a list is a real use. Editing a recipe ingredient doesn't count; undoing a
// list add takes its use back.
//
// Units (ingredient_unit_usage, for the usual unit): each of those uses that has a quantity also
// counts one use of its unit (`unitKey`: the unit, or 'count' for a bare number). A use with no
// quantity (`milk`, or a "Keep existing" recipe link) counts no unit. Undo takes the unit back too.
import { and, eq, isNull, lte, ne, sql } from 'drizzle-orm';

import { db, ingredientUnitUsage, ingredientUsage, listItemContributions, listItems, recipeIngredients } from '@/db';
import type { Amount } from '@/domain/quantity-display';
import { unitKey } from '@/domain/usual-unit';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const row = (householdId: string, ingredientName: string) =>
  and(eq(ingredientUsage.householdId, householdId), eq(ingredientUsage.ingredientName, ingredientName));

const unitRow = (householdId: string, ingredientName: string, key: string) =>
  and(
    eq(ingredientUnitUsage.householdId, householdId),
    eq(ingredientUnitUsage.ingredientName, ingredientName),
    eq(ingredientUnitUsage.unitKey, key),
  );

/**
 * Counts one use of `ingredientName` (the key) by the household. A new use unhides a hidden row.
 * An `amount` with a quantity also counts one use of its unit.
 */
export function recordUsage(
  tx: Tx,
  householdId: string,
  ingredientName: string,
  displayName: string,
  at: Date,
  amount?: Amount,
) {
  tx.insert(ingredientUsage)
    .values({ householdId, ingredientName, displayName, useCount: 1, lastUsedAt: at })
    .onConflictDoUpdate({
      target: [ingredientUsage.householdId, ingredientUsage.ingredientName],
      set: { useCount: sql`${ingredientUsage.useCount} + 1`, displayName, lastUsedAt: at, hiddenAt: null },
    })
    .run();
  if (amount && amount.quantity !== null) {
    tx.insert(ingredientUnitUsage)
      .values({ householdId, ingredientName, unitKey: unitKey(amount.unit), useCount: 1, lastUsedAt: at })
      .onConflictDoUpdate({
        target: [ingredientUnitUsage.householdId, ingredientUnitUsage.ingredientName, ingredientUnitUsage.unitKey],
        set: { useCount: sql`${ingredientUnitUsage.useCount} + 1`, lastUsedAt: at },
      })
      .run();
  }
}

/**
 * Takes back one use (an undone add), and one use of the `amount`'s unit if it has a quantity.
 * Each row goes away when its count reaches 0.
 */
export function unrecordUsage(tx: Tx, householdId: string, ingredientName: string, amount?: Amount) {
  tx.update(ingredientUsage)
    .set({ useCount: sql`max(${ingredientUsage.useCount} - 1, 0)` })
    .where(row(householdId, ingredientName))
    .run();
  tx.delete(ingredientUsage)
    .where(and(row(householdId, ingredientName), lte(ingredientUsage.useCount, 0)))
    .run();
  if (amount && amount.quantity !== null) {
    const unit = unitRow(householdId, ingredientName, unitKey(amount.unit));
    tx.update(ingredientUnitUsage)
      .set({ useCount: sql`max(${ingredientUnitUsage.useCount} - 1, 0)` })
      .where(unit)
      .run();
    tx.delete(ingredientUnitUsage)
      .where(and(unit, lte(ingredientUnitUsage.useCount, 0)))
      .run();
  }
}

/**
 * "Remove from suggestions" (spec 4.2): hides the household's history row from autocomplete. The use
 * count is kept, and the next use unhides it (`recordUsage`). A missing row is a no-op.
 */
export function hideFromSuggestions(householdId: string, ingredientName: string, at = new Date()) {
  db.update(ingredientUsage).set({ hiddenAt: at }).where(row(householdId, ingredientName)).run();
}

const BACKFILL_KEY = 'usage.backfilled';

/**
 * One-time step at app start: builds history from data written before `ingredient_usage`
 * existed. Each live contribution (even on a since-deleted item, since history outlives the
 * item) and each live recipe ingredient counts one use; the latest one gives the display name
 * and time. Rows that already exist are left alone. Guarded by its own device setting.
 */
export function backfillUsage(): void {
  if (getDeviceSetting(BACKFILL_KEY, false)) return;
  db.transaction((tx) => {
    const uses = [
      ...tx
        .select({
          householdId: listItems.householdId,
          ingredientName: listItems.ingredientName,
          displayName: listItems.displayName,
          at: listItemContributions.createdAt,
        })
        .from(listItemContributions)
        .innerJoin(listItems, eq(listItems.id, listItemContributions.listItemId))
        .where(and(isNull(listItemContributions.deletedAt), ne(listItems.ingredientName, '')))
        .all(),
      ...tx
        .select({
          householdId: recipeIngredients.householdId,
          ingredientName: recipeIngredients.ingredientName,
          displayName: recipeIngredients.displayName,
          at: recipeIngredients.createdAt,
        })
        .from(recipeIngredients)
        .where(and(isNull(recipeIngredients.deletedAt), ne(recipeIngredients.ingredientName, '')))
        .all(),
    ];
    const rows = new Map<string, { householdId: string; ingredientName: string; displayName: string; useCount: number; lastUsedAt: Date }>();
    for (const use of uses) {
      const key = JSON.stringify([use.householdId, use.ingredientName]);
      const found = rows.get(key);
      if (!found) {
        rows.set(key, { ...use, useCount: 1, lastUsedAt: use.at });
      } else {
        found.useCount += 1;
        if (use.at >= found.lastUsedAt) {
          found.lastUsedAt = use.at;
          found.displayName = use.displayName;
        }
      }
    }
    for (const { householdId, ingredientName, displayName, useCount, lastUsedAt } of rows.values()) {
      tx.insert(ingredientUsage)
        .values({ householdId, ingredientName, displayName, useCount, lastUsedAt })
        .onConflictDoNothing()
        .run();
    }
  });
  setDeviceSetting(BACKFILL_KEY, true);
}
