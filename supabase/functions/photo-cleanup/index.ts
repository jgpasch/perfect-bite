// POST /functions/v1/photo-cleanup (spec 4.4, 4.5, 5), from cron through pg_net
// (private.request_recipe_photo_cleanup) with a secret API key as apikey; 401 without one (from
// withSupabase). Sweeps recipe-photos, then item-photos. 200 { removed, completed } · 405 · 500.
import { withSupabase } from '@supabase/server';

import { cleanUpBuckets, handleRequest, type CleanupStore } from './handler.ts';

/** Each bucket and the RPCs over its queue. */
const BUCKETS = [
  { bucket: 'recipe-photos', claim: 'claim_recipe_photo_deletions', complete: 'complete_recipe_photo_deletions' },
  { bucket: 'item-photos', claim: 'claim_item_photo_deletions', complete: 'complete_item_photo_deletions' },
] as const;

export default {
  fetch: withSupabase({ auth: 'secret' }, (req, ctx) => {
    const admin = ctx.supabaseAdmin;
    const stores = BUCKETS.map(
      (b): CleanupStore => ({
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
      }),
    );
    return handleRequest(req, () => cleanUpBuckets(stores));
  }),
};
