// HTTP layer for recipe-photos, kept free of `@supabase/server` so Deno tests can call it.
// index.ts verifies the JWT first (401 comes from the library), then calls handleRequest.
import { RecipePhotosRequestSchema, type RecipePhotosRequest, type RecipePhotosResponse } from '@shared/index.ts';

import { reportError } from '../_shared/sentry.ts';
import { parseCap, readBody } from '../categorize-ingredients/request.ts';
import { RecipePhotosError, type RecipePhotosFailure } from './handler.ts';

/** Retry-After (seconds) while the global cap is reached, as import-recipe's. */
export const PAUSED_RETRY_AFTER = 3600;

/** A link and nothing else: anything bigger is refused. */
export const MAX_BODY_BYTES = 8 * 1024;

/** Requests a day across all users, unless RECIPE_PHOTOS_DAILY_CAP says otherwise. */
export const DEFAULT_RECIPE_PHOTOS_DAILY_CAP = 2_000;

/** RECIPE_PHOTOS_DAILY_CAP as a non-negative integer; unset or invalid falls back to the default. */
export function dailyRecipePhotosCap(value: string | undefined): number {
  return parseCap(value, DEFAULT_RECIPE_PHOTOS_DAILY_CAP);
}

export type RequestDeps = {
  recipePhotos: (request: RecipePhotosRequest) => Promise<RecipePhotosResponse>;
};

const error = (status: number, code: string, message: string, retryAfter?: number) => {
  const res = Response.json({ error: code, message }, { status });
  if (retryAfter !== undefined) res.headers.set('Retry-After', String(retryAfter));
  return res;
};

function failureResponse(failure: RecipePhotosFailure, message: string): Response {
  switch (failure.code) {
    case 'invalid_url':
      return error(400, 'invalid_url', message);
    case 'fetch_failed':
      return error(502, 'fetch_failed', 'The page could not be fetched');
    case 'rate_limited':
      return error(429, 'rate_limited', message);
    case 'unavailable':
      return error(503, 'unavailable', message, PAUSED_RETRY_AFTER);
  }
}

function parseRequest(bytes: Uint8Array): RecipePhotosRequest | Response {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return error(400, 'invalid_request', 'Body is not valid JSON');
  }
  const parsed = RecipePhotosRequestSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  if (issue.path[0] === 'url') return error(400, 'invalid_url', 'url must be an http(s) URL');
  return error(400, 'invalid_request', `${issue.path.join('.') || 'body'}: ${issue.message}`);
}

/**
 * POST RecipePhotosRequest → 200 RecipePhotosResponse · 400 invalid_request/invalid_url · 405 · 413 ·
 * 429 · 502 fetch_failed · 503 with Retry-After · 500. Never logs headers or the URL.
 */
export async function handleRequest(req: Request, deps: RequestDeps): Promise<Response> {
  if (req.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST');

  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return error(413, 'payload_too_large', `Body over ${MAX_BODY_BYTES} bytes`);
  }
  const bytes = await readBody(req, MAX_BODY_BYTES);
  if (!bytes) return error(413, 'payload_too_large', `Body over ${MAX_BODY_BYTES} bytes`);

  const request = parseRequest(bytes);
  if (request instanceof Response) return request;

  try {
    return Response.json(await deps.recipePhotos(request));
  } catch (err) {
    if (err instanceof RecipePhotosError) return failureResponse(err.failure, err.message);
    console.error('recipe-photos failed:', err instanceof Error ? err.message : String(err));
    reportError('recipe-photos', err);
    return error(500, 'internal_error', 'Reading the page failed');
  }
}
