// POST /functions/v1/photo-search — body: PhotoSearchRequest (spec 6.11).
// 200 PhotoSearchResponse · 400 invalid_request · 401 no/invalid user (from withSupabase) · 405 ·
// 413 · 429 rate_limited · 502 search_failed · 503 unavailable (with Retry-After) · 500.
import { withSupabase } from '@supabase/server';

import { photoSearch } from './handler.ts';
import { photoProviderFromEnv } from './providers/index.ts';
import { dailyPhotoSearchCap, handleRequest } from './request.ts';
import { createPhotoSearchStore } from './store.ts';

export default {
  fetch: withSupabase({ auth: 'user' }, (req, ctx) => {
    const store = createPhotoSearchStore(ctx.supabaseAdmin, {
      userId: ctx.userClaims!.id,
      dailyCap: dailyPhotoSearchCap(Deno.env.get('PHOTO_SEARCH_DAILY_CAP')),
    });
    const provider = photoProviderFromEnv((name) => Deno.env.get(name));
    return handleRequest(req, { photoSearch: (request) => photoSearch(request, { store, provider }) });
  }),
};
