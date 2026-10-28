// POST /functions/v1/share-ingest (spec 6.12) — body: ShareEnvelope, `Authorization: Bearer` with a
// device credential (scope `share.ingest`) or a user session, `Idempotency-Key: <envelope id>`.
// 202 { id, status } · 400 · 401 · 403 account_mismatch / not_a_member · 405 · 409
// operation_conflict · 413 · 429 rate_limited · 500 · 503 unavailable (SHARE_IMPORT=off).
//
// The gateway's JWT check is off for this function (config.toml), since a device credential isn't a
// JWT: withSupabase({ auth: 'none' }) gives the service-role client, and authenticate() verifies
// either kind itself. A session JWT has dots; a credential is 43 characters of base64url.
import { createSupabaseContext, withSupabase } from '@supabase/server';

import { verifyDeviceCredential } from '../_shared/device-credentials.ts';
import { createShareIngestStore, SHARE_IMAGES_BUCKET, type ShareIngestAuth } from './handler.ts';
import { handleRequest, type ShareImageStorage } from './request.ts';

type EdgeRuntime = { waitUntil(promise: Promise<unknown>): void };

/** The project's secret key, as @supabase/server reads it. */
function secretKey(): string | undefined {
  const plural = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (plural) {
    try {
      const keys = JSON.parse(plural) as Record<string, string>;
      if (typeof keys.default === 'string') return keys.default;
    } catch {
      // Fall back to the singular form.
    }
  }
  return Deno.env.get('SUPABASE_SECRET_KEY') || undefined;
}

/** Calls share-import-worker in the background, as cron does; a failure only waits for cron. */
function startWorker(): void {
  const url = Deno.env.get('SUPABASE_URL');
  const key = secretKey();
  const runtime = (globalThis as { EdgeRuntime?: EdgeRuntime }).EdgeRuntime;
  if (!url || !key || !runtime) return;
  const run = fetch(`${url.replace(/\/+$/, '')}/functions/v1/share-import-worker`, {
    method: 'POST',
    headers: { apikey: key, 'content-type': 'application/json' },
    body: '{}',
  })
    .then((res) => res.body?.cancel())
    .catch((err) => console.warn('share-ingest: starting the worker failed:', err instanceof Error ? err.message : String(err)));
  runtime.waitUntil(run);
}

export default {
  fetch: withSupabase({ auth: 'none' }, (req, ctx) => {
    const authenticate = async (token: string): Promise<ShareIngestAuth | null> => {
      if (token.includes('.')) {
        const { data, error } = await createSupabaseContext(req, { auth: 'user' });
        if (error || !data.userClaims) return null;
        return { userId: data.userClaims.id, credentialId: null };
      }
      return verifyDeviceCredential(ctx.supabaseAdmin, token, 'share.ingest');
    };
    const bucket = ctx.supabaseAdmin.storage.from(SHARE_IMAGES_BUCKET);
    const images: ShareImageStorage = {
      async upload(path, bytes) {
        const { error } = await bucket.upload(path, bytes, { contentType: 'image/jpeg', upsert: true });
        if (error) throw new Error(`share-images upload failed: ${error.message}`);
      },
      async remove(paths) {
        const { error } = await bucket.remove(paths);
        if (error) throw new Error(`share-images remove failed: ${error.message}`);
      },
    };
    return handleRequest(req, { authenticate, store: createShareIngestStore(ctx.supabaseAdmin), images, startWorker });
  }),
};
