import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { addDatabaseChangeListener } from 'expo-sqlite';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { deviceSettings, outbox } from '@/db';
import { useAccountState } from '@/features/auth/account';
import { isSupabaseConfigured } from '@/lib/supabase';
import { getSyncActivity, subscribeSyncActivity } from '@/sync/activity';
import { readSyncInputs, syncStatus, type SyncStatus } from '@/sync/status';

/** The outbox and the push/pull states (device settings) feed the status. */
const WATCHED = new Set([getTableConfig(outbox).name, getTableConfig(deviceSettings).name]);

/** The sync status (spec 7.5), kept current as the outbox, push, pull and connectivity change. */
export function useSyncStatus(): SyncStatus {
  const account = useAccountState();
  const signedIn = isSupabaseConfigured && account.status === 'ready';
  const activity = useSyncExternalStore(subscribeSyncActivity, getSyncActivity);
  const [changes, setChanges] = useState(0);

  useEffect(() => {
    const listener = addDatabaseChangeListener(({ tableName }) => {
      if (WATCHED.has(tableName)) setChanges((n) => n + 1);
    });
    return () => listener.remove();
  }, []);

  return useMemo(
    () => syncStatus({ ...readSyncInputs(signedIn), activity }),
    // `changes` re-reads the database after a write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signedIn, activity, changes],
  );
}
