// HTTP layer for import-recipe-photo, kept free of `@supabase/server` so Deno tests can call it.
// index.ts verifies the JWT first (401 comes from the library), then calls handleRequest.
import {
  MAX_PHOTO_IMPORT_BODY_BYTES,
  RecipePhotoImportRequestSchema,
  type RecipeImportResponse,
  type RecipePhotoImportRequest,
} from '@shared/index.ts';

import { reportError } from '../_shared/sentry.ts';
import { parseCap, readBody } from '../categorize-ingredients/request.ts';
import { ImportRecipePhotoError, type PhotoImportFailure } from './handler.ts';

/** Request body cap. The app's downscaled JPEGs (2000 px, quality 0.8) are well under it. */
export const MAX_BODY_BYTES = MAX_PHOTO_IMPORT_BODY_BYTES;

/** Photo imports a day across all users, unless RECIPE_PHOTO_DAILY_CAP says otherwise. */
export const DEFAULT_DAILY_PHOTO_CAP = 300;

/** Seconds a client should wait after the global cap or with the kill switch on. */
export const PAUSED_RETRY_AFTER = 3600;
/** Seconds a client should wait after a provider error, timeout or invalid output. */
export const AI_FAILED_RETRY_AFTER = 30;

/** RECIPE_PHOTO_DAILY_CAP as a non-negative integer; unset or invalid falls back to the default. */
export function dailyPhotoCap(value: string | undefined): number {
  return parseCap(value, DEFAULT_DAILY_PHOTO_CAP);
}

export type RequestDeps = {
  importRecipePhoto: (request: RecipePhotoImportRequest) => Promise<RecipeImportResponse>;
  /** Reads an env var. Defaults to `Deno.env.get`. */
  env?: (key: string) => string | undefined;
};

const error = (status: number, code: string, message: string, retryAfter?: number) => {
  const res = Response.json({ error: code, message }, { status });
  if (retryAfter !== undefined) res.headers.set('Retry-After', String(retryAfter));
  return res;
};

function failureResponse(failure: PhotoImportFailure, message: string): Response {
  switch (failure.code) {
    case 'not_entitled':
      return error(403, 'not_entitled', message);
    case 'not_a_recipe':
      return error(422, 'not_a_recipe', message);
    case 'rate_limited':
      return error(429, 'rate_limited', message);
    case 'unavailable':
      return error(503, 'unavailable', message, failure.reason === 'ai_failed' ? AI_FAILED_RETRY_AFTER : PAUSED_RETRY_AFTER);
  }
}

/** The body as a request, or a 400. A message names the field but never echoes image data. */
function parseRequest(bytes: Uint8Array): RecipePhotoImportRequest | Response {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return error(400, 'invalid_request', 'Body is not valid JSON');
  }
  const parsed = RecipePhotoImportRequestSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  return error(400, 'invalid_request', `${issue.path.join('.') || 'body'}: ${issue.message}`);
}

/**
 * POST RecipePhotoImportRequest → 200 RecipeImportResponse · 400 · 403 · 405 · 413 · 422 · 429 ·
 * 500 (incl. not_configured) · 503 with Retry-After. Never logs headers or images.
 */
export async function handleRequest(req: Request, deps: RequestDeps): Promise<Response> {
  if (req.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST');

  // AI_MODEL_RECIPE_PHOTO defaults to AI_MODEL_RECIPE; with neither, the function isn't set up (`off` is a 503).
  const env = deps.env ?? ((key: string) => Deno.env.get(key));
  if (!env('AI_MODEL_RECIPE_PHOTO')?.trim() && !env('AI_MODEL_RECIPE')?.trim()) {
    console.error('import-recipe-photo: neither AI_MODEL_RECIPE_PHOTO nor AI_MODEL_RECIPE is set');
    return error(500, 'not_configured', 'AI_MODEL_RECIPE_PHOTO is not set');
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
    return Response.json(await deps.importRecipePhoto(request));
  } catch (err) {
    if (err instanceof ImportRecipePhotoError) {
      if (err.failure.code === 'unavailable') {
        console.warn(JSON.stringify({ level: 'warn', event: 'recipe_photo_import_failed', reason: err.failure.reason, error: err.message.slice(0, 200) }));
      }
      return failureResponse(err.failure, err.message);
    }
    console.error('import-recipe-photo failed:', err instanceof Error ? err.message : String(err));
    reportError('import-recipe-photo', err);
    return error(500, 'internal_error', 'Photo import failed');
  }
}
