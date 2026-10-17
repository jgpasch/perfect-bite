import type { PhotoSearchRequest } from '@shared/index.ts';
import { assertEquals } from '@std/assert';

import { PhotoSearchError } from './handler.ts';
import {
  dailyPhotoSearchCap,
  DEFAULT_PHOTO_SEARCH_DAILY_CAP,
  handleRequest,
  MAX_BODY_BYTES,
  PAUSED_RETRY_AFTER,
  type RequestDeps,
} from './request.ts';

const ENDPOINT = 'http://localhost/functions/v1/photo-search';

function deps(overrides: Partial<RequestDeps> = {}) {
  const calls: PhotoSearchRequest[] = [];
  const d: RequestDeps = {
    photoSearch: async (request) => {
      calls.push(request);
      return { photos: [], hasMore: false };
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

Deno.test('POST { query } → 200, the query trimmed and the page 1 by default', async () => {
  const { d, calls } = deps();
  const res = await handleRequest(post(JSON.stringify({ query: '  lemon cake ' })), d);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { photos: [], hasMore: false });
  assertEquals(calls, [{ query: 'lemon cake', page: 1 }]);
});

Deno.test('the query may be 100 characters after trimming, and the page 1 to 10', async () => {
  const { d, calls } = deps();
  assertEquals((await handleRequest(post(JSON.stringify({ query: ` ${'a'.repeat(100)} `, page: 10 })), d)).status, 200);
  assertEquals(calls, [{ query: 'a'.repeat(100), page: 10 }]);
});

Deno.test('only POST', async () => {
  await expectError(await handleRequest(new Request(ENDPOINT, { method: 'GET' }), deps().d), 405, 'method_not_allowed');
});

Deno.test('not JSON, or a bad query or page → 400 invalid_request, and the search is not run', async () => {
  const { d, calls } = deps();
  await expectError(await handleRequest(post('{'), d), 400, 'invalid_request');
  await expectError(await handleRequest(post(''), d), 400, 'invalid_request');
  for (const body of [{}, { query: '' }, { query: 'a'.repeat(101) }, { query: 'cake', page: 0 }, { query: 'cake', page: 11 }, {
    query: 'cake',
    page: null,
  }]) {
    await expectError(await handleRequest(post(JSON.stringify(body)), d), 400, 'invalid_request');
  }
  assertEquals(calls, []);
});

Deno.test('a body over 8 KB → 413, declared or not', async () => {
  const big = JSON.stringify({ query: 'cake', pad: 'a'.repeat(MAX_BODY_BYTES) });
  await expectError(await handleRequest(post(big, { 'content-length': String(big.length) }), deps().d), 413, 'payload_too_large');
  await expectError(await handleRequest(post(big), deps().d), 413, 'payload_too_large');
});

Deno.test('failures map to their statuses; anything else is a 500', async () => {
  const failing = (err: Error) => deps({ photoSearch: () => Promise.reject(err) }).d;
  const body = JSON.stringify({ query: 'cake' });
  await expectError(await handleRequest(post(body), failing(new PhotoSearchError({ code: 'rate_limited' }, 'x'))), 429, 'rate_limited');
  await expectError(await handleRequest(post(body), failing(new PhotoSearchError({ code: 'search_failed' }, 'x'))), 502, 'search_failed');
  for (const reason of ['no_key', 'global_cap', 'pexels_rate_limited'] as const) {
    const res = await handleRequest(post(body), failing(new PhotoSearchError({ code: 'unavailable', reason }, 'x')));
    assertEquals(res.headers.get('Retry-After'), String(PAUSED_RETRY_AFTER));
    await expectError(res, 503, 'unavailable');
  }
  await expectError(await handleRequest(post(body), failing(new Error('db down'))), 500, 'internal_error');
});

Deno.test('the deployed function answers 401 without a JWT, before any work', async () => {
  const saved = Object.fromEntries(
    ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'PEXELS_API_KEY'].map((k) => [k, Deno.env.get(k)]),
  );
  Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:1');
  Deno.env.set('SUPABASE_ANON_KEY', 'anon');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service');
  Deno.env.set('PEXELS_API_KEY', 'key');
  try {
    const { default: fn } = await import('./index.ts');
    const body = JSON.stringify({ query: 'cake' });
    const res = await fn.fetch(post(body));
    assertEquals(res.status, 401);
    await res.body?.cancel();
    const bad = await fn.fetch(post(body, { authorization: 'Bearer not-a-jwt' }));
    assertEquals(bad.status, 401);
    await bad.body?.cancel();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});

Deno.test('PHOTO_SEARCH_DAILY_CAP: a non-negative integer, else 3,000', () => {
  assertEquals(DEFAULT_PHOTO_SEARCH_DAILY_CAP, 3000);
  assertEquals(dailyPhotoSearchCap('500'), 500);
  assertEquals(dailyPhotoSearchCap('0'), 0);
  assertEquals(dailyPhotoSearchCap(undefined), DEFAULT_PHOTO_SEARCH_DAILY_CAP);
  assertEquals(dailyPhotoSearchCap(''), DEFAULT_PHOTO_SEARCH_DAILY_CAP);
  assertEquals(dailyPhotoSearchCap('-1'), DEFAULT_PHOTO_SEARCH_DAILY_CAP);
  assertEquals(dailyPhotoSearchCap('lots'), DEFAULT_PHOTO_SEARCH_DAILY_CAP);
});
