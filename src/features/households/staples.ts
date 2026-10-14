// Always have: the household's staples (spec 4.5). Household data like aisle choices (4.3.2): any
// member marks or unmarks one, it syncs to everyone in the household, and it never crosses
// households. Recipe adds leave them out by default (`src/features/recipes/add-to-list.ts`).
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { db, householdStaples, ingredientUsage } from '@/db';
import { upsertRow } from '@/sync/mutate';

/** Tables `staplesQuery` reads, for `useLiveQueryOn`. */
export const STAPLES_QUERY_TABLES = [householdStaples, ingredientUsage];

/**
 * The household's staples (live query), by display name: the household's own text for the ingredient when it has
 * one (`ingredient_usage`), else the key.
 */
export function staplesQuery(householdId: string) {
  const displayName = sql<string>`coalesce(${ingredientUsage.displayName}, ${householdStaples.ingredientName})`;
  return db
    .select({ ingredientName: householdStaples.ingredientName, displayName })
    .from(householdStaples)
    .leftJoin(
      ingredientUsage,
      and(
        eq(ingredientUsage.householdId, householdStaples.householdId),
        eq(ingredientUsage.ingredientName, householdStaples.ingredientName),
      ),
    )
    .where(and(eq(householdStaples.householdId, householdId), isNull(householdStaples.deletedAt)))
    .orderBy(sql`lower(${displayName})`, asc(householdStaples.ingredientName));
}

/** Whether the ingredient (by key) is one of the household's staples. */
export function isStaple(householdId: string, ingredientName: string): boolean {
  const row = db
    .select({ deletedAt: householdStaples.deletedAt })
    .from(householdStaples)
    .where(and(eq(householdStaples.householdId, householdId), eq(householdStaples.ingredientName, ingredientName)))
    .get();
  return row !== undefined && row.deletedAt === null;
}

/**
 * Marks (`on`) or unmarks an ingredient, by key, as a staple for everyone in the household. Unmarking sets
 * `deleted_at` and marking again clears it, so the later change wins (7.3). No change, no write.
 */
export function setStaple(householdId: string, ingredientName: string, on: boolean, userId: string | null): void {
  // Unmarking one that isn't marked returns here, so only a mark ever inserts.
  if (isStaple(householdId, ingredientName) === on) return;
  const deletedAt = on ? null : new Date();
  upsertRow(db, householdStaples, { householdId, ingredientName, createdBy: userId, deletedAt }, { deletedAt });
}

/** The item sheet's footnote under its Always have switch (spec 4.2): staples are the household's. */
export function alwaysHaveFootnote(householdName: string | null): string {
  const name = householdName?.trim();
  return `Left off when you add a recipe. Changes it for everyone in ${name || 'your household'}.`;
}

/** The household's staples' keys, for matching recipe ingredients. */
export function stapleNames(householdId: string): Set<string> {
  return new Set(
    db
      .select({ ingredientName: householdStaples.ingredientName })
      .from(householdStaples)
      .where(and(eq(householdStaples.householdId, householdId), isNull(householdStaples.deletedAt)))
      .all()
      .map((r) => r.ingredientName),
  );
}
