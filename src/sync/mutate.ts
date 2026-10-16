// The one way to write synced data (spec 7.1). Each helper writes the SQLite row, its
// `field_clock` and an outbox mutation in one transaction (a savepoint inside the caller's), so a
// failure leaves none of them.
//
// Household tables (households, lists, items, contributions, recipes, recipe ingredients, usage,
// custom categories, category overrides, staples) and per-user tables (order, settings) go through here.
// The catalog (`ingredients`, system categories) and device settings don't sync up, so they don't.
import { and, eq, getTableColumns, getTableName, SQL, sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

import {
  categories,
  householdCategoryOverrides,
  households,
  householdStaples,
  ingredientUnitUsage,
  ingredientUsage,
  listItemContributions,
  listItems,
  lists,
  outbox,
  recipeIngredients,
  recipes,
  userCategoryOrder,
  userSettings,
} from '@/db';

import { nextHlc, type Exec } from './clock';
import type { Mutation, WireValue } from './mutation';
import { notifyOutboxWrite } from './outbox-signal';

type Spec = {
  /** Key columns (property names). */
  key: readonly string[];
  /** Columns that merge as counters (`Mutation.counters`), not last-writer-wins. */
  counters?: readonly string[];
  /** Household data has a household; per-user tables don't. */
  household: boolean;
  /** Columns the device keeps but never sends (the server doesn't take them from clients). */
  unsent?: readonly string[];
};

const SPECS = new Map<SQLiteTable, Spec>([
  // Only `set_combine_languages` changes the setting; the device takes it from pulls.
  [households, { key: ['id'], household: true, unsent: ['combineLanguages'] }],
  [lists, { key: ['id'], household: true }],
  [listItems, { key: ['id'], household: true }],
  [listItemContributions, { key: ['id'], household: true }],
  // The server sets added_by to whoever inserted it.
  [recipes, { key: ['id'], household: true, unsent: ['addedBy'] }],
  [recipeIngredients, { key: ['id'], household: true }],
  [ingredientUsage, { key: ['householdId', 'ingredientName'], counters: ['useCount'], household: true }],
  [ingredientUnitUsage, { key: ['householdId', 'ingredientName', 'unitKey'], counters: ['useCount'], household: true }],
  // Custom categories only; slug and rank belong to system ones.
  [categories, { key: ['id'], household: true, unsent: ['slug', 'defaultRank'] }],
  // Only the category is the client's to set; the server stamps created_at.
  [householdCategoryOverrides, { key: ['householdId', 'ingredientName'], household: true, unsent: ['createdAt'] }],
  // Only deleted_at is the client's to set; the server stamps created_by and created_at.
  [householdStaples, { key: ['householdId', 'ingredientName'], household: true, unsent: ['createdBy', 'createdAt'] }],
  [userCategoryOrder, { key: ['userId', 'categoryId'], household: false }],
  [userSettings, { key: ['userId'], household: false }],
]);

export type SyncedTable =
  | typeof households
  | typeof lists
  | typeof listItems
  | typeof listItemContributions
  | typeof recipes
  | typeof recipeIngredients
  | typeof ingredientUsage
  | typeof ingredientUnitUsage
  | typeof categories
  | typeof householdCategoryOverrides
  | typeof householdStaples
  | typeof userCategoryOrder
  | typeof userSettings;

type Row = Record<string, unknown>;
/** Fields to set: plain values only (no SQL), and never the key, `fieldClock` or `updatedAt`. */
export type Patch<T extends SyncedTable> = Partial<Omit<InferInsertModel<T>, 'fieldClock' | 'updatedAt'>>;
export type Counters = { useCount?: number };

/** Never sent: the server sets them (spec 7.1). */
const LOCAL_ONLY = new Set(['updatedAt', 'fieldClock']);

function specOf(table: SQLiteTable): Spec {
  const spec = SPECS.get(table);
  if (!spec) throw new Error(`${getTableName(table)} isn't a synced table`);
  return spec;
}

function columnsOf(table: SQLiteTable): Record<string, SQLiteColumn> {
  return getTableColumns(table) as Record<string, SQLiteColumn>;
}

const toWire = (value: unknown): WireValue => (value instanceof Date ? value.toISOString() : (value as WireValue));

/** The mutation's row reference: `id`, or a composite `key` by column name. */
function rowRef(table: SQLiteTable, spec: Spec, row: Row): Pick<Mutation, 'id' | 'key'> {
  if (spec.key.length === 1 && spec.key[0] === 'id') return { id: row.id as string };
  const columns = columnsOf(table);
  return { key: Object.fromEntries(spec.key.map((k) => [columns[k].name, row[k] as string])) };
}

function householdOf(table: SQLiteTable, spec: Spec, row: Row): string | null {
  if (!spec.household) return null;
  return (table === households ? row.id : row.householdId) as string;
}

function enqueue(tx: Exec, table: SQLiteTable, spec: Spec, row: Row, mutation: Omit<Mutation, 'table' | 'id' | 'key'>) {
  tx.insert(outbox)
    .values({
      householdId: householdOf(table, spec, row),
      mutation: { table: getTableName(table), ...rowRef(table, spec, row), ...mutation },
    })
    .run();
  notifyOutboxWrite();
}

function keyWhere(table: SQLiteTable, spec: Spec, row: Row): SQL {
  const columns = columnsOf(table);
  return and(...spec.key.map((k) => eq(columns[k], row[k])))!;
}

/** The patch's columns, checked: none of them a key, counter or server-owned column, nor SQL. */
function patchFields(table: SQLiteTable, spec: Spec, patch: Row): Record<string, WireValue> {
  const columns = columnsOf(table);
  const fields: Record<string, WireValue> = {};
  for (const [k, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (
      !columns[k] ||
      spec.key.includes(k) ||
      spec.counters?.includes(k) ||
      spec.unsent?.includes(k) ||
      LOCAL_ONLY.has(k) ||
      value instanceof SQL
    ) {
      throw new Error(`${getTableName(table)}.${k} can't be patched`);
    }
    fields[columns[k].name] = toWire(value);
  }
  return fields;
}

const clockFor = (fields: Record<string, WireValue>, hlc: string) =>
  Object.fromEntries(Object.keys(fields).map((f) => [f, hlc]));

function counterDeltas(table: SQLiteTable, spec: Spec, counters: Counters = {}): Record<string, number> {
  const columns = columnsOf(table);
  const out: Record<string, number> = {};
  for (const [k, delta] of Object.entries(counters)) {
    if (delta === undefined || delta === 0) continue;
    if (!spec.counters?.includes(k)) throw new Error(`${getTableName(table)}.${k} isn't a counter`);
    out[columns[k].name] = delta;
  }
  return out;
}

/**
 * Inserts a row and enqueues it with every column but the key, counters, unsent and server-owned
 * ones (defaults included, so the server gets the row as the device has it). Counters start at their
 * delta. Returns the row.
 */
export function insertRow<T extends SyncedTable>(
  exec: Exec,
  table: T,
  values: Patch<T>,
  counters?: Counters,
): InferSelectModel<T> {
  const spec = specOf(table);
  return exec.transaction((tx) => {
    const hlc = nextHlc(tx);
    const deltas = counterDeltas(table, spec, counters);
    const local: Row = { ...values };
    for (const k of Object.keys(counters ?? {})) local[k] = counters![k as keyof Counters] ?? 0;
    const row = tx
      .insert(table as SQLiteTable)
      .values(local as never)
      .returning()
      .get() as Row;
    const sent: Row = {};
    for (const [k, value] of Object.entries(row)) {
      if (!spec.key.includes(k) && !spec.counters?.includes(k) && !spec.unsent?.includes(k) && !LOCAL_ONLY.has(k)) {
        sent[k] = value;
      }
    }
    const fields = patchFields(table, spec, sent);
    tx.update(table as SQLiteTable)
      .set({ fieldClock: clockFor(fields, hlc) } as never)
      .where(keyWhere(table, spec, row))
      .run();
    enqueue(tx, table, spec, row, { hlc, fields, ...(Object.keys(deltas).length ? { counters: deltas } : {}) });
    return row as InferSelectModel<T>;
  });
}

/**
 * Sets `patch` on every row matching `where`, and enqueues one mutation per row with exactly the
 * patched fields (and counter deltas). Counters change locally by their delta, never below 0.
 * Returns the rows as updated.
 */
export function updateRows<T extends SyncedTable>(
  exec: Exec,
  table: T,
  where: SQL | undefined,
  patch: Patch<T>,
  counters?: Counters,
): InferSelectModel<T>[] {
  const spec = specOf(table);
  const fields = patchFields(table, spec, patch as Row);
  const deltas = counterDeltas(table, spec, counters);
  if (Object.keys(fields).length === 0 && Object.keys(deltas).length === 0) return [];
  const columns = columnsOf(table);
  return exec.transaction((tx) => {
    const hlc = nextHlc(tx);
    const set: Row = { ...patch };
    for (const [k, delta] of Object.entries(counters ?? {})) {
      if (delta) set[k] = sql`max(${columns[k]} + ${delta}, 0)`;
    }
    if (Object.keys(fields).length > 0) {
      set.fieldClock = sql`json_patch(${columns.fieldClock}, ${JSON.stringify(clockFor(fields, hlc))})`;
    }
    const rows = tx
      .update(table as SQLiteTable)
      .set(set as never)
      .where(where)
      .returning()
      .all() as Row[];
    for (const row of rows) {
      enqueue(tx, table, spec, row, { hlc, fields, ...(Object.keys(deltas).length ? { counters: deltas } : {}) });
    }
    return rows as InferSelectModel<T>[];
  });
}

/**
 * Inserts `values` if its key is new (`insertRow`), else sets `patch` on that row (`updateRows`).
 * `counters` apply either way.
 */
export function upsertRow<T extends SyncedTable>(
  exec: Exec,
  table: T,
  values: Patch<T>,
  patch: Patch<T>,
  counters?: Counters,
): InferSelectModel<T> {
  const spec = specOf(table);
  return exec.transaction((tx) => {
    const where = keyWhere(table, spec, values as Row);
    const existing = tx
      .select()
      .from(table as SQLiteTable)
      .where(where)
      .get();
    if (!existing) return insertRow(tx, table, values, counters);
    return updateRows(tx, table, where, patch, counters)[0] ?? (existing as InferSelectModel<T>);
  });
}

/**
 * Hard-deletes the matching rows of the user's category order and enqueues a `delete` for each.
 * Household tables soft-delete instead (`updateRows` with `deletedAt`, or a null override).
 * Returns how many rows went.
 */
export function deleteRows(exec: Exec, table: typeof userCategoryOrder, where: SQL | undefined): number {
  const spec = specOf(table);
  return exec.transaction((tx) => {
    const rows = tx.delete(table).where(where).returning().all() as Row[];
    if (rows.length === 0) return 0;
    const hlc = nextHlc(tx);
    for (const row of rows) enqueue(tx, table, spec, row, { hlc, fields: {}, delete: true });
    return rows.length;
  });
}
