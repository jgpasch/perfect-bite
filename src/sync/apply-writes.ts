// Runs the shared planner's writes (`src/shared/domain/`, share-server-import plan §1) on the
// device: each through `insertRow` / `updateRows` / `upsertRow`, so it makes its outbox mutation
// as any other local write does.
import { and, eq, getTableColumns, getTableName, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

import { ingredientUnitUsage, ingredientUsage, listItemContributions, listItems, recipeIngredients, recipes } from '@/db';
import type { Write, WriteTable } from '@/shared/domain/list-plan';

import type { Exec } from './clock';
import { insertRow, updateRows, upsertRow, type Patch, type SyncedTable } from './mutate';

const TABLES = new Map<string, SyncedTable>(
  [listItems, listItemContributions, ingredientUsage, ingredientUnitUsage, recipes, recipeIngredients].map((t) => [
    getTableName(t),
    t,
  ]),
);

function tableOf(name: WriteTable): SyncedTable {
  const table = TABLES.get(name);
  if (!table) throw new Error(`No table ${name} for a planned write`);
  return table;
}

/** Wire columns (snake_case, ISO dates) as the table's properties and values. */
function toRow(table: SyncedTable, wire: Record<string, unknown>): Record<string, unknown> {
  const byName = new Map(
    Object.entries(getTableColumns(table) as Record<string, SQLiteColumn>).map(([prop, column]) => [column.name, { prop, column }]),
  );
  const row: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(wire)) {
    const found = byName.get(name);
    if (!found) throw new Error(`No column ${getTableName(table)}.${name} for a planned write`);
    row[found.prop] = found.column.dataType === 'date' && typeof value === 'string' ? new Date(value) : value;
  }
  return row;
}

/** The row's key, as properties, from the write's `id` or `key`. */
function keyOf(table: SyncedTable, write: Write): Record<string, unknown> {
  return write.id !== undefined ? { id: write.id } : toRow(table, write.key ?? {});
}

function keyWhere(table: SyncedTable, key: Record<string, unknown>): SQL {
  const columns = getTableColumns(table) as Record<string, SQLiteColumn>;
  return and(...Object.entries(key).map(([prop, value]) => eq(columns[prop], value)))!;
}

/** Runs `writes` in order inside `exec`'s transaction. */
export function applyWrites(exec: Exec, writes: readonly Write[]): void {
  exec.transaction((tx) => {
    for (const write of writes) {
      const table = tableOf(write.table);
      const key = keyOf(table, write);
      const fields = toRow(table, write.fields) as Patch<SyncedTable>;
      const counters = write.counters && (toRow(table, write.counters) as { useCount?: number });
      if (write.op === 'insert') insertRow(tx, table, { ...key, ...fields }, counters);
      else if (write.op === 'update') updateRows(tx, table, keyWhere(table, key), fields, counters);
      else upsertRow(tx, table, { ...key, ...fields }, fields, counters);
    }
  });
}
