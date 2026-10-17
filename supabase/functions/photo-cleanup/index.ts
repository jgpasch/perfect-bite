// POST /functions/v1/photo-cleanup (spec 4.5, 5), from cron through pg_net
// (private.request_recipe_photo_cleanup) with a secret API key as apikey; 401 without one (from
// withSupabase). 200 { removed, completed } · 405 · 500.
import { withSupabase } from '@supabase/server';

import { cleanUpPhotos, handleRequest, type CleanupStore } from './handler.ts';

export default {
  fetch: withSupabase({ auth: 'secret' }, (req, ctx) => {
    const admin = ctx.supabaseAdmin;
    const store: CleanupStore = {
      async claim(limit) {
        const { data, error } = await admin.rpc('claim_recipe_photo_deletions', { p_limit: limit });
        if (error) throw error;
        return (data ?? []) as { queue_id: number; name: string }[];
      },
      async remove(names) {
        const { error } = await admin.storage.from('recipe-photos').remove(names);
        if (error) throw error;
      },
      async complete(ids) {
        const { error } = await admin.rpc('complete_recipe_photo_deletions', { p_ids: ids });
        if (error) throw error;
      },
    };
    return handleRequest(req, () => cleanUpPhotos(store));
  }),
};
