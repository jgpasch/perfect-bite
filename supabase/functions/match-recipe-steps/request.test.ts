import type { MatchRecipeStepsRequest, MatchRecipeStepsResponse } from '@shared/index.ts';
import { assertEquals, assertStringIncludes } from '@std/assert';

import { MatchStepsError, type MatchStepsFailure } from './handler.ts';
import {
  AI_FAILED_RETRY_AFTER,
  handleRequest,
  MAX_BODY_BYTES,
  PAUSED_RETRY_AFTER,
  type RequestDeps,
} from './request.ts';

const ENDPOINT = 'http://localhost/functions/v1/match-recipe-steps';
const OK: MatchRecipeStepsResponse = { steps: [[{ id: 'a', quantity: null }]], promptVersion: 'match-recipe-steps.v1' };

/** Deps with AI_MODEL_STEPS=mock and a matchSteps that records what it was called with. */
function deps(overrides: Partial<RequestDeps> = {}) {
  const calls: MatchRecipeStepsRequest[] = [];
  const d: RequestDeps = {
    matchSteps: async (request) => {
      calls.push(request);
      return OK;
    },
    env: (key) => (key === 'AI_MODEL_STEPS' ? 'mock' : undefined),
    ...overrides,
  };
  return { d, calls };
}

const failingDeps = (failure: MatchStepsFailure) => deps({ matchSteps: () => Promise.reject(new MatchStepsError(failure, 'nope')) }).d;

const post = (body: BodyInit | null, headers: HeadersInit = {}) =>
  new Request(ENDPOINT, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

async function expectError(res: Response, status: number, code: string) {
  assertEquals(res.status, status);
  assertEquals((await res.json()).error, code);
}

const ingredient = (id: string, name: string) => ({ id, name, quantity: 1, unit: null, note: '' });
const SIMPLE = JSON.stringify({ steps: ['Toast the bread.'], ingredients: [ingredient('a', 'bread')] });

// --- 200 and validation -------------------------------------------------------------------------

Deno.test('a valid request returns the response and passes the parsed, trimmed request through', async () => {
  const { d, calls } = deps();
  const body = {
    steps: ['  Toast the bread. ', '', 'Butter it.'],
    ingredients: [
      { id: 'a', name: ' bread ', quantity: 2, unit: null, note: ' sliced ' },
      { id: 'b', name: 'butter', quantity: 1, unit: 'tbsp' },
    ],
  };
  const res = await handleRequest(post(JSON.stringify(body)), d);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), OK);
  assertEquals(calls, [
    {
      steps: ['Toast the bread.', '', 'Butter it.'],
      ingredients: [
        { id: 'a', name: 'bread', quantity: 2, unit: null, note: 'sliced' },
        { id: 'b', name: 'butter', quantity: 1, unit: 'tbsp', note: '' },
      ],
    },
  ]);
});

Deno.test('long text is cut, not refused: steps to 2,000 characters, ingredient names to 64', async () => {
  const { d, calls } = deps();
  const body = { steps: [`${'é'.repeat(2_500)}`], ingredients: [ingredient('a', 'x'.repeat(100))] };
  assertEquals((await handleRequest(post(JSON.stringify(body)), d)).status, 200);
  assertEquals(Array.from(calls[0].steps[0]).length, 2_000);
  assertEquals(calls[0].ingredients[0].name.length, 64);
});

Deno.test('ingredients with an empty name are dropped first, then cut to the first 80', async () => {
  const { d, calls } = deps();
  const ingredients = [ingredient('blank', ' '), ...Array.from({ length: 90 }, (_, i) => ingredient(`id-${i}`, `item ${i}`))];
  assertEquals((await handleRequest(post(JSON.stringify({ steps: ['Mix.'], ingredients })), d)).status, 200);
  assertEquals(calls[0].ingredients.length, 80);
  assertEquals(calls[0].ingredients[0].id, 'id-0');
  assertEquals(calls[0].ingredients[79].id, 'id-79');
});

Deno.test('a bad request is 400 invalid_request and never reaches the handler', async () => {
  const { d, calls } = deps();
  const bread = [ingredient('a', 'bread')];
  const cases: [string, string][] = [
    ['not json', 'not valid JSON'],
    [JSON.stringify({ steps: [], ingredients: bread }), 'steps'],
    [JSON.stringify({ steps: [' ', ''], ingredients: bread }), 'at least one step'],
    [JSON.stringify({ steps: Array.from({ length: 101 }, () => 'Stir.'), ingredients: bread }), 'steps'],
    [JSON.stringify({ steps: ['Stir.'], ingredients: [] }), 'at least one ingredient'],
    [JSON.stringify({ steps: ['Stir.'], ingredients: [ingredient('a', ' ')] }), 'at least one ingredient'],
    [JSON.stringify({ steps: ['Stir.'], ingredients: [ingredient('a', 'salt'), ingredient('a', 'pepper')] }), 'unique'],
    [JSON.stringify({ steps: ['Stir.'], ingredients: [{ name: 'salt', quantity: null, unit: null }] }), 'ingredients.0.id'],
    [JSON.stringify({ steps: ['Stir.'], ingredients: [ingredient('', 'salt')] }), 'ingredients.0.id'],
    [JSON.stringify({ steps: ['Stir.'], ingredients: [ingredient('x'.repeat(65), 'salt')] }), 'ingredients.0.id'],
    [JSON.stringify({ steps: ['Stir.'], ingredients: [{ ...ingredient('a', 'salt'), unit: 'bushel' }] }), 'ingredients.0.unit'],
    [JSON.stringify({ steps: 'Stir.', ingredients: bread }), 'steps'],
  ];
  for (const [body, message] of cases) {
    const res = await handleRequest(post(body), d);
    assertEquals(res.status, 400, body.slice(0, 80));
    const json = await res.json();
    assertEquals(json.error, 'invalid_request');
    assertStringIncludes(json.message, message, body.slice(0, 80));
  }
  assertEquals(calls, []);
});

Deno.test('100 steps are allowed', async () => {
  const { d, calls } = deps();
  const body = { steps: Array.from({ length: 100 }, (_, i) => `Step ${i + 1}.`), ingredients: [ingredient('a', 'salt')] };
  assertEquals((await handleRequest(post(JSON.stringify(body)), d)).status, 200);
  assertEquals(calls[0].steps.length, 100);
});

// --- Failures ------------------------------------------------------------------------------------

Deno.test('each failure maps to its status, code and Retry-After', async () => {
  const cases = [
    [{ code: 'not_entitled' }, 403, 'not_entitled', null],
    [{ code: 'rate_limited' }, 429, 'rate_limited', null],
    [{ code: 'unavailable', reason: 'ai_off' }, 503, 'unavailable', String(PAUSED_RETRY_AFTER)],
    [{ code: 'unavailable', reason: 'ai_failed' }, 503, 'unavailable', String(AI_FAILED_RETRY_AFTER)],
  ] as const;
  for (const [failure, status, code, retryAfter] of cases) {
    const res = await handleRequest(post(SIMPLE), failingDeps(failure));
    assertEquals(res.headers.get('Retry-After'), retryAfter, JSON.stringify(failure));
    await expectError(res, status, code);
  }
  assertEquals([PAUSED_RETRY_AFTER, AI_FAILED_RETRY_AFTER], [3600, 30]);
});

Deno.test('an unexpected error is a 500 internal_error', async () => {
  const { d } = deps({ matchSteps: () => Promise.reject(new Error('boom')) });
  await expectError(await handleRequest(post(SIMPLE), d), 500, 'internal_error');
});

// --- Protocol ---------------------------------------------------------------------------------------

Deno.test('only POST is allowed', async () => {
  const { d } = deps();
  await expectError(await handleRequest(new Request(ENDPOINT, { method: 'GET' }), d), 405, 'method_not_allowed');
});

Deno.test('a body over 256 KB is 413, declared or streamed', async () => {
  const { d, calls } = deps();
  assertEquals(MAX_BODY_BYTES, 256 * 1024);
  await expectError(await handleRequest(post('{}', { 'content-length': String(MAX_BODY_BYTES + 1) }), d), 413, 'payload_too_large');
  const big = new TextEncoder().encode(JSON.stringify({ steps: ['x'.repeat(MAX_BODY_BYTES)], ingredients: [ingredient('a', 'salt')] }));
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(big);
      c.close();
    },
  });
  await expectError(await handleRequest(post(stream), d), 413, 'payload_too_large');
  assertEquals(calls, []);
});

Deno.test('neither AI_MODEL_STEPS nor AI_MODEL_RECIPE set is a 500 not_configured; either one is enough', async () => {
  const none = deps({ env: () => undefined });
  await expectError(await handleRequest(post(SIMPLE), none.d), 500, 'not_configured');
  assertEquals(none.calls, []);
  const recipeOnly = deps({ env: (k) => (k === 'AI_MODEL_RECIPE' ? 'mock' : undefined) });
  assertEquals((await handleRequest(post(SIMPLE), recipeOnly.d)).status, 200);
});

// --- Auth -------------------------------------------------------------------------------------------

Deno.test('the deployed function answers 401 without a session, before any work', async () => {
  const saved = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'AI_MODEL_STEPS'].map((k) => [k, Deno.env.get(k)]));
  Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:1');
  Deno.env.set('SUPABASE_ANON_KEY', 'anon');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service');
  Deno.env.set('AI_MODEL_STEPS', 'mock');
  try {
    const { default: fn } = await import('./index.ts');
    const res = await fn.fetch(post(SIMPLE));
    assertEquals(res.status, 401);
    await res.body?.cancel();
    const bad = await fn.fetch(post(SIMPLE, { authorization: 'Bearer not-a-jwt' }));
    assertEquals(bad.status, 401);
    await bad.body?.cancel();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
