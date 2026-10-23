// Migrations 0026 and 0027 (spec 4.3.3, 7.1): aisle orders move to the household. A device
// upgrading from the per-user order gets the two new tables and custom aisles' created_at, and
// loses the old order rows and their queued mutations (the server would refuse them forever).
// Everything else stays.
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

let sqlite: Database.Database;
const mutation = (table: string, ref: Record<string, unknown>) => JSON.stringify({ table, ...ref, hlc: 'h', fields: {} });
const all = (sql: string) => sqlite.prepare(sql).all();
const tableNames = () =>
  (all("select name from sqlite_master where type = 'table' and name like '%category_order%' order by name") as { name: string }[]).map(
    (r) => r.name,
  );

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  for (const { tag } of journal.entries.filter((e) => e.idx < 26)) apply(sqlite, tag);

  // A device with a per-user order, a custom aisle and queued changes, as the last version left it.
  sqlite.exec(`
    insert into households (id, name, created_at, updated_at) values ('h1', 'Home', 0, 0);
    insert into categories (id, slug, name, household_id, default_rank) values ('produce', 'produce', 'Produce', null, 0);
    insert into categories (id, slug, name, household_id, default_rank) values ('costco', null, 'Costco', 'h1', null);
    insert into user_category_order (user_id, category_id, position) values ('u1', 'produce', 1), ('u1', 'costco', 2);
  `);
  const outbox = sqlite.prepare('insert into outbox (household_id, mutation, created_at, rejected_at) values (?, ?, 0, ?)');
  outbox.run(null, mutation('user_category_order', { key: { user_id: 'u1', category_id: 'produce' } }), null);
  outbox.run(null, mutation('user_category_order', { key: { user_id: 'u1', category_id: 'costco' } }), 1);
  outbox.run(null, mutation('user_settings', { key: { user_id: 'u1' } }), null);
  outbox.run('h1', mutation('categories', { id: 'costco' }), null);
});

test('0026 and 0027 are the household aisle order migrations', () => {
  expect(journal.entries.filter((e) => e.idx >= 26).map((e) => e.tag)).toEqual(['0026_household_aisle_order', '0027_drop_tmp']);
});

test('adds both order tables next to the old one, and created_at on categories (null for existing rows)', () => {
  apply(sqlite, '0026_household_aisle_order');

  expect(tableNames()).toEqual(['household_category_order', 'user_category_order', 'user_household_category_order']);
  expect(all('select id, created_at from categories order by id')).toEqual([
    { id: 'costco', created_at: null },
    { id: 'produce', created_at: null },
  ]);
  sqlite.exec(`
    insert into household_category_order (household_id, category_ids, created_at, updated_at) values ('h1', '["costco"]', 0, 0);
    insert into user_household_category_order (user_id, household_id, category_ids) values ('u1', 'h1', '["produce"]');
  `);
  expect(all('select household_id, category_ids, updated_by, field_clock from household_category_order')).toEqual([
    { household_id: 'h1', category_ids: '["costco"]', updated_by: null, field_clock: '{}' },
  ]);
  // Both orders belong to a household this device has.
  expect(() => sqlite.exec(`insert into user_household_category_order (user_id, household_id, category_ids) values ('u1', 'nope', '[]')`)).toThrow(
    /FOREIGN KEY/,
  );
});

test('drops the old order and every queued mutation of it, rejected ones too; keeps the rest in order', () => {
  apply(sqlite, '0026_household_aisle_order');
  apply(sqlite, '0027_drop_tmp');

  expect(tableNames()).toEqual(['household_category_order', 'user_household_category_order']);
  const left = (all('select household_id, mutation from outbox order by id') as { household_id: string | null; mutation: string }[]).map(
    (r) => [r.household_id, JSON.parse(r.mutation).table],
  );
  expect(left).toEqual([
    [null, 'user_settings'],
    ['h1', 'categories'],
  ]);
  expect(all('select id from categories order by id')).toEqual([{ id: 'costco' }, { id: 'produce' }]);
});
