// POST /functions/v1/import-recipe — body: RecipeImportRequest (spec 6.6).
// 200 RecipeImportResponse · 400 invalid_url/invalid_request · 401 no/invalid user (from
// withSupabase) · 405 · 413 · 422 not_a_recipe · 429 rate_limited · 502 fetch_failed
// · 503 unavailable (with Retry-After) · 500.
import { withSupabase } from '@supabase/server';

import { fetchPage } from '../_shared/fetch-page.ts';
import { categorize } from '../categorize-ingredients/handler.ts';
import { dailyNameCap } from '../categorize-ingredients/request.ts';
import { createCategorizeStore } from '../categorize-ingredients/store.ts';
import { importRecipe } from './handler.ts';
import { dailyImportCap, handleRequest } from './request.ts';
import { createRecipeImportStore } from './store.ts';

export default {
  fetch: withSupabase({ auth: 'user' }, (req, ctx) => {
    const userId = ctx.userClaims!.id;
    const store = createRecipeImportStore(ctx.supabaseAdmin, {
      userId,
      dailyCap: dailyImportCap(Deno.env.get('RECIPE_IMPORT_DAILY_CAP')),
    });
    const categorizeStore = createCategorizeStore(ctx.supabaseAdmin, {
      userId,
      dailyNameCap: dailyNameCap(Deno.env.get('CATEGORIZE_DAILY_NAME_CAP')),
    });
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
