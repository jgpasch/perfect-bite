// POST /functions/v1/generate-recipe-photo — body: GenerateRecipePhotoRequest (spec 6.11).
// 200 GenerateRecipePhotoResponse · 400 invalid_request · 401 no/invalid user (from withSupabase) ·
// 403 not_entitled (the caller's plan has no `recipe_photo_ai`, spec 4.12) · 404 not_found · 405 ·
// 409 already_generated · 413 · 422 not_food · 502 generation_failed · 503 unavailable (with
// Retry-After) · 500.
import { withSupabase } from '@supabase/server';

import { generateRecipePhoto } from './handler.ts';
import { handleRequest } from './request.ts';
import { createRecipePhotoStore } from './store.ts';

export default {
  fetch: withSupabase({ auth: 'user' }, (req, ctx) => {
    const store = createRecipePhotoStore(ctx.supabaseAdmin, { userId: ctx.userClaims!.id });
    return handleRequest(req, { generateRecipePhoto: (request) => generateRecipePhoto(request, { store }) });
  }),
};
