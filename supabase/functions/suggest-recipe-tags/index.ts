// POST /functions/v1/suggest-recipe-tags — body: SuggestRecipeTagsRequest (spec 6.7).
// 200 SuggestRecipeTagsResponse · 400 invalid_request · 401 no/invalid user (from withSupabase) ·
// 405 · 413 · 429 rate_limited (per minute) or limit_reached (the plan's monthly suggestions, with resets_at) · 503 unavailable (with Retry-After) · 500.
// Tag suggestions aren't a plan feature (spec 4.12): there's no plan check.
import { withSupabase } from '@supabase/server';

import { suggestRecipeTags } from './handler.ts';
import { handleRequest } from './request.ts';
import { createSuggestTagsStore } from './store.ts';

export default {
  fetch: withSupabase({ auth: 'user' }, (req, ctx) => {
    const userId = ctx.userClaims!.id;
    const store = createSuggestTagsStore(ctx.supabaseAdmin, { userId });
    return handleRequest(req, { suggestRecipeTags: (request) => suggestRecipeTags(request, { store, caller: { userId, householdId: null } }) });
  }),
};
