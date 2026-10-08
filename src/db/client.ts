import { drizzle } from 'drizzle-orm/expo-sqlite';
import { openDatabaseSync } from 'expo-sqlite';

import * as schema from './schema';

export const DATABASE_NAME = 'perfect-bite.db';

/** Raw expo-sqlite handle. `enableChangeListener` powers drizzle's `useLiveQuery`. */
export const expoDb = openDatabaseSync(DATABASE_NAME, { enableChangeListener: true });

// WAL for concurrent reads while writing; 5 s busy timeout.
expoDb.execSync('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');

export const db = drizzle(expoDb, { schema });
export type Db = typeof db;
