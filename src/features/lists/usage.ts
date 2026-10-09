// Household ingredient history for autocomplete (spec 4.2). Callers write it inside the same
// transaction as the add it counts.
import { and, eq, lte, sql } from 'drizzle-orm';

import { db, ingredientUsage } from '@/db';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const row = (householdId: string, ingredientName: string) =>
  and(eq(ingredientUsage.householdId, householdId), eq(ingredientUsage.ingredientName, ingredientName));

/** Counts one use of `ingredientName` (the key) by the household. A new use unhides a hidden row. */
export function recordUsage(tx: Tx, householdId: string, ingredientName: string, displayName: string, at: Date) {
  tx.insert(ingredientUsage)
    .values({ householdId, ingredientName, displayName, useCount: 1, lastUsedAt: at })
    .onConflictDoUpdate({
      target: [ingredientUsage.householdId, ingredientUsage.ingredientName],
      set: { useCount: sql`${ingredientUsage.useCount} + 1`, displayName, lastUsedAt: at, hiddenAt: null },
    })
    .run();
}

/** Takes back one use (an undone add). The row goes away when its count reaches 0. */
export function unrecordUsage(tx: Tx, householdId: string, ingredientName: string) {
  tx.update(ingredientUsage)
    .set({ useCount: sql`max(${ingredientUsage.useCount} - 1, 0)` })
    .where(row(householdId, ingredientName))
    .run();
  tx.delete(ingredientUsage)
    .where(and(row(householdId, ingredientName), lte(ingredientUsage.useCount, 0)))
    .run();
}
