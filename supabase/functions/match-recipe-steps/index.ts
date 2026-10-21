// POST /functions/v1/match-recipe-steps — body: MatchRecipeStepsRequest (spec 6.8).
// 200 MatchRecipeStepsResponse · 400 invalid_request · 401 no/invalid user (from withSupabase) ·
// 405 · 413 · 429 rate_limited (per minute) or daily_limit (the day's matches, with resets_at, the
// next UTC midnight) · 503 unavailable (with Retry-After) · 500. Step ingredients aren't a plan
// feature (spec 4.12): there's no plan check and no monthly limit, only the safety limits.
import { withSupabase } from '@supabase/server';

import { matchSteps } from './handler.ts';
import { handleRequest } from './request.ts';
import { createStepMatchStore } from './store.ts';

export default {
  fetch: withSupabase({ auth: 'user' }, (req, ctx) => {
    const userId = ctx.userClaims!.id;
    const store = createStepMatchStore(ctx.supabaseAdmin, { userId });
    return handleRequest(req, { matchSteps: (request) => matchSteps(request, { store, caller: { userId, householdId: null } }) });
  }),
};
