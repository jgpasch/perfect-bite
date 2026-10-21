// HTTP layer for import-recipe, kept free of `@supabase/server` so Deno tests can call it.
// index.ts verifies the JWT first (401 comes from the library), then calls handleRequest.
import { RecipeImportRequestSchema, type RecipeImportRequest, type RecipeImportResponse } from '@shared/index.ts';

import { dailyLimitResponse, limitReachedResponse } from '../_shared/limits.ts';
import { reportError } from '../_shared/sentry.ts';
import { readBody } from '../categorize-ingredients/request.ts';
import { ImportRecipeError, type ImportFailure } from './handler.ts';

/** Request body cap: 10 JSON-LD blocks of 200 KB and 50 KB of text, with room for JSON escaping. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Seconds a client should wait with the kill switch on. */
export const PAUSED_RETRY_AFTER = 3600;
/** Seconds a client should wait after a provider error or timeout. */
export const AI_FAILED_RETRY_AFTER = 30;

export type RequestDeps = {
  importRecipe: (request: RecipeImportRequest) => Promise<RecipeImportResponse>;
  /** Reads an env var. Defaults to `Deno.env.get`. */
  env?: (key: string) => string | undefined;
  /** The clock for `resets_at`; defaults to `Date.now`. */
  now?: () => number;
};

const error = (status: number, code: string, message: string, retryAfter?: number) => {
  const res = Response.json({ error: code, message }, { status });
  if (retryAfter !== undefined) res.headers.set('Retry-After', String(retryAfter));
  return res;
};

function failureResponse(failure: ImportFailure, message: string, now?: number): Response {
  switch (failure.code) {
    case 'invalid_url':
      return error(400, 'invalid_url', message);
    case 'not_entitled':
      return error(403, 'not_entitled', message);
    case 'fetch_failed':
      return error(502, 'fetch_failed', 'The page could not be fetched');
    case 'not_a_recipe':
      return error(422, 'not_a_recipe', message);
    case 'rate_limited':
      return error(429, 'rate_limited', message);
    case 'daily_limit':
      return dailyLimitResponse(message, now);
    case 'limit_reached':
      return limitReachedResponse(message, now);
    case 'unavailable':
      return error(503, 'unavailable', message, failure.reason === 'ai_failed' ? AI_FAILED_RETRY_AFTER : PAUSED_RETRY_AFTER);
  }
}

function parseRequest(bytes: Uint8Array): RecipeImportRequest | Response {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return error(400, 'invalid_request', 'Body is not valid JSON');
  }
  const parsed = RecipeImportRequestSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  if (issue.path[0] === 'url') return error(400, 'invalid_url', 'url must be an http(s) URL');
  return error(400, 'invalid_request', `${issue.path.join('.') || 'body'}: ${issue.message}`);
}

/**
 * POST RecipeImportRequest → 200 RecipeImportResponse · 400 · 403 · 405 · 413 · 422 · 429 · 500 · 502 ·
 * 503 with Retry-After. Never logs headers or page content.
 */
export async function handleRequest(req: Request, deps: RequestDeps): Promise<Response> {
  if (req.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST');

  const env = deps.env ?? ((key: string) => Deno.env.get(key));
  if (!env('AI_MODEL_RECIPE')?.trim()) {
    console.error('import-recipe: AI_MODEL_RECIPE is not set');
    return error(500, 'not_configured', 'AI_MODEL_RECIPE is not set');
  }

  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return error(413, 'payload_too_large', `Body over ${MAX_BODY_BYTES} bytes`);
  }
  const bytes = await readBody(req, MAX_BODY_BYTES);
  if (!bytes) return error(413, 'payload_too_large', `Body over ${MAX_BODY_BYTES} bytes`);

  const request = parseRequest(bytes);
  if (request instanceof Response) return request;

  try {
    return Response.json(await deps.importRecipe(request));
  } catch (err) {
    if (err instanceof ImportRecipeError) {
      if (err.failure.code === 'fetch_failed' || err.failure.code === 'unavailable') {
        console.warn(JSON.stringify({ level: 'warn', event: 'recipe_import_failed', code: err.failure.code, error: err.message.slice(0, 200) }));
      }
      return failureResponse(err.failure, err.message, deps.now?.());
    }
    console.error('import-recipe failed:', err instanceof Error ? err.message : String(err));
    reportError('import-recipe', err);
    return error(500, 'internal_error', 'Recipe import failed');
  }
}
