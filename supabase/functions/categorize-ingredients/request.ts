// HTTP layer for categorize-ingredients, kept free of `@supabase/server` so Deno tests can call it.
// index.ts verifies the JWT first (401 comes from the library), then calls handleRequest.
import { reportError } from '../_shared/sentry.ts';
import { NotEntitledError } from '../_shared/entitlements.ts';
import { CategorizeInputError, CategorizeLimitError, MAX_NAMES, type CategorizeResponse } from './handler.ts';

/** Request body cap: 100 names of 64 characters fit with room for JSON and multi-byte text. */
export const MAX_BODY_BYTES = 16 * 1024;

/** New (LLM-bound) names a day across all users, unless CATEGORIZE_DAILY_NAME_CAP says otherwise. */
export const DEFAULT_DAILY_NAME_CAP = 20_000;

/** Seconds a client should wait after the global cap is reached. */
export const GLOBAL_CAP_RETRY_AFTER = 3600;

/** An env var as a non-negative Postgres integer; unset or invalid falls back to `fallback`. */
export function parseCap(value: string | undefined, fallback: number): number {
  if (!value?.trim() || !/^\d+$/.test(value.trim())) return fallback;
  const cap = Number(value.trim());
  return Number.isSafeInteger(cap) && cap <= 2 ** 31 - 1 ? cap : fallback;
}

/** CATEGORIZE_DAILY_NAME_CAP as a non-negative integer; unset or invalid falls back to the default. */
export function dailyNameCap(value: string | undefined): number {
  return parseCap(value, DEFAULT_DAILY_NAME_CAP);
}

export type RequestDeps = {
  /** The verified caller. index.ts binds it into the store's rate limit (spec 6.4). */
  userId: string;
  categorize: (names: string[]) => Promise<CategorizeResponse>;
  /** Reads an env var. Defaults to `Deno.env.get`. */
  env?: (key: string) => string | undefined;
};

const error = (status: number, code: string, message: string) =>
  Response.json({ error: code, message }, { status });

/** Reads at most `max` bytes of the body; null if it is longer. */
export async function readBody(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return bytes;
}

function parseNames(bytes: Uint8Array): string[] | string {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return 'Body is not valid JSON';
  }
  const names = (body as { names?: unknown } | null)?.names;
  if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) {
    return '`names` must be an array of strings';
  }
  if (names.length > MAX_NAMES) return `At most ${MAX_NAMES} names per request`;
  return names;
}

/** POST { names: string[] } → 200 CategorizeResponse · 400 · 403 · 405 · 413 · 429 · 503 · 500. Never logs headers. */
export async function handleRequest(req: Request, deps: RequestDeps): Promise<Response> {
  if (req.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST');

  const env = deps.env ?? ((key: string) => Deno.env.get(key));
  if (!env('AI_MODEL_CATEGORIZE')?.trim()) {
    console.error('categorize-ingredients: AI_MODEL_CATEGORIZE is not set');
    return error(500, 'not_configured', 'AI_MODEL_CATEGORIZE is not set');
  }

  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return error(413, 'payload_too_large', `Body over ${MAX_BODY_BYTES} bytes`);
  }
  const bytes = await readBody(req, MAX_BODY_BYTES);
  if (!bytes) return error(413, 'payload_too_large', `Body over ${MAX_BODY_BYTES} bytes`);

  const names = parseNames(bytes);
  if (typeof names === 'string') return error(400, 'invalid_request', names);

  try {
    return Response.json(await deps.categorize(names));
  } catch (err) {
    if (err instanceof NotEntitledError) return error(403, 'not_entitled', "Categorizing isn't included in your plan");
    if (err instanceof CategorizeInputError) return error(400, 'invalid_request', err.message);
    if (err instanceof CategorizeLimitError) {
      if (err.reason === 'user_limit') return error(429, 'rate_limited', 'Too many requests; try again later');
      const res = error(503, 'daily_cap_reached', 'Categorization is paused for now; try again later');
      res.headers.set('Retry-After', String(GLOBAL_CAP_RETRY_AFTER));
      return res;
    }
    console.error('categorize-ingredients failed:', err instanceof Error ? err.message : String(err));
    reportError('categorize-ingredients', err);
    return error(500, 'internal_error', 'Categorization failed');
  }
}
