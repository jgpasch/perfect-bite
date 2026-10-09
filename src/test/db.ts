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

// Children before parents, for foreign keys.
const TABLES = [
  schema.deviceSettings,
  schema.userSettings,
  schema.userCategoryOverrides,
  schema.userCategoryOrder,
  schema.ingredientUsage,
  schema.listItemContributions,
  schema.listItems,
  schema.recipeIngredients,
  schema.recipes,
  schema.lists,
  schema.households,
  schema.ingredients,
  schema.categories,
];

/** Empties every table. Call in `beforeEach`. */
export function resetDb() {
  for (const table of TABLES) db.delete(table).run();
}
