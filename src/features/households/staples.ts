// Always have: the household's staples (spec 4.5). Household data like aisle choices (4.3.2): any
// member marks or unmarks one, it syncs to everyone in the household, and it never crosses
// households. Recipe adds leave them out by default (`src/features/recipes/add-to-list.ts`).
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { useMemo } from 'react';

import { db, households, householdStaples, ingredientUsage } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { i18n } from '@/i18n';
import { displayItemName, normalizeIngredientName, parseQuantity } from '@/shared';
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
  return name ? i18n.t('item.alwaysHaveFootnote', { name }) : i18n.t('item.alwaysHaveFootnoteYours');
}

/**
 * The recipe screen's toast after marking or unmarking from an ingredient (spec 4.5 Marking from a recipe):
 * "Added *Salt* to Always have", and on a second line who it changes it for, the household's name picked as
 * `alwaysHaveFootnote` picks it.
 */
export function stapleToast(householdId: string, displayName: string, on: boolean): { message: string; emphasis: string } {
  const name = displayItemName(displayName);
  const household = db.select({ name: households.name }).from(households).where(eq(households.id, householdId)).get();
  const householdName = household?.name.trim();
  const first = i18n.t(on ? 'recipes.toasts.stapleAdded' : 'recipes.toasts.stapleRemoved', { name });
  const second = householdName
    ? i18n.t('recipes.toasts.stapleFor', { name: householdName })
    : i18n.t('recipes.toasts.stapleForYours');
  return { message: `${first}\n${second}`, emphasis: name };
}

/** The staple key for typed text, read as the add bar reads it with the amount ignored: `2 tbsp Olive oils` → `olive oil`. */
export function stapleKeyFromText(text: string): string | null {
  return normalizeIngredientName(parseQuantity(text).name) || null;
}

/**
 * Settings > Always have's add field (spec 4.7): marks typed text as a staple. Returns its key, or null for text with
 * no name. One already marked stays as it is.
 */
export function addStapleFromText(householdId: string, text: string, userId: string | null): string | null {
  const key = stapleKeyFromText(text);
  if (key) setStaple(householdId, key, true, userId);
  return key;
}

/** The household screen's Always have row value: how many staples, "None" with none. */
export function staplesCountLabel(count: number): string {
  return count === 0 ? i18n.t('settings.alwaysHaveScreen.none') : String(count);
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

/** The household's staples' keys as one JSON array: always one row, so an empty result means not read yet. */
function stapleKeysQuery(householdId: string) {
  return db
    .select({ keys: sql<string>`json_group_array(${householdStaples.ingredientName})` })
    .from(householdStaples)
    .where(and(eq(householdStaples.householdId, householdId), isNull(householdStaples.deletedAt)));
}

/**
 * `stapleNames`, kept current (live query): follows marks on this phone and synced from other members' phones.
 * Until the live query's first read lands, read at once, so a sheet opens with its tags.
 */
export function useStapleNames(householdId: string): Set<string> {
  const { data } = useLiveQueryOn(stapleKeysQuery(householdId), [householdStaples], [householdId]);
  const keys = data[0]?.keys;
  return useMemo(
    () => (keys === undefined ? stapleNames(householdId) : new Set(JSON.parse(keys) as string[])),
    [householdId, keys],
  );
}
