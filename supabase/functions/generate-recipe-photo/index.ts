// POST /functions/v1/generate-recipe-photo — body: GenerateRecipePhotoRequest (spec 6.11).
// 200 GenerateRecipePhotoResponse · 400 invalid_request · 401 no/invalid user (from withSupabase) ·
// 403 not_entitled (the recipe's household's plan has no `recipe_photo_ai`, or the caller isn't in
// it, spec 4.12) · 403 ai_photos_blocked
// (the caller's AI photos are blocked after repeated refusals, spec 6.11) · 404 not_found · 405 ·
// 409 already_generated · 413 · 422 not_food · 429 rate_limited (per minute), daily_limit (the day's
// AI photos, with resets_at, the next UTC midnight) or limit_reached (the plan's monthly AI photos,
// with resets_at) · 502 generation_failed · 503 unavailable (with Retry-After) · 500.
import { withSupabase } from '@supabase/server';

import { generateRecipePhoto } from './handler.ts';
import { handleRequest } from './request.ts';
import { createRecipePhotoStore } from './store.ts';

export default {
  fetch: withSupabase({ auth: 'user' }, (req, ctx) => {
    const userId = ctx.userClaims!.id;
    const store = createRecipePhotoStore(ctx.supabaseAdmin, { userId });
    return handleRequest(req, { generateRecipePhoto: (request) => generateRecipePhoto(request, { store, userId }) });
  }),
};
