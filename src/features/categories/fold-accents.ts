// Accent folding in the ingredient key (spec 4.15): the device's copy of the server's one-time
// merge (supabase/migrations/*_fold_accents.sql, private.fold_ingredient_keys), run once at app
// start. Keys written before normalizeIngredientName folded accents (`limón`) are merged into
// their folded keys (`limon`) by the same rules, so this device's rows match what the server now
// holds and what new adds compute:
//
// - ingredients (the local catalog): a categorized row first, then a seed one, then the one
//   already under the folded key.
// - ingredient_usage, ingredient_unit_usage: counts summed, the latest last_used_at; usage keeps
//   the display name and field_clock of its latest use, and stays hidden only if every row was.
// - household_category_overrides, household_staples: the newest row wins (its field's HLC, then
//   updated_at).
// - list_items, recipe_ingredients: the key is rewritten; display names keep what was typed. Two
//   open items for one folded key on a list merge: the older one stays, the other is deleted and
//   its contributions move over.
// - outbox: unpushed mutations name the folded key, so a push doesn't bring an accented key back.
//
// Writes go straight to SQLite, never to the outbox: the server makes the same merge itself.
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

import {
  db,
  householdCategoryOverrides,
  householdStaples,
  ingredients,
  ingredientUnitUsage,
  ingredientUsage,
  listItemContributions,
  listItems,
  outbox,
  recipeIngredients,
  type FieldClock,
} from '@/db';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { foldAccents } from '@/shared';
import { compareHlc } from '@/sync/hlc';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const FOLD_ACCENTS_KEY = 'catalog.accentsFolded';

/** Groups `rows` by `groupKey`, keeping only groups where some row's key folds to something else. */
function foldedGroups<T>(rows: T[], keyOf: (row: T) => string, groupKey: (row: T, folded: string) => string): T[][] {
  const groups = new Map<string, { rows: T[]; touched: boolean }>();
  for (const row of rows) {
    const key = keyOf(row);
    const folded = foldAccents(key);
    const id = groupKey(row, folded);
    const group = groups.get(id) ?? { rows: [], touched: false };
    group.rows.push(row);
    group.touched ||= folded !== key;
    groups.set(id, group);
  }
  return [...groups.values()].filter((g) => g.touched).map((g) => g.rows);
}

/** Newest first by `hlc` (missing last), then by `updatedAt`, then by key. */
function byNewest<T extends { ingredientName: string; fieldClock: FieldClock; updatedAt: Date }>(field: string) {
  return (a: T, b: T) => {
    const ha = a.fieldClock[field];
    const hb = b.fieldClock[field];
    if (ha !== hb) {
      if (!ha) return 1;
      if (!hb) return -1;
      return compareHlc(hb, ha);
    }
    return b.updatedAt.getTime() - a.updatedAt.getTime() || (a.ingredientName < b.ingredientName ? -1 : 1);
  };
}

/** Replaces a group's rows (each named by `where`) with one row under the folded key. */
function replaceGroup(tx: Tx, table: SQLiteTable, wheres: SQL[], row: Record<string, unknown>) {
  for (const where of wheres) tx.delete(table).where(where).run();
  tx.insert(table)
    .values(row as never)
    .run();
}

function foldCatalog(tx: Tx) {
  const rows = tx.select().from(ingredients).all();
  for (const group of foldedGroups(rows, (r) => r.normalizedName, (_, folded) => folded)) {
    const newKey = foldAccents(group[0].normalizedName);
    const rank = (r: (typeof rows)[number]) =>
      [r.status === 'categorized', r.categorizedBy === 'seed', r.normalizedName === newKey].map((b) => (b ? 0 : 1)).join('');
    const [winner] = [...group].sort((a, b) => rank(a).localeCompare(rank(b)) || (a.normalizedName < b.normalizedName ? -1 : 1));
    tx.delete(ingredients)
      .where(
        inArray(
          ingredients.normalizedName,
          group.map((r) => r.normalizedName),
        ),
      )
      .run();
    tx.insert(ingredients)
      .values({ ...winner, normalizedName: newKey })
      .run();
  }
}

function foldListItems(tx: Tx, now: Date) {
  const open = tx
    .select({ id: listItems.id, listId: listItems.listId, ingredientName: listItems.ingredientName, createdAt: listItems.createdAt, deletedAt: listItems.deletedAt, checkedAt: listItems.checkedAt })
    .from(listItems)
    .all()
    .filter((r) => r.deletedAt === null && r.checkedAt === null);
  for (const group of foldedGroups(open, (r) => r.ingredientName, (r, folded) => JSON.stringify([r.listId, folded]))) {
    if (group.length < 2) continue;
    const [keeper, ...merged] = [...group].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
    const ids = merged.map((r) => r.id);
    tx.update(listItems).set({ deletedAt: now, updatedAt: now }).where(inArray(listItems.id, ids)).run();
    tx.update(listItemContributions).set({ listItemId: keeper.id }).where(inArray(listItemContributions.listItemId, ids)).run();
  }
  for (const table of [listItems, recipeIngredients] as const) {
    const keys = tx.selectDistinct({ name: table.ingredientName }).from(table).all();
    for (const { name } of keys) {
      const folded = foldAccents(name);
      if (folded !== name) tx.update(table).set({ ingredientName: folded }).where(eq(table.ingredientName, name)).run();
    }
  }
}

function foldUsage(tx: Tx) {
  const rows = tx.select().from(ingredientUsage).all();
  const groups = foldedGroups(rows, (r) => r.ingredientName, (r, folded) => JSON.stringify([r.householdId, folded]));
  for (const group of groups) {
    const newKey = foldAccents(group[0].ingredientName);
    const latest = [...group].sort(
      (a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime() || Number(b.ingredientName === newKey) - Number(a.ingredientName === newKey),
    )[0];
    const hidden = group.every((r) => r.hiddenAt !== null)
      ? new Date(Math.max(...group.map((r) => r.hiddenAt!.getTime())))
      : null;
    replaceGroup(
      tx,
      ingredientUsage,
      group.map((r) => and(eq(ingredientUsage.householdId, r.householdId), eq(ingredientUsage.ingredientName, r.ingredientName))!),
      {
        householdId: latest.householdId,
        ingredientName: newKey,
        displayName: latest.displayName,
        useCount: group.reduce((n, r) => n + r.useCount, 0),
        lastUsedAt: latest.lastUsedAt,
        hiddenAt: hidden,
        fieldClock: latest.fieldClock,
        createdAt: new Date(Math.min(...group.map((r) => r.createdAt.getTime()))),
      },
    );
  }

  const units = tx.select().from(ingredientUnitUsage).all();
  const unitGroups = foldedGroups(units, (r) => r.ingredientName, (r, folded) => JSON.stringify([r.householdId, folded, r.unitKey]));
  for (const group of unitGroups) {
    const first = group[0];
    replaceGroup(
      tx,
      ingredientUnitUsage,
      group.map(
        (r) =>
          and(
            eq(ingredientUnitUsage.householdId, r.householdId),
            eq(ingredientUnitUsage.ingredientName, r.ingredientName),
            eq(ingredientUnitUsage.unitKey, r.unitKey),
          )!,
      ),
      {
        householdId: first.householdId,
        ingredientName: foldAccents(first.ingredientName),
        unitKey: first.unitKey,
        useCount: group.reduce((n, r) => n + r.useCount, 0),
        lastUsedAt: new Date(Math.max(...group.map((r) => r.lastUsedAt.getTime()))),
        fieldClock: first.fieldClock,
        createdAt: new Date(Math.min(...group.map((r) => r.createdAt.getTime()))),
      },
    );
  }
}

function foldHouseholdRows(tx: Tx) {
  const overrides = tx.select().from(householdCategoryOverrides).all();
  for (const group of foldedGroups(overrides, (r) => r.ingredientName, (r, folded) => JSON.stringify([r.householdId, folded]))) {
    const [winner] = [...group].sort(byNewest('category_id'));
    replaceGroup(
      tx,
      householdCategoryOverrides,
      group.map((r) => and(eq(householdCategoryOverrides.householdId, r.householdId), eq(householdCategoryOverrides.ingredientName, r.ingredientName))!),
      { ...winner, ingredientName: foldAccents(winner.ingredientName) },
    );
  }

  const staples = tx.select().from(householdStaples).all();
  for (const group of foldedGroups(staples, (r) => r.ingredientName, (r, folded) => JSON.stringify([r.householdId, folded]))) {
    const [winner] = [...group].sort(byNewest('deleted_at'));
    replaceGroup(
      tx,
      householdStaples,
      group.map((r) => and(eq(householdStaples.householdId, r.householdId), eq(householdStaples.ingredientName, r.ingredientName))!),
      { ...winner, ingredientName: foldAccents(winner.ingredientName) },
    );
  }
}

function foldOutbox(tx: Tx) {
  for (const { id, mutation } of tx.select({ id: outbox.id, mutation: outbox.mutation }).from(outbox).all()) {
    const field = mutation.fields.ingredient_name;
    const key = mutation.key?.ingredient_name;
    const foldedField = typeof field === 'string' ? foldAccents(field) : field;
    const foldedKey = key === undefined ? key : foldAccents(key);
    if (foldedField === field && foldedKey === key) continue;
    const next = {
      ...mutation,
      fields: typeof field === 'string' ? { ...mutation.fields, ingredient_name: foldedField! } : mutation.fields,
      ...(mutation.key && foldedKey !== undefined ? { key: { ...mutation.key, ingredient_name: foldedKey } } : {}),
    };
    tx.update(outbox).set({ mutation: next }).where(eq(outbox.id, id)).run();
  }
}

/**
 * One-time step at app start, after the catalog seed loads: merges every accented ingredient key on
 * this device into its folded key (see the top of this file). Guarded by its own device setting.
 */
export function foldAccentKeys(now = new Date()): void {
  if (getDeviceSetting(FOLD_ACCENTS_KEY, false)) return;
  db.transaction((tx) => {
    foldCatalog(tx);
    foldListItems(tx, now);
    foldUsage(tx);
    foldHouseholdRows(tx);
    foldOutbox(tx);
  });
  setDeviceSetting(FOLD_ACCENTS_KEY, true);
}
