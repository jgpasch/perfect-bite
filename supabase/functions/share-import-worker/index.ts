// POST /functions/v1/share-import-worker (spec 6.12), from cron every minute through pg_net
// (private.request_share_import_worker) and from share-ingest's waitUntil, with a secret API key as
// apikey; 401 without one (from withSupabase). 200 RunResult · 405 · 500.
import { withSupabase } from '@supabase/server';

import { fetchPage } from '../_shared/fetch-page.ts';
import { categorize } from '../categorize-ingredients/handler.ts';
import { createCategorizeStore } from '../categorize-ingredients/store.ts';
import { createRecipeImportStore } from '../import-recipe/store.ts';
import { handleRequest, runWorker } from './handler.ts';
import { createShareImportWorkerStore } from './store.ts';

export default {
  fetch: withSupabase({ auth: 'secret' }, (req, ctx) => {
    const admin = ctx.supabaseAdmin;
    return handleRequest(req, () =>
      runWorker({
        store: createShareImportWorkerStore(admin),
        // Everything a job does is the sharer's: the plan check, the limits and the ai_calls rows.
        importDeps: (job) => {
          const categorizeStore = createCategorizeStore(admin, { userId: job.user_id });
          return {
            store: createRecipeImportStore(admin, { userId: job.user_id }),
            categorize: (names, caller) => categorize(names, categorizeStore, undefined, caller),
            fetchPage: (url) => fetchPage(url),
            caller: { userId: job.user_id, householdId: null },
          };
        },
      }),
    );
  }),
};
