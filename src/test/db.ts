// In-memory SQLite with the app's real schema and migrations, for tests that touch data.
//
// In a test file:
//   jest.mock('@/db/client', () => require('@/test/db'));
//   beforeEach(() => resetDb());
//
// Each test file gets its own module registry, so its own fresh database.
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from '@/db/schema';

export const sqlite = new Database(':memory:');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

migrate(db, { migrationsFolder: path.join(__dirname, '../db/migrations') });

const TABLES = [schema.deviceSettings];

/** Empties every table. Call in `beforeEach`. */
export function resetDb() {
  for (const table of TABLES) db.delete(table).run();
}
