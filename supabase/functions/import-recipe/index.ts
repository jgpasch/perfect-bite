// POST /functions/v1/import-recipe — body: RecipeImportRequest (spec 6.6).
// 200 RecipeImportResponse · 400 invalid_url/invalid_request · 401 no/invalid user (from
// withSupabase) · 403 not_entitled (the caller's plan has no `recipe_import`, spec 4.12) · 405
// · 413 · 422 not_a_recipe · 429 rate_limited (per minute) or limit_reached (the plan's monthly
// imports, with resets_at) · 502 fetch_failed · 503 unavailable (with
// Retry-After) · 500.
import { withSupabase } from '@supabase/server';

import { fetchPage } from '../_shared/fetch-page.ts';
import { categorize } from '../categorize-ingredients/handler.ts';
import { createCategorizeStore } from '../categorize-ingredients/store.ts';
import { importRecipe } from './handler.ts';
import { handleRequest } from './request.ts';
import { createRecipeImportStore } from './store.ts';

export default {
  fetch: withSupabase({ auth: 'user' }, (req, ctx) => {
    const userId = ctx.userClaims!.id;
    const store = createRecipeImportStore(ctx.supabaseAdmin, { userId });
    // `recipe_import` implies `categorize` (spec 4.12), and importRecipe checks it first, so the
    // inline categorize doesn't check its own feature again.
    const categorizeStore = {
      ...createCategorizeStore(ctx.supabaseAdmin, { userId }),
      requireFeature: () => Promise.resolve(),
    };
    return handleRequest(req, {
      importRecipe: (request) =>
        importRecipe(request, {
          store,
          categorize: (names) => categorize(names, categorizeStore),
          fetchPage: (url) => fetchPage(url),
        }),
    });
  }),
};
