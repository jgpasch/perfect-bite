// A fast stand-in for `loadCatalogSeed()` in tests.
//
// The real seed inserts ~7,000 ingredient rows one query at a time (~1.5s). This runs it once per
// test file, keeps a copy of the result in an attached in-memory database, and restores from that
// copy on later calls, which takes milliseconds. Use it after `resetDb()`:
//
//   beforeEach(() => {
//     resetDb();
//     seedCatalog();
//   });
//
// Tests that are about the seed itself should keep calling `loadCatalogSeed()`.
import { getTableName } from 'drizzle-orm';

import * as schema from '@/db/schema';
import { sqlite } from '@/test/db';

// Parents before children, for foreign keys.
const SEEDED = [schema.categories, schema.ingredients].map((t) => getTableName(t));
const SETTINGS = getTableName(schema.deviceSettings);

let saved = false;

/** Loads the catalog seed, from a saved copy after the first call in a test file. */
export function seedCatalog() {
  // Imported here, not at the top: categories imports `@/db`, which is mocked by `@/test/db`.
  const { loadCatalogSeed, SEED_KEY } = require('@/features/categories/categories');

  // The copy only matches the real seed when the catalog starts empty; otherwise seed for real.
  const empty = SEEDED.every((t) => !sqlite.prepare(`SELECT 1 FROM "${t}" LIMIT 1`).get());
  if (!saved || !empty) {
    loadCatalogSeed();
    if (!saved && empty) save(SEED_KEY);
    return;
  }

  sqlite.transaction(() => {
    for (const t of SEEDED) sqlite.exec(`INSERT INTO main."${t}" SELECT * FROM template."${t}"`);
    sqlite.exec(`INSERT OR REPLACE INTO main."${SETTINGS}" SELECT * FROM template."${SETTINGS}"`);
  })();
}

function save(seedKey: string) {
  sqlite.exec(`ATTACH DATABASE ':memory:' AS template`);
  for (const t of SEEDED) sqlite.exec(`CREATE TABLE template."${t}" AS SELECT * FROM main."${t}"`);
  // Only the "seed loaded" marker, not any other device settings the test wrote.
  sqlite
    .prepare(`CREATE TABLE template."${SETTINGS}" AS SELECT * FROM main."${SETTINGS}" WHERE key = ?`)
    .run(seedKey);
  saved = true;
}
