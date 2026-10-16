// POST /functions/v1/match-recipe-steps — body: MatchRecipeStepsRequest (spec 6.8).
// 200 MatchRecipeStepsResponse · 400 invalid_request · 401 no/invalid user (from withSupabase) ·
// 403 not_entitled (the caller's plan has no `step_ingredients`, spec 4.12) · 405 · 413 · 429
// rate_limited · 503 unavailable (with Retry-After) · 500.
import { withSupabase } from '@supabase/server';

import { matchSteps } from './handler.ts';
import { dailyStepMatchCap, handleRequest } from './request.ts';
import { createStepMatchStore } from './store.ts';

export default {
  fetch: withSupabase({ auth: 'user' }, (req, ctx) => {
    const store = createStepMatchStore(ctx.supabaseAdmin, {
      userId: ctx.userClaims!.id,
      dailyCap: dailyStepMatchCap(Deno.env.get('STEP_MATCH_DAILY_CAP')),
    });
    return handleRequest(req, { matchSteps: (request) => matchSteps(request, { store }) });
  }),
};
