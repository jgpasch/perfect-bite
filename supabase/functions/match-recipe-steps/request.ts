// HTTP layer for match-recipe-steps, kept free of `@supabase/server` so Deno tests can call it.
// index.ts verifies the JWT first (401 comes from the library), then calls handleRequest.
import { MatchRecipeStepsRequestSchema, type MatchRecipeStepsRequest, type MatchRecipeStepsResponse } from '@shared/index.ts';

import { dailyLimitResponse, limitReachedResponse } from '../_shared/limits.ts';
import { reportError } from '../_shared/sentry.ts';
import { readBody } from '../categorize-ingredients/request.ts';
import { AI_FAILED_RETRY_AFTER, PAUSED_RETRY_AFTER } from '../suggest-recipe-tags/request.ts';
import { MatchStepsError, type MatchStepsFailure } from './handler.ts';

export { AI_FAILED_RETRY_AFTER, PAUSED_RETRY_AFTER };

/**
 * Request body cap: 100 steps of 2,000 characters and 80 ingredients fit, just. Long steps and
 * extra ingredients under it are cut, not refused.
 */
export const MAX_BODY_BYTES = 256 * 1024;

export type RequestDeps = {
  matchSteps: (request: MatchRecipeStepsRequest) => Promise<MatchRecipeStepsResponse>;
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

function failureResponse(failure: MatchStepsFailure, message: string, now?: number): Response {
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

function parseRequest(bytes: Uint8Array): MatchRecipeStepsRequest | Response {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return error(400, 'invalid_request', 'Body is not valid JSON');
  }
  const parsed = MatchRecipeStepsRequestSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  return error(400, 'invalid_request', `${issue.path.join('.') || 'body'}: ${issue.message}`);
}

/**
 * POST MatchRecipeStepsRequest → 200 MatchRecipeStepsResponse · 400 · 405 · 413 · 429 · 500
 * (incl. not_configured) · 503 with Retry-After. Never logs headers or the recipe.
 */
export async function handleRequest(req: Request, deps: RequestDeps): Promise<Response> {
  if (req.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST');

  // AI_MODEL_STEPS defaults to AI_MODEL_RECIPE; with neither, the function isn't set up (`off` is a 503).
  const env = deps.env ?? ((key: string) => Deno.env.get(key));
  if (!env('AI_MODEL_STEPS')?.trim() && !env('AI_MODEL_RECIPE')?.trim()) {
    console.error('match-recipe-steps: neither AI_MODEL_STEPS nor AI_MODEL_RECIPE is set');
    reportError('match-recipe-steps', new Error('match-recipe-steps: neither AI_MODEL_STEPS nor AI_MODEL_RECIPE is set'), { event: 'not_configured' });
    return error(500, 'not_configured', 'AI_MODEL_STEPS is not set');
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
    return Response.json(await deps.matchSteps(request));
  } catch (err) {
    if (err instanceof MatchStepsError) {
      if (err.failure.code === 'unavailable') {
        console.warn(JSON.stringify({ level: 'warn', event: 'step_match_failed', reason: err.failure.reason, error: err.message.slice(0, 200) }));
      }
      return failureResponse(err.failure, err.message, deps.now?.());
    }
    console.error('match-recipe-steps failed:', err instanceof Error ? err.message : String(err));
    reportError('match-recipe-steps', err);
    return error(500, 'internal_error', 'Step matching failed');
  }
}
