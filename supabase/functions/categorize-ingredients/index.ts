// POST /functions/v1/categorize-ingredients — body: { names: string[] } (spec 6.1 step 5).
// 200 { results } · 400 invalid · 401 no/invalid user (from withSupabase) · 405 · 413 · 500.
import { withSupabase } from '@supabase/server';

import { categorize } from './handler.ts';
import { handleRequest } from './request.ts';
import { createCategorizeStore } from './store.ts';

export default {
  fetch: withSupabase({ auth: 'user' }, (req, ctx) =>
    handleRequest(req, {
      userId: ctx.userClaims!.id,
      categorize: (names) => categorize(names, createCategorizeStore(ctx.supabaseAdmin)),
    })),
};
