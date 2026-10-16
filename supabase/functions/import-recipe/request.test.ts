import type { RecipeImportRequest, RecipeImportResponse } from '@shared/index.ts';
import { assertEquals } from '@std/assert';

import { ImportRecipeError, type ImportFailure } from './handler.ts';
import {
  AI_FAILED_RETRY_AFTER,
  dailyImportCap,
  DEFAULT_DAILY_IMPORT_CAP,
  handleRequest,
  MAX_BODY_BYTES,
  PAUSED_RETRY_AFTER,
  type RequestDeps,
} from './request.ts';

const ENDPOINT = 'http://localhost/functions/v1/import-recipe';
const OK: RecipeImportResponse = {
  name: 'Toast',
  sourceUrl: 'https://example.com/toast',
  servings: 1,
  ingredients: [{ ingredientName: 'bread', displayName: 'bread', quantity: 2, unit: null, note: 'slices', categoryId: null, status: 'pending' }],
  tags: null,
  totalMinutes: null,
  steps: [],
  stepIngredients: null,
  imageUrl: null,
};

/** Deps with AI_MODEL_RECIPE=mock and an importRecipe that records what it was called with. */
function deps(overrides: Partial<RequestDeps> = {}) {
  const calls: RecipeImportRequest[] = [];
  const d: RequestDeps = {
    importRecipe: async (request) => {
      calls.push(request);
      return OK;
    },
    env: (key) => (key === 'AI_MODEL_RECIPE' ? 'mock' : undefined),
    ...overrides,
  };
  return { d, calls };
}

const failing = (failure: ImportFailure) => deps({ importRecipe: () => Promise.reject(new ImportRecipeError(failure, 'nope')) }).d;

const post = (body: BodyInit | null, headers: HeadersInit = {}) =>
  new Request(ENDPOINT, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

async function expectError(res: Response, status: number, code: string) {
  assertEquals(res.status, status);
  assertEquals((await res.json()).error, code);
}

// --- 200 ----------------------------------------------------------------------------------------

Deno.test('a valid request returns importRecipe’s response and passes the parsed request through', async () => {
  const { d, calls } = deps();
  const page = { title: 'Toast', jsonLd: ['{}'], text: '2 slices bread' };
  const res = await handleRequest(post(JSON.stringify({ url: 'https://example.com/toast', page, extra: 1 })), d);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), OK);
  assertEquals(calls, [{ url: 'https://example.com/toast', page }]);
});

// --- Failures from importRecipe -----------------------------------------------------------------------

Deno.test('each import failure maps to its status and code', async () => {
  await expectError(await handleRequest(post('{"url":"https://a.example"}'), failing({ code: 'invalid_url' })), 400, 'invalid_url');
  await expectError(await handleRequest(post('{"url":"https://a.example"}'), failing({ code: 'fetch_failed' })), 502, 'fetch_failed');
  await expectError(await handleRequest(post('{"url":"https://a.example"}'), failing({ code: 'not_a_recipe' })), 422, 'not_a_recipe');
  await expectError(await handleRequest(post('{"url":"https://a.example"}'), failing({ code: 'rate_limited' })), 429, 'rate_limited');
});

Deno.test('unavailable is 503 with Retry-After: an hour when paused, 30 s after a model failure', async () => {
  for (const [reason, retryAfter] of [
    ['global_cap', PAUSED_RETRY_AFTER],
    ['ai_off', PAUSED_RETRY_AFTER],
    ['ai_failed', AI_FAILED_RETRY_AFTER],
  ] as const) {
    const res = await handleRequest(post('{"url":"https://a.example"}'), failing({ code: 'unavailable', reason }));
    assertEquals(res.headers.get('Retry-After'), String(retryAfter), reason);
    await expectError(res, 503, 'unavailable');
  }
  assertEquals([PAUSED_RETRY_AFTER, AI_FAILED_RETRY_AFTER], [3600, 30]);
});

Deno.test('not_entitled is 403 with its message and no Retry-After', async () => {
  const failure = new ImportRecipeError({ code: 'not_entitled' }, "Recipe import isn't included in your plan");
  const { d } = deps({ importRecipe: () => Promise.reject(failure) });
  const res = await handleRequest(post('{"url":"https://a.example"}'), d);
  assertEquals(res.status, 403);
  assertEquals(res.headers.get('Retry-After'), null);
  assertEquals(await res.json(), { error: 'not_entitled', message: "Recipe import isn't included in your plan" });
});

Deno.test('fetch_failed doesn’t echo the fetch error to the client', async () => {
  const res = await handleRequest(post('{"url":"https://a.example"}'), failing({ code: 'fetch_failed' }));
  assertEquals(await res.json(), { error: 'fetch_failed', message: 'The page could not be fetched' });
});

Deno.test('an unexpected error is a 500 internal_error', async () => {
  const { d } = deps({ importRecipe: () => Promise.reject(new Error('boom')) });
  await expectError(await handleRequest(post('{"url":"https://a.example"}'), d), 500, 'internal_error');
});

// --- 400 --------------------------------------------------------------------------------------------

Deno.test('a missing, non-string or non-http(s) url is 400 invalid_url and never reaches importRecipe', async () => {
  for (const body of ['{}', '{"url":42}', '{"url":"ftp://example.com/x"}', '{"url":"example.com/x"}', '{"url":""}']) {
    const { d, calls } = deps();
    await expectError(await handleRequest(post(body), d), 400, 'invalid_url');
    assertEquals(calls, [], body);
  }
});

Deno.test('bad JSON or a bad page is 400 invalid_request', async () => {
  const tooMany = { url: 'https://a.example', page: { jsonLd: Array.from({ length: 11 }, () => '{}') } };
  const bigBlock = { url: 'https://a.example', page: { jsonLd: ['x'.repeat(200 * 1024 + 1)] } };
  const bigText = { url: 'https://a.example', page: { text: 'é'.repeat(25 * 1024 + 1) } };
  for (const body of ['{not json', 'null', JSON.stringify(tooMany), JSON.stringify(bigBlock), JSON.stringify(bigText), '{"url":"https://a.example","page":{"title":5}}']) {
    const { d, calls } = deps();
    await expectError(await handleRequest(post(body), d), 400, 'invalid_request');
    assertEquals(calls, []);
  }
});

Deno.test('a page at the caps is accepted', async () => {
  const { d, calls } = deps();
  const page = { jsonLd: Array.from({ length: 10 }, () => 'x'.repeat(200 * 1024)), text: 'é'.repeat(25 * 1024) };
  const res = await handleRequest(post(JSON.stringify({ url: 'https://a.example', page })), d);
  assertEquals(res.status, 200);
  assertEquals(calls.length, 1);
});

// --- Protocol ---------------------------------------------------------------------------------------

Deno.test('only POST is allowed', async () => {
  const { d } = deps();
  await expectError(await handleRequest(new Request(ENDPOINT, { method: 'GET' }), d), 405, 'method_not_allowed');
});

Deno.test('a body over the cap is 413, declared or streamed', async () => {
  const { d, calls } = deps();
  await expectError(await handleRequest(post('{}', { 'content-length': String(MAX_BODY_BYTES + 1) }), d), 413, 'payload_too_large');
  const big = new TextEncoder().encode(JSON.stringify({ url: 'https://a.example', pad: 'x'.repeat(MAX_BODY_BYTES) }));
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(big);
      c.close();
    },
  });
  await expectError(await handleRequest(post(stream), d), 413, 'payload_too_large');
  assertEquals(calls, []);
});

Deno.test('an unset AI_MODEL_RECIPE is a 500 not_configured', async () => {
  const { d, calls } = deps({ env: () => undefined });
  await expectError(await handleRequest(post('{"url":"https://a.example"}'), d), 500, 'not_configured');
  assertEquals(calls, []);
});

Deno.test('dailyImportCap reads RECIPE_IMPORT_DAILY_CAP, falling back to 2,000', () => {
  assertEquals(DEFAULT_DAILY_IMPORT_CAP, 2000);
  assertEquals(dailyImportCap(undefined), 2000);
  assertEquals(dailyImportCap(''), 2000);
  assertEquals(dailyImportCap(' 50 '), 50);
  assertEquals(dailyImportCap('0'), 0);
  assertEquals(dailyImportCap('-1'), 2000);
  assertEquals(dailyImportCap('1.5'), 2000);
  assertEquals(dailyImportCap('abc'), 2000);
  assertEquals(dailyImportCap('2147483648'), 2000);
});

// --- Auth -------------------------------------------------------------------------------------------

Deno.test('the deployed function answers 401 without a JWT, before any work', async () => {
  const saved = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'AI_MODEL_RECIPE'].map((k) => [k, Deno.env.get(k)]));
  Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:1');
  Deno.env.set('SUPABASE_ANON_KEY', 'anon');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service');
  Deno.env.set('AI_MODEL_RECIPE', 'mock');
  try {
    const { default: fn } = await import('./index.ts');
    const res = await fn.fetch(post('{"url":"https://example.com/toast"}'));
    assertEquals(res.status, 401);
    await res.body?.cancel();
    const bad = await fn.fetch(post('{"url":"https://example.com/toast"}', { authorization: 'Bearer not-a-jwt' }));
    assertEquals(bad.status, 401);
    await bad.body?.cancel();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
