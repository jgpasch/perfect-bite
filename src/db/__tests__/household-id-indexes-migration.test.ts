// Migration 0033: household_id indexes on the tables a household purge deletes from by household
// (src/sync/purge.ts), so it doesn't scan them.
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@jest/globals';
import Database from 'better-sqlite3';

const DIR = path.join(__dirname, '../migrations');
const journal: { entries: { idx: number; tag: string }[] } = JSON.parse(
  fs.readFileSync(path.join(DIR, 'meta/_journal.json'), 'utf8'),
);

function apply(sqlite: Database.Database, tag: string) {
  const sql = fs.readFileSync(path.join(DIR, `${tag}.sql`), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

test('0033 is the household_id index migration', () => {
  expect(journal.entries.find((e) => e.idx === 33)?.tag).toBe('0033_household_id_indexes');
});

test.each([
  ['list_items', 'list_items_household_idx'],
  ['recipe_ingredients', 'recipe_ingredients_household_idx'],
  ['list_item_contributions', 'list_item_contributions_household_idx'],
])('%s gets an index on household_id, and a delete by household uses it', (table, index) => {
  const sqlite = new Database(':memory:');
  for (const { tag } of journal.entries.filter((e) => e.idx <= 33)) apply(sqlite, tag);

  const columns = sqlite.prepare(`select name from pragma_index_info(?)`).all(index);
  expect(columns).toEqual([{ name: 'household_id' }]);
  const plan = sqlite.prepare(`explain query plan delete from ${table} where household_id = 'h1'`).all() as { detail: string }[];
  expect(plan.map((p) => p.detail).join('\n')).toContain(`SEARCH ${table} USING COVERING INDEX ${index} (household_id=?)`);
});
