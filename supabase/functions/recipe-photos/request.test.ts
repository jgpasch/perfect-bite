import type { RecipePhotosRequest } from '@shared/index.ts';
import { assertEquals } from '@std/assert';

import { RecipePhotosError } from './handler.ts';
import { handleRequest, MAX_BODY_BYTES, type RequestDeps } from './request.ts';

const ENDPOINT = 'http://localhost/functions/v1/recipe-photos';

function deps(overrides: Partial<RequestDeps> = {}) {
  const calls: RecipePhotosRequest[] = [];
  const d: RequestDeps = {
    recipePhotos: async (request) => {
      calls.push(request);
      return { images: ['https://example.com/a.jpg'] };
    },
    ...overrides,
  };
  return { d, calls };
}

const post = (body: BodyInit | null, headers: HeadersInit = {}) =>
  new Request(ENDPOINT, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

async function expectError(res: Response, status: number, code: string) {
  assertEquals(res.status, status);
  assertEquals((await res.json()).error, code);
}

Deno.test('POST { url } → 200 with the images', async () => {
  const { d, calls } = deps();
  const res = await handleRequest(post(JSON.stringify({ url: 'https://example.com/r' })), d);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { images: ['https://example.com/a.jpg'] });
  assertEquals(calls, [{ url: 'https://example.com/r' }]);
});

Deno.test('only POST', async () => {
  await expectError(await handleRequest(new Request(ENDPOINT, { method: 'GET' }), deps().d), 405, 'method_not_allowed');
});

Deno.test('not JSON or no url → 400', async () => {
  const { d, calls } = deps();
  await expectError(await handleRequest(post('{'), d), 400, 'invalid_request');
  await expectError(await handleRequest(post(JSON.stringify({})), d), 400, 'invalid_url');
  await expectError(await handleRequest(post(JSON.stringify({ url: 42 })), d), 400, 'invalid_url');
  assertEquals(calls, []);
});

Deno.test('a body over the cap → 413, declared or not', async () => {
  const big = JSON.stringify({ url: `https://example.com/${'a'.repeat(MAX_BODY_BYTES)}` });
  await expectError(await handleRequest(post(big, { 'content-length': String(big.length) }), deps().d), 413, 'payload_too_large');
  await expectError(await handleRequest(post(big), deps().d), 413, 'payload_too_large');
});

Deno.test('failures map to their statuses; anything else is a 500', async () => {
  const failing = (err: Error) => deps({ recipePhotos: () => Promise.reject(err) }).d;
  const body = JSON.stringify({ url: 'https://example.com/r' });
  await expectError(await handleRequest(post(body), failing(new RecipePhotosError({ code: 'invalid_url' }, 'x'))), 400, 'invalid_url');
  await expectError(await handleRequest(post(body), failing(new RecipePhotosError({ code: 'fetch_failed' }, 'x'))), 502, 'fetch_failed');
  await expectError(await handleRequest(post(body), failing(new RecipePhotosError({ code: 'rate_limited' }, 'x'))), 429, 'rate_limited');
  await expectError(await handleRequest(post(body), failing(new Error('db down'))), 500, 'internal_error');
});
