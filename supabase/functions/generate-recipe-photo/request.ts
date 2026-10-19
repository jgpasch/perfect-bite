// HTTP layer for generate-recipe-photo, kept free of `@supabase/server` so Deno tests can call it.
// index.ts verifies the JWT first (401 comes from the library), then calls handleRequest.
import { GenerateRecipePhotoRequestSchema, type GenerateRecipePhotoRequest, type GenerateRecipePhotoResponse } from '@shared/index.ts';

import { reportError } from '../_shared/sentry.ts';
import { MOCK_MODEL_ID } from '../_shared/ai/registry.ts';
import { AI_OFF } from '../_shared/ai/tasks.ts';
import { readBody } from '../categorize-ingredients/request.ts';
import { GeneratePhotoError, type GenerateFailure } from './handler.ts';
import { imageModel } from './image.ts';

/** A recipe id fits many times over. */
export const MAX_BODY_BYTES = 4 * 1024;

/** Seconds a client should wait with a kill switch on. */
export const PAUSED_RETRY_AFTER = 3600;

export type RequestDeps = {
  generateRecipePhoto: (request: GenerateRecipePhotoRequest) => Promise<GenerateRecipePhotoResponse>;
  /** Reads an env var. Defaults to `Deno.env.get`. */
  env?: (key: string) => string | undefined;
};

const error = (status: number, code: string, message: string, retryAfter?: number) => {
  const res = Response.json({ error: code, message }, { status });
  if (retryAfter !== undefined) res.headers.set('Retry-After', String(retryAfter));
  return res;
};

function failureResponse(failure: GenerateFailure, message: string): Response {
  switch (failure.code) {
    case 'not_entitled':
      return error(403, 'not_entitled', message);
    case 'not_found':
      return error(404, 'not_found', message);
    case 'already_generated':
      return error(409, 'already_generated', message);
    case 'not_food':
      return error(422, 'not_food', message);
    case 'generation_failed':
      return error(502, 'generation_failed', message);
    case 'unavailable':
      return error(503, 'unavailable', message, PAUSED_RETRY_AFTER);
  }
}

function parseRequest(bytes: Uint8Array): GenerateRecipePhotoRequest | Response {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return error(400, 'invalid_request', 'Body is not valid JSON');
  }
  const parsed = GenerateRecipePhotoRequestSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  return error(400, 'invalid_request', `${issue.path.join('.') || 'body'}: ${issue.message}`);
}

/**
 * What's missing for the function to run, or null. A description model (`AI_MODEL_PHOTO_DESCRIPTION`,
 * else the tag suggester's) is needed, and `OPENAI_API_KEY` unless the image model is `mock` or
 * `off` (`off` is a 503, not a set-up error).
 */
export function missingConfig(env: (key: string) => string | undefined): string | null {
  if (!['AI_MODEL_PHOTO_DESCRIPTION', 'AI_MODEL_TAGS', 'AI_MODEL_RECIPE'].some((key) => env(key)?.trim())) {
    return 'AI_MODEL_PHOTO_DESCRIPTION is not set';
  }
  const model = imageModel(env);
  if (model !== MOCK_MODEL_ID && model !== AI_OFF && !env('OPENAI_API_KEY')?.trim()) return 'OPENAI_API_KEY is not set';
  return null;
}

/**
 * POST GenerateRecipePhotoRequest → 200 GenerateRecipePhotoResponse · 400 · 403 · 404 · 405 · 409 ·
 * 413 · 422 · 500 (incl. not_configured) · 502 · 503 with Retry-After. Never logs headers.
 */
export async function handleRequest(req: Request, deps: RequestDeps): Promise<Response> {
  if (req.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST');

  const env = deps.env ?? ((key: string) => Deno.env.get(key));
  const missing = missingConfig(env);
  if (missing) {
    console.error(`generate-recipe-photo: ${missing}`);
    return error(500, 'not_configured', missing);
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
    return Response.json(await deps.generateRecipePhoto(request));
  } catch (err) {
    if (err instanceof GeneratePhotoError) {
      if (err.failure.code === 'generation_failed' || err.failure.code === 'unavailable') {
        console.warn(JSON.stringify({ level: 'warn', event: 'recipe_photo_ai_failed', failure: err.failure, error: err.message.slice(0, 200) }));
      }
      return failureResponse(err.failure, err.message);
    }
    console.error('generate-recipe-photo failed:', err instanceof Error ? err.message : String(err));
    reportError('generate-recipe-photo', err);
    return error(500, 'internal_error', 'Photo generation failed');
  }
}
