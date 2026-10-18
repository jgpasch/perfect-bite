// POST /functions/v1/photo-cleanup (spec 4.4, 4.5, 4.10, 5), from cron through pg_net
// (private.request_recipe_photo_cleanup) with a secret API key as apikey; 401 without one (from
// withSupabase). Sweeps recipe-photos, item-photos, then recipe-pages (CLEANUP_BUCKETS).
// 200 { removed, completed } · 405 · 500.
import { withSupabase } from '@supabase/server';

import { bucketStores, cleanUpBuckets, handleRequest } from './handler.ts';

export default {
  fetch: withSupabase({ auth: 'secret' }, (req, ctx) =>
    handleRequest(req, () => cleanUpBuckets(bucketStores(ctx.supabaseAdmin))),
  ),
};
