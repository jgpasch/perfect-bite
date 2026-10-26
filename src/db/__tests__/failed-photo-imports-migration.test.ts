// Migration 0031 (spec 4.10): failed_imports keeps photo imports too: `kind` (link or photo),
// `pages` (JSON text) and a nullable `url`. A device upgrading keeps its failed links, as links.
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
const all = (sql: string) => sqlite.prepare(sql).all();
type Column = { name: string; type: string; notnull: number; dflt_value: unknown };
const columns = () => all('pragma table_info(failed_imports)') as Column[];

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  for (const { tag } of journal.entries.filter((e) => e.idx < 31)) apply(sqlite, tag);

  // A device with two failed links, as the last version left them.
  sqlite.exec(`
    insert into failed_imports (id, url, title, reason, household_id, list_id, created_at)
      values ('f1', 'https://example.com/tikka', 'Tikka', 'not_a_recipe', 'h1', 'l1', 1000);
    insert into failed_imports (id, url, title, reason, household_id, list_id, created_at)
      values ('f2', 'https://example.com/pho', null, 'rate_limited', 'h2', null, 2000);
  `);
});

test('0031 is the failed photo imports migration', () => {
  expect(journal.entries.find((e) => e.idx === 31)?.tag).toBe('0031_failed_photo_imports');
});

test('before it, failed_imports has no kind or pages and the url is required', () => {
  const names = columns().map((c) => c.name);
  expect(names).not.toContain('kind');
  expect(names).not.toContain('pages');
  expect(columns().find((c) => c.name === 'url')?.notnull).toBe(1);
});

test('existing rows keep every field and become links with no pages', () => {
  apply(sqlite, '0031_failed_photo_imports');
  expect(all('select id, kind, url, title, reason, household_id, list_id, pages, created_at from failed_imports order by id')).toEqual([
    {
      id: 'f1',
      kind: 'link',
      url: 'https://example.com/tikka',
      title: 'Tikka',
      reason: 'not_a_recipe',
      household_id: 'h1',
      list_id: 'l1',
      pages: null,
      created_at: 1000,
    },
    {
      id: 'f2',
      kind: 'link',
      url: 'https://example.com/pho',
      title: null,
      reason: 'rate_limited',
      household_id: 'h2',
      list_id: null,
      pages: null,
      created_at: 2000,
    },
  ]);
});

test('kind defaults to link; a photo row takes no url and its pages as JSON', () => {
  apply(sqlite, '0031_failed_photo_imports');
  const byName = Object.fromEntries(columns().map((c) => [c.name, { ...c, type: c.type.toLowerCase() }]));
  expect(byName.kind).toMatchObject({ type: 'text', notnull: 1, dflt_value: "'link'" });
  expect(byName.url).toMatchObject({ type: 'text', notnull: 0 });
  expect(byName.pages).toMatchObject({ type: 'text', notnull: 0, dflt_value: null });

  const pages = JSON.stringify(['1.jpg', '2.jpg']);
  sqlite.exec(
    `insert into failed_imports (id, kind, title, reason, pages, created_at) values ('f3', 'photo', null, 'failed', '${pages}', 3000);`,
  );
  sqlite.exec("insert into failed_imports (id, url, title, reason, created_at) values ('f4', 'https://x.example', null, 'failed', 4000);");
  expect(all("select id, kind, url, pages from failed_imports where id in ('f3', 'f4') order by id")).toEqual([
    { id: 'f3', kind: 'photo', url: null, pages },
    { id: 'f4', kind: 'link', url: 'https://x.example', pages: null },
  ]);
});
