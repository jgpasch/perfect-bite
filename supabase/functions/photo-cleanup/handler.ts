// Removing recipe photos, item photos and recipe pages nothing points at any more (spec 4.4, 4.5,
// 4.10, 5). The database queues them, one queue per bucket (20261029120000_recipe_photo_storage.sql,
// 20261106120000_item_photos.sql, 20261107120000_recipe_pages.sql); this removes them through the
// Storage API, which is the only way to delete the files, then marks the queue entries done.

/** One bucket's queue and the bucket, over the service-role client in index.ts and fakes in tests. */
export type CleanupStore = {
  /** Due queue entries with the object names each stands for (a household prefix: several). */
  claim(limit: number): Promise<{ queue_id: number; name: string }[]>;
  /** Removes objects from the bucket. Names that are already gone are fine. */
  remove(names: string[]): Promise<void>;
  /** Drops the queue entries whose objects are removed. */
  complete(ids: number[]): Promise<void>;
};

/** Each bucket and the RPCs over its queue, swept in this order. */
export const CLEANUP_BUCKETS = [
  { bucket: 'recipe-photos', claim: 'claim_recipe_photo_deletions', complete: 'complete_recipe_photo_deletions' },
  { bucket: 'item-photos', claim: 'claim_item_photo_deletions', complete: 'complete_item_photo_deletions' },
  { bucket: 'recipe-pages', claim: 'claim_recipe_page_deletions', complete: 'complete_recipe_page_deletions' },
] as const;

/** The parts of the service-role client a sweep uses. */
export type CleanupClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
  storage: { from(bucket: string): { remove(names: string[]): PromiseLike<{ error: unknown }> } };
};

/** One store per bucket in CLEANUP_BUCKETS, over the client. */
export function bucketStores(admin: CleanupClient): CleanupStore[] {
  return CLEANUP_BUCKETS.map((b) => ({
    async claim(limit) {
      const { data, error } = await admin.rpc(b.claim, { p_limit: limit });
      if (error) throw error;
      return (data ?? []) as { queue_id: number; name: string }[];
    },
    async remove(names) {
      const { error } = await admin.storage.from(b.bucket).remove(names);
      if (error) throw error;
    },
    async complete(ids) {
      const { error } = await admin.rpc(b.complete, { p_ids: ids });
      if (error) throw error;
    },
  }));
}

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
 * Sweeps every bucket (recipe-photos, item-photos, recipe-pages) and adds up the counts. A failing bucket doesn't
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
