// HTTP layer for share-ingest, kept free of `@supabase/server` so Deno tests can call it. index.ts
// supplies how a bearer token is authenticated (a device credential or a user session), the store
// and how the worker is started.
import { ShareEnvelopeSchema, type ShareEnvelope } from '@shared/index.ts';

import { reportError } from '../_shared/sentry.ts';
import { readBody } from '../categorize-ingredients/request.ts';
import { type ShareImportStatus, type ShareIngestAuth, type ShareIngestStore, shareIngestRow } from './handler.ts';

/** The aggregate body cap: 10 JSON-LD blocks of 200 KB, 50 KB of text, and overhead (spec 6.12). */
export const MAX_BODY_BYTES = 2.5 * 1024 * 1024;

/** Seconds a client should wait with the kill switch on. */
export const PAUSED_RETRY_AFTER = 3600;

export type RequestDeps = {
  /** The user of a bearer token, or null when it is neither a valid credential nor a session. */
  authenticate: (token: string) => Promise<ShareIngestAuth | null>;
  store: ShareIngestStore;
  /** Starts share-import-worker in the background, best effort; the cron job is what guarantees progress. */
  startWorker?: () => void;
  /** Reads an env var. Defaults to `Deno.env.get`. */
  env?: (key: string) => string | undefined;
};

export type ShareIngestResponse = { id: string; status: ShareImportStatus };

const error = (status: number, code: string, message: string, retryAfter?: number) => {
  const res = Response.json({ error: code, message }, { status });
  if (retryAfter !== undefined) res.headers.set('Retry-After', String(retryAfter));
  return res;
};

function bearer(req: Request): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('authorization') ?? '');
  return match ? match[1] : null;
}

function parseEnvelope(bytes: Uint8Array): ShareEnvelope | Response {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return error(400, 'invalid_request', 'Body is not valid JSON');
  }
  const parsed = ShareEnvelopeSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  if (issue.path.length === 1 && issue.path[0] === 'url') return error(400, 'invalid_url', 'url must be an http(s) URL');
  return error(400, 'invalid_request', `${issue.path.join('.') || 'body'}: ${issue.message}`);
}

/**
 * POST ShareEnvelope with `Authorization: Bearer` and `Idempotency-Key: <envelope id>` →
 * 202 { id, status } · 400 invalid_request / invalid_url · 401 unauthorized · 403 account_mismatch /
 * not_a_member · 405 · 409 operation_conflict · 413 · 429 rate_limited · 500 · 503 unavailable
 * (`SHARE_IMPORT=off`, with Retry-After). Logs sizes and counts, never the page or the token.
 */
export async function handleRequest(req: Request, deps: RequestDeps): Promise<Response> {
  if (req.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST');

  const env = deps.env ?? ((key: string) => Deno.env.get(key));
  if (env('SHARE_IMPORT')?.trim().toLowerCase() === 'off') {
    return error(503, 'unavailable', 'Share import is paused', PAUSED_RETRY_AFTER);
  }

  const token = bearer(req);
  if (token === null) return error(401, 'unauthorized', 'Authorization: Bearer is required');

  try {
    const auth = await deps.authenticate(token);
    if (auth === null) return error(401, 'unauthorized', 'Invalid or expired credentials');

    const declared = Number(req.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return error(413, 'payload_too_large', `Body over ${MAX_BODY_BYTES} bytes`);
    }
    const bytes = await readBody(req, MAX_BODY_BYTES);
    if (!bytes) return error(413, 'payload_too_large', `Body over ${MAX_BODY_BYTES} bytes`);

    const envelope = parseEnvelope(bytes);
    if (envelope instanceof Response) return envelope;

    const key = req.headers.get('idempotency-key')?.trim().toLowerCase();
    if (key !== envelope.id.toLowerCase()) {
      return error(400, 'invalid_request', 'Idempotency-Key must be the envelope id');
    }
    if (envelope.userId !== undefined && envelope.userId.toLowerCase() !== auth.userId.toLowerCase()) {
      return error(403, 'account_mismatch', 'The share belongs to another account');
    }

    if (auth.credentialId !== null && (await deps.store.checkLimit(auth.credentialId)) !== 'ok') {
      return error(429, 'rate_limited', 'Too many shares from this device; try again in a minute');
    }

    const row = await shareIngestRow(envelope, auth);
    const result = await deps.store.ingest(row);
    switch (result.outcome) {
      case 'conflict':
        return error(409, 'operation_conflict', 'This id is already another share');
      case 'not_a_member':
        return error(403, 'not_a_member', 'Not a member of this household');
      case 'invalid_list':
        return error(400, 'invalid_request', 'listId is not a list of this household');
    }

    console.log(JSON.stringify({
      level: 'info',
      event: 'share_ingested',
      status: result.status,
      via: auth.credentialId === null ? 'session' : 'credential',
      bytes: bytes.byteLength,
      jsonLd: envelope.page?.jsonLd?.length ?? 0,
      textBytes: envelope.page?.text === undefined ? 0 : new TextEncoder().encode(envelope.page.text).byteLength,
    }));
    if (result.status !== 'done' && result.status !== 'failed') {
      try {
        deps.startWorker?.();
      } catch (err) {
        console.warn('share-ingest: starting the worker failed:', err instanceof Error ? err.message : String(err));
      }
    }
    const body: ShareIngestResponse = { id: row.id, status: result.status };
    return Response.json(body, { status: 202, headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error('share-ingest failed:', err instanceof Error ? err.message : String(err));
    reportError('share-ingest', err);
    return error(500, 'internal_error', 'Recording the share failed');
  }
}
