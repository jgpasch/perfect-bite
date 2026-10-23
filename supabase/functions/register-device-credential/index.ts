// POST /functions/v1/register-device-credential — body { installationId } (spec 6.12).
// 200 { token, expiresAt } · 400 invalid_request · 401 no/invalid user (from withSupabase) · 405 ·
// 413 · 500. The token is returned only here, once; the database keeps its sha256.
import { withSupabase } from '@supabase/server';

import { createRegisterStore, registerDeviceCredential } from './handler.ts';
import { handleRequest } from './request.ts';

export default {
  fetch: withSupabase({ auth: 'user' }, (req, ctx) => {
    const store = createRegisterStore(ctx.supabaseAdmin, ctx.userClaims!.id);
    return handleRequest(req, { register: (request) => registerDeviceCredential(request, { store }) });
  }),
};
