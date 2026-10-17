// Migration 0023 (spec 4.4): list items get a photo, `photo_path` in the item-photos bucket. A
// device upgrading keeps its items, each with no photo, and the column takes a path and a null.
import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, expect, test } from '@jest/globals';
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

const PATH = 'h1/i2/01a14b0f-7f00-7375-8da2-13b98fc1a57b.jpg';
let sqlite: Database.Database;
const all = (sql: string) => sqlite.prepare(sql).all();

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  for (const { tag } of journal.entries.filter((e) => e.idx < 23)) apply(sqlite, tag);

  // A device with an item, as the last version left it.
  sqlite.exec(`
    insert into households (id, name, created_at, updated_at) values ('h1', 'Home', 0, 0);
    insert into lists (id, household_id, name, position, created_at, updated_at) values ('l1', 'h1', 'Groceries', 0, 0, 0);
    insert into list_items (id, list_id, household_id, ingredient_name, display_name, created_at, updated_at)
      values ('i1', 'l1', 'h1', 'zaatar', 'za''atar', 0, 0);
  `);
});

test('0023 is the item photo migration', () => {
  expect(journal.entries.find((e) => e.idx === 23)?.tag).toBe('0023_item_photo_path');
});

test('before it, list items have no photo column', () => {
  const columns = (all('pragma table_info(list_items)') as { name: string }[]).map((c) => c.name);
  expect(columns).not.toContain('photo_path');
});

test('an existing item keeps its fields and has no photo', () => {
  apply(sqlite, '0023_item_photo_path');
  expect(all('select id, display_name, note, photo_path from list_items')).toEqual([
    { id: 'i1', display_name: "za'atar", note: null, photo_path: null },
  ]);
});

test('the column is nullable text: it takes a path, and a null again', () => {
  apply(sqlite, '0023_item_photo_path');
  const column = (all('pragma table_info(list_items)') as { name: string; type: string; notnull: number; dflt_value: unknown }[]).find(
    (c) => c.name === 'photo_path',
  );
  expect({ ...column, type: column?.type.toLowerCase() }).toMatchObject({ type: 'text', notnull: 0, dflt_value: null });

  sqlite.exec(`
    insert into list_items (id, list_id, household_id, ingredient_name, display_name, photo_path, created_at, updated_at)
      values ('i2', 'l1', 'h1', 'sumac', 'sumac', '${PATH}', 0, 0);
  `);
  expect(all("select photo_path from list_items where id = 'i2'")).toEqual([{ photo_path: PATH }]);
  sqlite.exec("update list_items set photo_path = null where id = 'i2'");
  expect(all("select photo_path from list_items where id = 'i2'")).toEqual([{ photo_path: null }]);
});
