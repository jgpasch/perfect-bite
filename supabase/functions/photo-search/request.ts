// HTTP layer for photo-search, kept free of `@supabase/server` so Deno tests can call it.
// index.ts verifies the JWT first (401 comes from the library), then calls handleRequest.
import { PhotoSearchRequestSchema, type PhotoSearchRequest, type PhotoSearchResponse } from '@shared/index.ts';

import { parseCap, readBody } from '../categorize-ingredients/request.ts';
import { PhotoSearchError, type PhotoSearchFailure } from './handler.ts';

/** Retry-After (seconds) while search is unavailable, as the other functions' global cap. */
export const PAUSED_RETRY_AFTER = 3600;

/** A few words and a page number: anything bigger is refused. */
export const MAX_BODY_BYTES = 8 * 1024;

/** Searches a day across all users that reach the provider, unless PHOTO_SEARCH_DAILY_CAP says otherwise. */
export const DEFAULT_PHOTO_SEARCH_DAILY_CAP = 3_000;

/** PHOTO_SEARCH_DAILY_CAP as a non-negative integer; unset or invalid falls back to the default. */
export function dailyPhotoSearchCap(value: string | undefined): number {
  return parseCap(value, DEFAULT_PHOTO_SEARCH_DAILY_CAP);
}

export type RequestDeps = {
  photoSearch: (request: PhotoSearchRequest) => Promise<PhotoSearchResponse>;
};

const error = (status: number, code: string, message: string, retryAfter?: number) => {
  const res = Response.json({ error: code, message }, { status });
  if (retryAfter !== undefined) res.headers.set('Retry-After', String(retryAfter));
  return res;
};

function failureResponse(failure: PhotoSearchFailure, message: string): Response {
  switch (failure.code) {
    case 'rate_limited':
      return error(429, 'rate_limited', message);
    case 'unavailable':
      return error(503, 'unavailable', message, PAUSED_RETRY_AFTER);
    case 'search_failed':
      return error(502, 'search_failed', 'The photo search failed');
  }
}

function parseRequest(bytes: Uint8Array): PhotoSearchRequest | Response {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return error(400, 'invalid_request', 'Body is not valid JSON');
  }
  const parsed = PhotoSearchRequestSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  return error(400, 'invalid_request', `${issue.path.join('.') || 'body'}: ${issue.message}`);
}

/**
 * POST PhotoSearchRequest → 200 PhotoSearchResponse · 400 invalid_request · 405 · 413 · 429 ·
 * 502 search_failed · 503 unavailable with Retry-After · 500. Never logs headers or the query.
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
    return Response.json(await deps.photoSearch(request));
  } catch (err) {
    if (err instanceof PhotoSearchError) return failureResponse(err.failure, err.message);
    console.error('photo-search failed:', err instanceof Error ? err.message : String(err));
    return error(500, 'internal_error', 'The photo search failed');
  }
}
