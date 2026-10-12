// Migration 0011 (spec 4.3.2): aisle overrides and custom aisles become household data. A device
// upgrading from per-user aisles drops them, the order rows that point at its custom aisles, and
// the outbox mutations the new server would reject forever. Everything else stays.
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

const SYSTEM = 'cat-produce';
const CUSTOM = 'cat-costco';
let sqlite: Database.Database;

const mutation = (table: string, ref: Record<string, unknown>) => JSON.stringify({ table, ...ref, hlc: 'h', fields: {} });
const all = (sql: string) => sqlite.prepare(sql).all();

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  for (const { tag } of journal.entries.filter((e) => e.idx < 11)) apply(sqlite, tag);

  // A device with per-user aisle data, as the last version left it.
  sqlite.exec(`
    insert into households (id, name, created_at, updated_at) values ('h1', 'Home', 0, 0);
    insert into categories (id, slug, name, owner_user_id, default_rank) values ('${SYSTEM}', 'produce', 'Produce', null, 0);
    insert into categories (id, slug, name, owner_user_id, default_rank) values ('${CUSTOM}', null, 'Costco', 'u1', null);
    insert into user_category_order (user_id, category_id, position) values ('u1', '${SYSTEM}', 1), ('u1', '${CUSTOM}', 2);
    insert into user_category_overrides (user_id, ingredient_name, category_id) values ('u1', 'milk', '${CUSTOM}');
  `);
  const outbox = sqlite.prepare('insert into outbox (household_id, mutation, created_at) values (?, ?, 0)');
  outbox.run(null, mutation('user_category_overrides', { key: { user_id: 'u1', ingredient_name: 'milk' } }));
  outbox.run(null, mutation('categories', { id: CUSTOM }));
  outbox.run(null, mutation('user_category_order', { key: { user_id: 'u1', category_id: CUSTOM } }));
  outbox.run(null, mutation('user_category_order', { key: { user_id: 'u1', category_id: SYSTEM } }));
  outbox.run(null, mutation('user_settings', { key: { user_id: 'u1' } }));
  outbox.run('h1', mutation('lists', { id: 'l1' }));
});

test('0011 is the household aisles migration', () => {
  expect(journal.entries.find((e) => e.idx === 11)?.tag).toBe('0011_household_aisles');
});

test('drops custom aisles, overrides and the order rows that point at them; keeps system aisles and their order', () => {
  apply(sqlite, '0011_household_aisles');

  expect(all('select id, slug, name, household_id from categories')).toEqual([
    { id: SYSTEM, slug: 'produce', name: 'Produce', household_id: null },
  ]);
  expect(all('select user_id, category_id, position from user_category_order')).toEqual([
    { user_id: 'u1', category_id: SYSTEM, position: 1 },
  ]);
  expect(all("select name from sqlite_master where name = 'user_category_overrides'")).toEqual([]);
  expect(all('select * from household_category_overrides')).toEqual([]);
});

test('drops queued category, override and custom-aisle order mutations; keeps the rest in order', () => {
  apply(sqlite, '0011_household_aisles');

  const left = (all('select household_id, mutation from outbox order by id') as { household_id: string | null; mutation: string }[]).map(
    (r) => [r.household_id, JSON.parse(r.mutation).table, JSON.parse(r.mutation).key?.category_id ?? null],
  );
  expect(left).toEqual([
    [null, 'user_category_order', SYSTEM],
    [null, 'user_settings', null],
    ['h1', 'lists', null],
  ]);
});

test('the new tables take household aisles: a nullable override category, a custom aisle per household', () => {
  apply(sqlite, '0011_household_aisles');

  sqlite.exec(`
    insert into categories (id, slug, name, household_id) values ('cat-bulk', null, 'Bulk', 'h1');
    insert into household_category_overrides (household_id, ingredient_name, category_id, created_at, updated_at)
      values ('h1', 'rice', 'cat-bulk', 0, 0), ('h1', 'milk', null, 0, 0);
  `);
  expect(all('select household_id, ingredient_name, category_id, field_clock from household_category_overrides order by ingredient_name')).toEqual([
    { household_id: 'h1', ingredient_name: 'milk', category_id: null, field_clock: '{}' },
    { household_id: 'h1', ingredient_name: 'rice', category_id: 'cat-bulk', field_clock: '{}' },
  ]);
  // Foreign keys: an unknown household or category is refused.
  expect(() => sqlite.exec("insert into categories (id, name, household_id) values ('x', 'X', 'nope')")).toThrow(/FOREIGN KEY/);
  expect(() =>
    sqlite.exec(
      "insert into household_category_overrides (household_id, ingredient_name, category_id, created_at, updated_at) values ('h1', 'tea', 'nope', 0, 0)",
    ),
  ).toThrow(/FOREIGN KEY/);
  // One override per ingredient per household.
  expect(() =>
    sqlite.exec(
      "insert into household_category_overrides (household_id, ingredient_name, category_id, created_at, updated_at) values ('h1', 'rice', null, 0, 0)",
    ),
  ).toThrow(/UNIQUE/);
});

test('runs on a device with no aisle data', () => {
  sqlite.exec('delete from outbox; delete from user_category_overrides; delete from user_category_order; delete from categories;');
  expect(() => apply(sqlite, '0011_household_aisles')).not.toThrow();
  expect(all('select * from categories')).toEqual([]);
});
