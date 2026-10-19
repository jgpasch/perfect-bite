// POST /functions/v1/recipe-photos — body: RecipePhotosRequest (spec 6.9).
// 200 RecipePhotosResponse · 400 invalid_url/invalid_request · 401 no/invalid user (from
// withSupabase) · 405 · 413 · 429 rate_limited · 502 fetch_failed · 500.
import { withSupabase } from '@supabase/server';

import { fetchPage } from '../_shared/fetch-page.ts';
import { recipePhotos } from './handler.ts';
import { handleRequest } from './request.ts';
import { createRecipePhotosStore } from './store.ts';

export default {
  fetch: withSupabase({ auth: 'user' }, (req, ctx) => {
    const store = createRecipePhotosStore(ctx.supabaseAdmin, { userId: ctx.userClaims!.id });
    return handleRequest(req, { recipePhotos: (request) => recipePhotos(request, { store, fetchPage: (url) => fetchPage(url) }) });
  }),
};
