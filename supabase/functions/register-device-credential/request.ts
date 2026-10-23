// HTTP layer for register-device-credential, kept free of `@supabase/server` so Deno tests can call
// it. index.ts verifies the JWT first (401 comes from the library), then calls handleRequest.
import { z } from 'zod';

import { reportError } from '../_shared/sentry.ts';
import { readBody } from '../categorize-ingredients/request.ts';
import type { RegisterDeviceCredentialRequest, RegisterDeviceCredentialResponse } from './handler.ts';

/** `{ installationId }` and nothing more. */
export const MAX_BODY_BYTES = 1024;

const RequestSchema = z.object({ installationId: z.uuid() });

export type RequestDeps = {
  register: (request: RegisterDeviceCredentialRequest) => Promise<RegisterDeviceCredentialResponse>;
};

const error = (status: number, code: string, message: string) => Response.json({ error: code, message }, { status });

function parseRequest(bytes: Uint8Array): RegisterDeviceCredentialRequest | Response {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return error(400, 'invalid_request', 'Body is not valid JSON');
  }
  const parsed = RequestSchema.safeParse(body);
  if (parsed.success) return { installationId: parsed.data.installationId.toLowerCase() };
  const issue = parsed.error.issues[0];
  return error(400, 'invalid_request', `${issue.path.join('.') || 'body'}: ${issue.message}`);
}

/**
 * POST { installationId } → 200 { token, expiresAt } (not cached) · 400 invalid_request · 405 · 413
 * · 500. Never logs the token.
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
    return Response.json(await deps.register(request), { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error('register-device-credential failed:', err instanceof Error ? err.message : String(err));
    reportError('register-device-credential', err);
    return error(500, 'internal_error', 'Registering the device failed');
  }
}
