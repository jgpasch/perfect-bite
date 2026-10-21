import type { SuggestRecipeTagsRequest, SuggestRecipeTagsResponse } from '@shared/index.ts';
import { emptyAiRecipeTags } from '@shared/index.ts';
import { assertEquals } from '@std/assert';

import { SuggestTagsError, type SuggestFailure } from './handler.ts';
import {
  AI_FAILED_RETRY_AFTER,
  handleRequest,
  MAX_BODY_BYTES,
  PAUSED_RETRY_AFTER,
  type RequestDeps,
} from './request.ts';

const ENDPOINT = 'http://localhost/functions/v1/suggest-recipe-tags';
const OK: SuggestRecipeTagsResponse = { tags: { ...emptyAiRecipeTags(), meal: ['dinner'] }, promptVersion: 'suggest-recipe-tags.v1' };

/** Deps with AI_MODEL_TAGS=mock and a suggestRecipeTags that records what it was called with. */
function deps(overrides: Partial<RequestDeps> = {}) {
  const calls: SuggestRecipeTagsRequest[] = [];
  const d: RequestDeps = {
    suggestRecipeTags: async (request) => {
      calls.push(request);
      return OK;
    },
    env: (key) => (key === 'AI_MODEL_TAGS' ? 'mock' : undefined),
    ...overrides,
  };
  return { d, calls };
}

const failingDeps = (failure: SuggestFailure) => deps({ suggestRecipeTags: () => Promise.reject(new SuggestTagsError(failure, 'nope')) }).d;

const post = (body: BodyInit | null, headers: HeadersInit = {}) =>
  new Request(ENDPOINT, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

async function expectError(res: Response, status: number, code: string) {
  assertEquals(res.status, status);
  assertEquals((await res.json()).error, code);
}

const ingredient = (name: string) => ({ name, quantity: 1, unit: null, note: '' });

// --- 200 and validation -------------------------------------------------------------------------

Deno.test('a valid request returns the response and passes the parsed, trimmed request through', async () => {
  const { d, calls } = deps();
  const body = {
    name: '  Fish tacos ',
    notes: ' Friday ',
    ingredients: [{ name: ' cod ', quantity: 1.5, unit: 'lb', note: ' skinless ' }, { name: 'tortillas', quantity: 8, unit: null }],
    extra: 1,
  };
  const res = await handleRequest(post(JSON.stringify(body)), d);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), OK);
  assertEquals(calls, [
    {
      name: 'Fish tacos',
      notes: 'Friday',
      ingredients: [
        { name: 'cod', quantity: 1.5, unit: 'lb', note: 'skinless' },
        { name: 'tortillas', quantity: 8, unit: null, note: '' },
      ],
    },
  ]);
});

Deno.test('long text is cut, not refused: name to 120, notes to 4,000, ingredient names to 64 and notes to 120', async () => {
  const { d, calls } = deps();
  const body = {
    name: 'n'.repeat(500),
    notes: 'x'.repeat(10_000),
    ingredients: [{ name: 'i'.repeat(100), quantity: null, unit: null, note: 'o'.repeat(300) }],
  };
  assertEquals((await handleRequest(post(JSON.stringify(body)), d)).status, 200);
  const [request] = calls;
  assertEquals(request.name, 'n'.repeat(120));
  assertEquals(request.notes, 'x'.repeat(4000));
  assertEquals(request.ingredients, [{ name: 'i'.repeat(64), quantity: null, unit: null, note: 'o'.repeat(120) }]);
});

Deno.test('more than 80 ingredients are cut to the first 80, and empty-named ones dropped first', async () => {
  const { d, calls } = deps();
  const ingredients = [ingredient('  '), ...Array.from({ length: 100 }, (_, i) => ingredient(`item ${i}`))];
  assertEquals((await handleRequest(post(JSON.stringify({ name: 'Big', notes: null, ingredients })), d)).status, 200);
  assertEquals(calls[0].ingredients.length, 80);
  assertEquals(calls[0].ingredients[0].name, 'item 0');
  assertEquals(calls[0].ingredients[79].name, 'item 79');
});

Deno.test('notes may be null, missing or blank, which all mean none', async () => {
  for (const notes of [null, undefined, '   ']) {
    const { d, calls } = deps();
    assertEquals((await handleRequest(post(JSON.stringify({ name: 'Toast', notes, ingredients: [] })), d)).status, 200);
    assertEquals(calls[0].notes, null);
  }
});

Deno.test('a missing or blank name, bad JSON or a bad ingredient is 400 invalid_request and never reaches the handler', async () => {
  const bodies = [
    '{not json',
    'null',
    '{}',
    JSON.stringify({ name: '', notes: null, ingredients: [] }),
    JSON.stringify({ name: '   ', notes: null, ingredients: [] }),
    JSON.stringify({ name: 5, notes: null, ingredients: [] }),
    JSON.stringify({ name: 'Toast', notes: null }),
    JSON.stringify({ name: 'Toast', notes: null, ingredients: 'bread' }),
    JSON.stringify({ name: 'Toast', notes: null, ingredients: [{ name: 'bread', quantity: '2', unit: null, note: '' }] }),
    JSON.stringify({ name: 'Toast', notes: null, ingredients: [{ name: 'bread', quantity: 2, unit: 'slice', note: '' }] }),
    JSON.stringify({ name: 'Toast', notes: 7, ingredients: [] }),
  ];
  for (const body of bodies) {
    const { d, calls } = deps();
    await expectError(await handleRequest(post(body), d), 400, 'invalid_request');
    assertEquals(calls, [], body);
  }
});

// --- Failures ------------------------------------------------------------------------------------

Deno.test('each failure maps to its status, code and Retry-After', async () => {
  const body = JSON.stringify({ name: 'Toast', notes: null, ingredients: [] });
  const cases = [
    [{ code: 'rate_limited' }, 429, 'rate_limited', null],
    [{ code: 'unavailable', reason: 'ai_off' }, 503, 'unavailable', String(PAUSED_RETRY_AFTER)],
    [{ code: 'unavailable', reason: 'ai_failed' }, 503, 'unavailable', String(AI_FAILED_RETRY_AFTER)],
  ] as const;
  for (const [failure, status, code, retryAfter] of cases) {
    const res = await handleRequest(post(body), failingDeps(failure));
    assertEquals(res.headers.get('Retry-After'), retryAfter, JSON.stringify(failure));
    await expectError(res, status, code);
  }
  assertEquals([PAUSED_RETRY_AFTER, AI_FAILED_RETRY_AFTER], [3600, 30]);
});

Deno.test('limit_reached is 429 with resets_at, the first instant of next month (UTC)', async () => {
  const d = { ...failingDeps({ code: 'limit_reached' }), now: () => Date.parse('2026-10-18T09:00:00Z') };
  const res = await handleRequest(post(JSON.stringify({ name: 'Toast', notes: null, ingredients: [] })), d);
  assertEquals(res.status, 429);
  assertEquals(res.headers.get('Retry-After'), null);
  assertEquals(await res.json(), { error: 'limit_reached', message: 'nope', resets_at: '2026-11-01T00:00:00.000Z' });
});

Deno.test('an unexpected error is a 500 internal_error', async () => {
  const { d } = deps({ suggestRecipeTags: () => Promise.reject(new Error('boom')) });
  await expectError(await handleRequest(post('{"name":"Toast","notes":null,"ingredients":[]}'), d), 500, 'internal_error');
});

// --- Protocol ---------------------------------------------------------------------------------------

Deno.test('only POST is allowed', async () => {
  const { d } = deps();
  await expectError(await handleRequest(new Request(ENDPOINT, { method: 'GET' }), d), 405, 'method_not_allowed');
});

Deno.test('a body over the cap is 413, declared or streamed', async () => {
  const { d, calls } = deps();
  await expectError(await handleRequest(post('{}', { 'content-length': String(MAX_BODY_BYTES + 1) }), d), 413, 'payload_too_large');
  const big = new TextEncoder().encode(JSON.stringify({ name: 'Toast', notes: 'x'.repeat(MAX_BODY_BYTES), ingredients: [] }));
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(big);
      c.close();
    },
  });
  await expectError(await handleRequest(post(stream), d), 413, 'payload_too_large');
  assertEquals(calls, []);
});

Deno.test('neither AI_MODEL_TAGS nor AI_MODEL_RECIPE set is a 500 not_configured; either one is enough', async () => {
  const body = '{"name":"Toast","notes":null,"ingredients":[]}';
  const none = deps({ env: () => undefined });
  await expectError(await handleRequest(post(body), none.d), 500, 'not_configured');
  assertEquals(none.calls, []);
  const recipeOnly = deps({ env: (k) => (k === 'AI_MODEL_RECIPE' ? 'mock' : undefined) });
  assertEquals((await handleRequest(post(body), recipeOnly.d)).status, 200);
});

// --- Auth -------------------------------------------------------------------------------------------

Deno.test('the deployed function answers 401 without a session, before any work', async () => {
  const saved = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'AI_MODEL_TAGS'].map((k) => [k, Deno.env.get(k)]));
  Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:1');
  Deno.env.set('SUPABASE_ANON_KEY', 'anon');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service');
  Deno.env.set('AI_MODEL_TAGS', 'mock');
  try {
    const { default: fn } = await import('./index.ts');
    const body = '{"name":"Toast","notes":null,"ingredients":[]}';
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
