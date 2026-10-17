// POST /functions/v1/send-notifications (spec 4.13, 8.5), from cron every minute through pg_net
// (private.request_send_notifications) with a secret API key as apikey; 401 without one (from
// withSupabase). 200 RunResult · 405 · 500.
import { withSupabase } from '@supabase/server';

import { createExpoClient } from './expo.ts';
import { handleRequest, runWorker } from './handler.ts';
import { createNotificationStore } from './store.ts';

export default {
  fetch: withSupabase({ auth: 'secret' }, (req, ctx) => {
    const store = createNotificationStore(ctx.supabaseAdmin);
    const expo = createExpoClient({ accessToken: Deno.env.get('EXPO_ACCESS_TOKEN') || undefined });
    return handleRequest(req, () => runWorker({ store, expo }));
  }),
};
