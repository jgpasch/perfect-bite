// POST /functions/v1/import-recipe-photo — body: RecipePhotoImportRequest (spec 6.10).
// 200 RecipeImportResponse · 400 invalid_request · 401 no/invalid user (from withSupabase) · 403
// not_entitled (the household's plan has no `recipe_import`, spec 4.12) · 405 · 413 · 422
// not_a_recipe · 429 rate_limited (per minute) or limit_reached (the plan's monthly photo imports,
// with resets_at) · 503 unavailable (with Retry-After) · 500.
import { withSupabase } from '@supabase/server';

import { categorize } from '../categorize-ingredients/handler.ts';
import { createCategorizeStore } from '../categorize-ingredients/store.ts';
import { importRecipePhoto } from './handler.ts';
import { handleRequest } from './request.ts';
import { createRecipePhotoImportStore } from './store.ts';

export default {
  fetch: withSupabase({ auth: 'user' }, (req, ctx) => {
    const userId = ctx.userClaims!.id;
    const caller = { userId, householdId: null };
    const store = createRecipePhotoImportStore(ctx.supabaseAdmin, { userId });
    const categorizeStore = createCategorizeStore(ctx.supabaseAdmin, { userId });
    return handleRequest(req, {
      importRecipePhoto: (request) =>
        importRecipePhoto(request, {
          store,
          categorize: (names) => categorize(names, categorizeStore, undefined, caller),
          caller,
        }),
    });
  }),
};
