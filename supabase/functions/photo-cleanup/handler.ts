// Removing recipe and item photos nothing points at any more (spec 4.4, 4.5, 5). The database
// queues them, one queue per bucket (20261029120000_recipe_photo_storage.sql,
// 20261106120000_item_photos.sql); this removes them through the Storage API, which is the only way
// to delete the files, then marks the queue entries done.

/** One bucket's queue and the bucket, over the service-role client in index.ts and fakes in tests. */
export type CleanupStore = {
  /** Due queue entries with the object names each stands for (a household prefix: several). */
  claim(limit: number): Promise<{ queue_id: number; name: string }[]>;
  /** Removes objects from the bucket. Names that are already gone are fine. */
  remove(names: string[]): Promise<void>;
  /** Drops the queue entries whose objects are removed. */
  complete(ids: number[]): Promise<void>;
};

/** Queue entries per run; the next run (cron, every 15 minutes) takes the rest. */
export const CLAIM_LIMIT = 100;

/** Storage removes at most 1,000 objects per request. */
export const REMOVE_BATCH = 1000;

export type CleanupResult = { removed: number; completed: number };

/**
 * One sweep: claims what's due, removes its objects in batches, and completes the entries only when
 * every batch succeeded. A failure throws and leaves the entries queued; removing again is harmless.
 */
export async function cleanUpPhotos(store: CleanupStore, limit = CLAIM_LIMIT): Promise<CleanupResult> {
  const rows = await store.claim(limit);
  const names = [...new Set(rows.map((r) => r.name))];
  for (let i = 0; i < names.length; i += REMOVE_BATCH) {
    await store.remove(names.slice(i, i + REMOVE_BATCH));
  }
  const ids = [...new Set(rows.map((r) => r.queue_id))];
  if (ids.length > 0) await store.complete(ids);
  return { removed: names.length, completed: ids.length };
}

/**
 * Sweeps every bucket (recipe-photos, item-photos) and adds up the counts. A failing bucket doesn't
 * stop the others; the first failure is thrown once they've all run.
 */
export async function cleanUpBuckets(stores: CleanupStore[], limit = CLAIM_LIMIT): Promise<CleanupResult> {
  const total: CleanupResult = { removed: 0, completed: 0 };
  const failures: unknown[] = [];
  for (const store of stores) {
    try {
      const result = await cleanUpPhotos(store, limit);
      total.removed += result.removed;
      total.completed += result.completed;
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) throw failures[0];
  return total;
}

/** POST → 200 CleanupResult · 405 · 500. Logs no object names. */
export async function handleRequest(req: Request, sweep: () => Promise<CleanupResult>): Promise<Response> {
  if (req.method !== 'POST') return Response.json({ error: 'method_not_allowed', message: 'Use POST' }, { status: 405 });
  try {
    return Response.json(await sweep());
  } catch (err) {
    console.error('photo-cleanup failed:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'internal', message: 'Cleanup failed' }, { status: 500 });
  }
}
