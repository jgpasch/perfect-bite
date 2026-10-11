// What push and pull are doing right now, for the sync status (spec 7.5). Kept apart from
// `status.ts` so push and pull can report here without importing what reads them.

/** What push and pull report while they run, and the last connectivity the OS gave them. */
export type SyncActivity = {
  pushing: boolean;
  pulling: boolean;
  /** Null until the OS reports connectivity. */
  online: boolean | null;
};

const IDLE: SyncActivity = { pushing: false, pulling: false, online: null };
let activity: SyncActivity = IDLE;
const listeners = new Set<() => void>();

/** The same object until something changes, as `useSyncExternalStore` needs. */
export function getSyncActivity(): SyncActivity {
  return activity;
}

/** Called by push and pull. Listeners only hear about real changes. */
export function reportSyncActivity(patch: Partial<SyncActivity>): void {
  const next = { ...activity, ...patch };
  if (next.pushing === activity.pushing && next.pulling === activity.pulling && next.online === activity.online) return;
  activity = next;
  for (const listener of [...listeners]) listener();
}

/** For `useSyncExternalStore`; returns an unsubscribe. */
export function subscribeSyncActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only. */
export function resetSyncActivity(): void {
  activity = IDLE;
}
