// Dev-only: copies this device's SQLite data up to Supabase so it can be browsed in Studio
// (Settings > Developer). A one-way snapshot, not sync: rows are upserted as they are, and the
// tables that hard-delete locally are replaced wholesale. Nothing comes back down.
// TODO(M5): sync replaces this.
import { getTableColumns, getTableName } from 'drizzle-orm';
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core';

import {
  categories,
  db,
  ingredientUsage,
  listItemContributions,
  listItems,
  lists,
  recipeIngredients,
  recipes,
  userCategoryOrder,
  userCategoryOverrides,
  userSettings,
} from '@/db';
import { registerHouseholds } from '@/features/households/households';
import { supabase } from '@/lib/supabase';

const CHUNK = 500;

type Row = Record<string, unknown>;

type Step = {
  table: AnySQLiteTable;
  rows: Row[];
  /** Deletes the server rows in scope before the upsert, so local hard deletes carry over. */
  clear?: () => PromiseLike<{ error: unknown }>;
};

export type PushSummary = { table: string; rows: number }[];

/**
 * A local row as Postgres columns: snake_case names, dates as ISO strings. `updated_at` is left
 * out because the server sets it.
 */
export function toServerRow(table: AnySQLiteTable, row: Row): Row {
  const out: Row = {};
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    if (column.name === 'updated_at' || !(key in row)) continue;
    const value = row[key];
    out[column.name] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

function pushError(table: string, error: unknown): Error {
  const message = (error as { message?: unknown } | null)?.message;
  return new Error(`${table}: ${typeof message === 'string' && message ? message : 'push failed'}`);
}

/**
 * Pushes the signed-in user's local data: their custom categories, category order, overrides and
 * settings, plus everything in the households they belong to on the server (local households are
 * registered first). Parents go before children. Throws on the first failing table, naming it.
 */
export async function pushLocalData(userId: string): Promise<PushSummary> {
  await registerHouseholds(userId);
  const { data, error } = await supabase.from('household_members').select('household_id').eq('user_id', userId);
  if (error) throw pushError('household_members', error);
  const householdIds = new Set(((data as { household_id: string }[] | null) ?? []).map((r) => r.household_id));
  const mine = <T extends { householdId: string }>(rows: T[]) => rows.filter((r) => householdIds.has(r.householdId));
  const own = <T extends { userId: string }>(rows: T[]) => rows.filter((r) => r.userId === userId);

  // Read everything first, so the push is one consistent snapshot.
  const steps: Step[] = [
    { table: categories, rows: db.select().from(categories).all().filter((c) => c.ownerUserId === userId) },
    {
      table: userCategoryOrder,
      rows: own(db.select().from(userCategoryOrder).all()),
      clear: () => supabase.from('user_category_order').delete().eq('user_id', userId),
    },
    { table: lists, rows: mine(db.select().from(lists).all()) },
    { table: recipes, rows: mine(db.select().from(recipes).all()) },
    {
      table: listItems,
      // Closed items first, so an item checked off locally frees its ingredient's open slot
      // (one_open_item_per_ingredient) before the item that replaced it arrives.
      rows: mine(db.select().from(listItems).all()).sort(
        (a, b) => Number(!a.checkedAt && !a.deletedAt) - Number(!b.checkedAt && !b.deletedAt),
      ),
    },
    { table: recipeIngredients, rows: mine(db.select().from(recipeIngredients).all()) },
    { table: listItemContributions, rows: mine(db.select().from(listItemContributions).all()) },
    {
      table: ingredientUsage,
      rows: mine(db.select().from(ingredientUsage).all()),
      clear: () => supabase.from('ingredient_usage').delete().in('household_id', [...householdIds]),
    },
    {
      table: userCategoryOverrides,
      rows: own(db.select().from(userCategoryOverrides).all()),
      clear: () => supabase.from('user_category_overrides').delete().eq('user_id', userId),
    },
    {
      table: userSettings,
      rows: own(db.select().from(userSettings).all()),
      clear: () => supabase.from('user_settings').delete().eq('user_id', userId),
    },
  ];

  const summary: PushSummary = [];
  for (const step of steps) {
    const name = getTableName(step.table);
    if (step.clear) {
      const { error: clearError } = await step.clear();
      if (clearError) throw pushError(name, clearError);
    }
    const rows = step.rows.map((r) => toServerRow(step.table, r));
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error: upsertError } = await supabase.from(name).upsert(rows.slice(i, i + CHUNK));
      if (upsertError) throw pushError(name, upsertError);
    }
    summary.push({ table: name, rows: rows.length });
  }
  return summary;
}
