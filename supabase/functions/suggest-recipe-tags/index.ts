// POST /functions/v1/suggest-recipe-tags — body: SuggestRecipeTagsRequest (spec 6.7).
// 200 SuggestRecipeTagsResponse · 400 invalid_request · 401 no/invalid user (from withSupabase) ·
// 403 not_entitled (the caller's plan has no `recipe_tags`, spec 4.12) · 405 · 413 · 429
// rate_limited (per minute) or limit_reached (the plan's monthly suggestions, with resets_at) · 503 unavailable (with Retry-After) · 500.
import { withSupabase } from '@supabase/server';

import { suggestRecipeTags } from './handler.ts';
import { handleRequest } from './request.ts';
import { createSuggestTagsStore } from './store.ts';

export default {
  fetch: withSupabase({ auth: 'user' }, (req, ctx) => {
    const store = createSuggestTagsStore(ctx.supabaseAdmin, { userId: ctx.userClaims!.id });
    return handleRequest(req, { suggestRecipeTags: (request) => suggestRecipeTags(request, { store }) });
  }),
};
