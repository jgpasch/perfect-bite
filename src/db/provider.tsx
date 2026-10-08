import { useMigrations } from 'drizzle-orm/expo-sqlite/migrator';
import type { ReactNode } from 'react';

import { db } from './client';
import migrations from './migrations/migrations';

type Props = {
  children: ReactNode;
  /** Rendered while migrations run (usually a few ms). Defaults to nothing (keep the splash screen up). */
  fallback?: ReactNode;
};

/**
 * Runs Drizzle migrations at startup and renders children only once the schema is current.
 * A migration error is thrown, so the nearest Expo Router ErrorBoundary shows it.
 */
export function DatabaseProvider({ children, fallback = null }: Props) {
  const { success, error } = useMigrations(db, migrations);

  if (error) throw new Error(`Database migration failed: ${error.message}`, { cause: error });
  if (!success) return fallback;
  return children;
}
