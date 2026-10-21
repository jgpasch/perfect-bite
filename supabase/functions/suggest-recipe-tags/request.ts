// HTTP layer for suggest-recipe-tags, kept free of `@supabase/server` so Deno tests can call it.
// index.ts verifies the JWT first (401 comes from the library), then calls handleRequest.
import { SuggestRecipeTagsRequestSchema, type SuggestRecipeTagsRequest, type SuggestRecipeTagsResponse } from '@shared/index.ts';

import { dailyLimitResponse, limitReachedResponse } from '../_shared/limits.ts';
import { reportError } from '../_shared/sentry.ts';
import { readBody } from '../categorize-ingredients/request.ts';
import { SuggestTagsError, type SuggestFailure } from './handler.ts';

/**
 * Request body cap: a name, 4,000 characters of notes and 80 ingredients fit many times over. Notes
 * and extra ingredients under it are cut, not refused.
 */
export const MAX_BODY_BYTES = 256 * 1024;

/** Seconds a client should wait with the kill switch on. */
export const PAUSED_RETRY_AFTER = 3600;
/** Seconds a client should wait after a provider error, timeout or invalid output. */
export const AI_FAILED_RETRY_AFTER = 30;

export type RequestDeps = {
  suggestRecipeTags: (request: SuggestRecipeTagsRequest) => Promise<SuggestRecipeTagsResponse>;
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

function failureResponse(failure: SuggestFailure, message: string, now?: number): Response {
  switch (failure.code) {
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

function parseRequest(bytes: Uint8Array): SuggestRecipeTagsRequest | Response {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return error(400, 'invalid_request', 'Body is not valid JSON');
  }
  const parsed = SuggestRecipeTagsRequestSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  return error(400, 'invalid_request', `${issue.path.join('.') || 'body'}: ${issue.message}`);
}

/**
 * POST SuggestRecipeTagsRequest → 200 SuggestRecipeTagsResponse · 400 · 405 · 413 · 429 · 500 (incl. not_configured) ·
 * 503 with Retry-After. Never logs headers or the recipe.
 */
export async function handleRequest(req: Request, deps: RequestDeps): Promise<Response> {
  if (req.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST');

  // AI_MODEL_TAGS defaults to AI_MODEL_RECIPE; with neither, the function isn't set up (`off` is a 503).
  const env = deps.env ?? ((key: string) => Deno.env.get(key));
  if (!env('AI_MODEL_TAGS')?.trim() && !env('AI_MODEL_RECIPE')?.trim()) {
    console.error('suggest-recipe-tags: neither AI_MODEL_TAGS nor AI_MODEL_RECIPE is set');
    return error(500, 'not_configured', 'AI_MODEL_TAGS is not set');
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
    return Response.json(await deps.suggestRecipeTags(request));
  } catch (err) {
    if (err instanceof SuggestTagsError) {
      if (err.failure.code === 'unavailable') {
        console.warn(JSON.stringify({ level: 'warn', event: 'recipe_tags_failed', reason: err.failure.reason, error: err.message.slice(0, 200) }));
      }
      return failureResponse(err.failure, err.message, deps.now?.());
    }
    console.error('suggest-recipe-tags failed:', err instanceof Error ? err.message : String(err));
    reportError('suggest-recipe-tags', err);
    return error(500, 'internal_error', 'Tag suggestion failed');
  }
}
