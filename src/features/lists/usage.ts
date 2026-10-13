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
// quantity (`milk`, or a recipe ingredient with no amount) counts no unit. Undo takes the unit back too.
import { and, eq, isNotNull, isNull, lte, ne } from 'drizzle-orm';

import { db, ingredientUnitUsage, ingredientUsage, listItemContributions, listItems, recipeIngredients } from '@/db';
import type { Amount } from '@/domain/quantity-display';
import { unitKey } from '@/domain/usual-unit';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { insertRow, updateRows, upsertRow } from '@/sync/mutate';

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
  upsertRow(
    tx,
    ingredientUsage,
    { householdId, ingredientName, displayName, lastUsedAt: at },
    { displayName, lastUsedAt: at, hiddenAt: null },
    { useCount: 1 },
  );
  if (amount && amount.quantity !== null) {
    upsertRow(
      tx,
      ingredientUnitUsage,
      { householdId, ingredientName, unitKey: unitKey(amount.unit), lastUsedAt: at },
      { lastUsedAt: at },
      { useCount: 1 },
    );
  }
}

/**
 * Takes back one use (an undone add), and one use of the `amount`'s unit if it has a quantity.
 * Each row goes away locally when its count reaches 0; the server keeps it at 0 (the decrement is
 * a counter delta, spec 7.1), and a row at 0 reads as absent.
 */
export function unrecordUsage(tx: Tx, householdId: string, ingredientName: string, amount?: Amount) {
  updateRows(tx, ingredientUsage, row(householdId, ingredientName), {}, { useCount: -1 });
  tx.delete(ingredientUsage)
    .where(and(row(householdId, ingredientName), lte(ingredientUsage.useCount, 0)))
    .run();
  if (amount && amount.quantity !== null) {
    const unit = unitRow(householdId, ingredientName, unitKey(amount.unit));
    updateRows(tx, ingredientUnitUsage, unit, {}, { useCount: -1 });
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
  updateRows(db, ingredientUsage, row(householdId, ingredientName), { hiddenAt: at });
}

export const BACKFILL_KEY = 'usage.backfilled';

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
      if (tx.select({ n: ingredientUsage.useCount }).from(ingredientUsage).where(row(householdId, ingredientName)).get()) continue;
      insertRow(tx, ingredientUsage, { householdId, ingredientName, displayName, lastUsedAt }, { useCount });
    }
  });
  setDeviceSetting(BACKFILL_KEY, true);
}

export const UNITS_BACKFILL_KEY = 'usage.unitsBackfilled';

/**
 * One-time step at app start, after `backfillUsage`: builds unit history from data written before
 * `ingredient_unit_usage` existed. Counts the same sources as `backfillUsage`, but only those with
 * a quantity, each as one use of its unit; the latest one gives the time. An ingredient that
 * already has unit rows in its household is left alone, so units recorded since the upgrade aren't
 * counted twice. Guarded by its own device setting, since `usage.backfilled` has already run on
 * existing installs.
 */
export function backfillUnitUsage(): void {
  if (getDeviceSetting(UNITS_BACKFILL_KEY, false)) return;
  db.transaction((tx) => {
    const uses = [
      ...tx
        .select({
          householdId: listItems.householdId,
          ingredientName: listItems.ingredientName,
          unit: listItemContributions.unit,
          at: listItemContributions.createdAt,
        })
        .from(listItemContributions)
        .innerJoin(listItems, eq(listItems.id, listItemContributions.listItemId))
        .where(
          and(
            isNull(listItemContributions.deletedAt),
            ne(listItems.ingredientName, ''),
            isNotNull(listItemContributions.quantity),
          ),
        )
        .all(),
      ...tx
        .select({
          householdId: recipeIngredients.householdId,
          ingredientName: recipeIngredients.ingredientName,
          unit: recipeIngredients.unit,
          at: recipeIngredients.createdAt,
        })
        .from(recipeIngredients)
        .where(
          and(
            isNull(recipeIngredients.deletedAt),
            ne(recipeIngredients.ingredientName, ''),
            isNotNull(recipeIngredients.quantity),
          ),
        )
        .all(),
    ];
    const recorded = new Set(
      tx
        .selectDistinct({ householdId: ingredientUnitUsage.householdId, ingredientName: ingredientUnitUsage.ingredientName })
        .from(ingredientUnitUsage)
        .all()
        .map((r) => JSON.stringify([r.householdId, r.ingredientName])),
    );
    const rows = new Map<string, { householdId: string; ingredientName: string; unitKey: string; useCount: number; lastUsedAt: Date }>();
    for (const use of uses) {
      if (recorded.has(JSON.stringify([use.householdId, use.ingredientName]))) continue;
      const key = unitKey(use.unit);
      const id = JSON.stringify([use.householdId, use.ingredientName, key]);
      const found = rows.get(id);
      if (!found) {
        rows.set(id, { householdId: use.householdId, ingredientName: use.ingredientName, unitKey: key, useCount: 1, lastUsedAt: use.at });
      } else {
        found.useCount += 1;
        if (use.at > found.lastUsedAt) found.lastUsedAt = use.at;
      }
    }
    for (const { useCount, ...values } of rows.values()) {
      // `recorded` already skips ingredients with unit rows, so each of these is new.
      insertRow(tx, ingredientUnitUsage, values, { useCount });
    }
  });
  setDeviceSetting(UNITS_BACKFILL_KEY, true);
}
