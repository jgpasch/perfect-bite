// Migration 0024 (spec 4.10): recipes keep a photo import's pages, `source_pages` (JSON text) in the
// recipe-pages bucket. A device upgrading keeps its recipes, each with no pages.
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

const PAGES = JSON.stringify(['h1/r2/01a14b0f-7f00-7375-8da2-13b98fc1a57b.jpg', 'h1/r2/01a14b0f-7f00-7375-8da2-13b98fc1a57c.jpg']);
let sqlite: Database.Database;
const all = (sql: string) => sqlite.prepare(sql).all();

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  for (const { tag } of journal.entries.filter((e) => e.idx < 24)) apply(sqlite, tag);

  // A device with a recipe, as the last version left it.
  sqlite.exec(`
    insert into households (id, name, created_at, updated_at) values ('h1', 'Home', 0, 0);
    insert into recipes (id, household_id, name, created_at, updated_at) values ('r1', 'h1', 'Tacos', 0, 0);
  `);
});

test('0024 is the recipe pages migration', () => {
  expect(journal.entries.find((e) => e.idx === 24)?.tag).toBe('0024_recipe_source_pages');
});

test('before it, recipes have no pages column', () => {
  const columns = (all('pragma table_info(recipes)') as { name: string }[]).map((c) => c.name);
  expect(columns).not.toContain('source_pages');
});

test('an existing recipe keeps its fields and has no pages', () => {
  apply(sqlite, '0024_recipe_source_pages');
  expect(all('select id, name, photo_path, source_pages from recipes')).toEqual([
    { id: 'r1', name: 'Tacos', photo_path: null, source_pages: null },
  ]);
});

test('the column is nullable text: it takes the pages as JSON, and a null again', () => {
  apply(sqlite, '0024_recipe_source_pages');
  const column = (all('pragma table_info(recipes)') as { name: string; type: string; notnull: number; dflt_value: unknown }[]).find(
    (c) => c.name === 'source_pages',
  );
  expect({ ...column, type: column?.type.toLowerCase() }).toMatchObject({ type: 'text', notnull: 0, dflt_value: null });

  sqlite.exec(`insert into recipes (id, household_id, name, source_pages, created_at, updated_at) values ('r2', 'h1', 'Pho', '${PAGES}', 0, 0);`);
  expect(all("select source_pages from recipes where id = 'r2'")).toEqual([{ source_pages: PAGES }]);
  sqlite.exec("update recipes set source_pages = null where id = 'r2'");
  expect(all("select source_pages from recipes where id = 'r2'")).toEqual([{ source_pages: null }]);
});
