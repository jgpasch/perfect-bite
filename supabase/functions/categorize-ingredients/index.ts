// POST /functions/v1/categorize-ingredients — body: { names: string[] } (spec 6.1 step 5).
// 200 { results } · 400 invalid · 401 no/invalid user (from withSupabase) · 405 · 413 · 429
// rate_limited (per minute) or daily_limit (the day's LLM-bound names, with resets_at, the next UTC
// midnight) · 500. Categorizing isn't a plan feature (spec 4.12): there's no plan check and no
// monthly limit, only the safety limits.
import { withSupabase } from '@supabase/server';

import { categorize } from './handler.ts';
import { handleRequest } from './request.ts';
import { createCategorizeStore } from './store.ts';

export default {
  fetch: withSupabase({ auth: 'user' }, (req, ctx) => {
    const userId = ctx.userClaims!.id;
    const store = createCategorizeStore(ctx.supabaseAdmin, { userId });
    return handleRequest(req, { userId, categorize: (names) => categorize(names, store, undefined, { userId, householdId: null }) });
  }),
};
