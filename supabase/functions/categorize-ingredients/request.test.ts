import { OTHER_CATEGORY_ID } from '@shared/index.ts';
import { assertEquals } from '@std/assert';

import { CategorizeInputError, CategorizeLimitError, type CategorizeResponse } from './handler.ts';
import { dailyNameCap, DEFAULT_DAILY_NAME_CAP, handleRequest, MAX_BODY_BYTES, type RequestDeps } from './request.ts';

const ENDPOINT ='http://localhost/functions/v1/categorize-ingredients';
const OK: CategorizeResponse = {
  results: { milk: { status: 'categorized', category_id: OTHER_CATEGORY_ID, is_grocery_item: true } },
};

/** Deps with AI_MODEL_CATEGORIZE=mock and a categorize that records what it was called with. */
function deps(overrides: Partial<RequestDeps> = {}) {
  const calls: string[][] = [];
  const d: RequestDeps = {
    userId: 'user-1',
    categorize: async (names) => {
      calls.push(names);
      return OK;
    },
    env: (key) => (key === 'AI_MODEL_CATEGORIZE' ? 'mock' : undefined),
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

/** A body of `n` bytes whose stream doesn't declare a content-length. */
function streamOf(n: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify({ names: ['x'.repeat(n - 14)] }));
  assertEquals(bytes.byteLength, n);
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes.slice(0, 1000));
      c.enqueue(bytes.slice(1000));
      c.close();
    },
  });
}

// --- 200 ----------------------------------------------------------------------------------------

Deno.test('a valid request returns categorize’s response and passes the names through', async () => {
  const { d, calls } = deps();
  const res = await handleRequest(post(JSON.stringify({ names: ['Milk', 'eggs'] })), d);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), OK);
  assertEquals(calls, [['Milk', 'eggs']]);
});

Deno.test('an empty names array is valid', async () => {
  const { d, calls } = deps({ categorize: async () => ({ results: {} }) });
  const res = await handleRequest(post(JSON.stringify({ names: [] })), d);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { results: {} });
  assertEquals(calls, []);
});

Deno.test('exactly 100 names is accepted', async () => {
  const { d, calls } = deps();
  const names = Array.from({ length: 100 }, (_, i) => `n${i}`);
  const res = await handleRequest(post(JSON.stringify({ names })), d);
  assertEquals(res.status, 200);
  assertEquals(calls[0].length, 100);
});

Deno.test('a body of exactly 16 KB is accepted', async () => {
  const { d, calls } = deps();
  const res = await handleRequest(post(streamOf(MAX_BODY_BYTES)), d);
  assertEquals(res.status, 200);
  assertEquals(calls[0][0].length, MAX_BODY_BYTES - 14);
});

// --- 405 ----------------------------------------------------------------------------------------

for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
  Deno.test(`${method} is 405 and never categorizes`, async () => {
    const { d, calls } = deps();
    await expectError(await handleRequest(new Request(ENDPOINT, { method }), d), 405, 'method_not_allowed');
    assertEquals(calls, []);
  });
}

Deno.test('405 comes before the config check', async () => {
  const { d } = deps({ env: () => undefined });
  await expectError(await handleRequest(new Request(ENDPOINT, { method: 'GET' }), d), 405, 'method_not_allowed');
});

// --- 500 ----------------------------------------------------------------------------------------

for (const [label, value] of [['unset', undefined], ['empty', ''], ['blank', '  ']] as const) {
  Deno.test(`AI_MODEL_CATEGORIZE ${label} is a clear 500 and never categorizes`, async () => {
    const { d, calls } = deps({ env: () => value });
    const res = await handleRequest(post(JSON.stringify({ names: ['milk'] })), d);
    assertEquals(res.status, 500);
    assertEquals(await res.json(), { error: 'not_configured', message: 'AI_MODEL_CATEGORIZE is not set' });
    assertEquals(calls, []);
  });
}

Deno.test('AI_MODEL_CATEGORIZE=off is configured (the kill switch answers pending, not 500)', async () => {
  const { d, calls } = deps({ env: (key) => (key === 'AI_MODEL_CATEGORIZE' ? 'off' : undefined) });
  const res = await handleRequest(post(JSON.stringify({ names: ['milk'] })), d);
  assertEquals(res.status, 200);
  assertEquals(calls, [['milk']]);
});

Deno.test('an unexpected categorize error is a 500 that hides the message', async () => {
  const { d } = deps({
    categorize: () => Promise.reject(new Error('connection to db at 10.0.0.1 refused')),
  });
  const res = await handleRequest(post(JSON.stringify({ names: ['milk'] })), d);
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: 'internal_error', message: 'Categorization failed' });
});

Deno.test('the error log never includes the request headers or token', async () => {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const token = 'Bearer eyJhbGciOiJIUzI1NiJ9.secret-token';
    const { d } = deps({ categorize: () => Promise.reject(new Error('boom')) });
    await handleRequest(post(JSON.stringify({ names: ['milk'] }), { authorization: token }), d);
    const { d: unset } = deps({ env: () => undefined });
    await handleRequest(post(JSON.stringify({ names: ['milk'] }), { authorization: token }), unset);
    assertEquals(logged.length, 2);
    const text = JSON.stringify(logged);
    assertEquals(text.includes('secret-token'), false);
    assertEquals(text.toLowerCase().includes('authorization'), false);
  } finally {
    console.error = original;
  }
});

// --- 413 ----------------------------------------------------------------------------------------

Deno.test('a content-length over 16 KB is 413 without reading the body', async () => {
  const { d, calls } = deps();
  let pulled = false;
  const body = new ReadableStream({
    pull(c) {
      pulled = true;
      c.close();
    },
  }, { highWaterMark: 0 }); // Otherwise the stream pulls once on construction.
  const req = post(body, { 'content-length': String(MAX_BODY_BYTES + 1) });
  await expectError(await handleRequest(req, d), 413, 'payload_too_large');
  assertEquals(pulled, false);
  assertEquals(calls, []);
});

Deno.test('a body over 16 KB with no content-length is 413 from the bytes read', async () => {
  const { d, calls } = deps();
  await expectError(await handleRequest(post(streamOf(MAX_BODY_BYTES + 1)), d), 413, 'payload_too_large');
  assertEquals(calls, []);
});

Deno.test('a body over 16 KB that understates its content-length is still 413', async () => {
  const { d, calls } = deps();
  const req = post(streamOf(MAX_BODY_BYTES + 1), { 'content-length': '20' });
  await expectError(await handleRequest(req, d), 413, 'payload_too_large');
  assertEquals(calls, []);
});

// --- 400 ----------------------------------------------------------------------------------------

const badBodies: [string, string | null][] = [
  ['no body', null],
  ['not JSON', 'names=milk'],
  ['truncated JSON', '{"names": ["milk"'],
  ['JSON null', 'null'],
  ['an array instead of an object', '["milk"]'],
  ['no names', '{}'],
  ['names a string', '{"names": "milk"}'],
  ['names an object', '{"names": {"0": "milk"}}'],
  ['a number in names', '{"names": ["milk", 2]}'],
  ['null in names', '{"names": ["milk", null]}'],
  ['a nested array in names', '{"names": [["milk"]]}'],
];

for (const [label, body] of badBodies) {
  Deno.test(`400 for ${label}`, async () => {
    const { d, calls } = deps();
    await expectError(await handleRequest(post(body), d), 400, 'invalid_request');
    assertEquals(calls, []);
  });
}

Deno.test('101 names is 400 and never categorizes', async () => {
  const { d, calls } = deps();
  const names = Array.from({ length: 101 }, (_, i) => `n${i}`);
  const res = await handleRequest(post(JSON.stringify({ names })), d);
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: 'invalid_request', message: 'At most 100 names per request' });
  assertEquals(calls, []);
});

Deno.test('a CategorizeInputError from categorize is 400 with its message', async () => {
  const { d } = deps({ categorize: () => Promise.reject(new CategorizeInputError('bad names')) });
  const res = await handleRequest(post(JSON.stringify({ names: ['milk'] })), d);
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: 'invalid_request', message: 'bad names' });
});

Deno.test('413 is checked before the body is parsed', async () => {
  const { d } = deps();
  const big = 'x'.repeat(MAX_BODY_BYTES + 1); // Too big and not JSON: size wins.
  await expectError(await handleRequest(post(big), d), 413, 'payload_too_large');
});

// --- 429 / 503 ----------------------------------------------------------------------------------

Deno.test('the per-user limit is 429 with no Retry-After', async () => {
  const { d } = deps({ categorize: () => Promise.reject(new CategorizeLimitError('user_limit')) });
  const res = await handleRequest(post(JSON.stringify({ names: ['milk'] })), d);
  assertEquals(res.status, 429);
  assertEquals(res.headers.get('retry-after'), null);
  assertEquals(await res.json(), { error: 'rate_limited', message: 'Too many requests; try again later' });
});

Deno.test('the global cap is 503 with Retry-After: 3600', async () => {
  const { d } = deps({ categorize: () => Promise.reject(new CategorizeLimitError('global_cap')) });
  const res = await handleRequest(post(JSON.stringify({ names: ['milk'] })), d);
  assertEquals(res.status, 503);
  assertEquals(res.headers.get('retry-after'), '3600');
  assertEquals(res.headers.get('content-type'), 'application/json');
  assertEquals((await res.json()).error, 'daily_cap_reached');
});

Deno.test('a bad request is 400 before the rate limit is reached', async () => {
  const { d, calls } = deps({ categorize: () => Promise.reject(new CategorizeLimitError('user_limit')) });
  await expectError(await handleRequest(post('not json'), d), 400, 'invalid_request');
  assertEquals(calls, []);
});

// --- CATEGORIZE_DAILY_NAME_CAP ------------------------------------------------------------------

Deno.test('dailyNameCap reads a non-negative integer and falls back to 20,000', () => {
  assertEquals(DEFAULT_DAILY_NAME_CAP, 20_000);
  const cases: [string | undefined, number][] = [
    [undefined, 20_000],
    ['', 20_000],
    ['  ', 20_000],
    ['500', 500],
    [' 42 ', 42],
    ['0', 0],
    ['-5', 20_000],
    ['1.5', 20_000],
    ['1e3', 20_000],
    ['abc', 20_000],
    ['2147483647', 2_147_483_647],
    ['2147483648', 20_000],
  ];
  for (const [value, expected] of cases) assertEquals(dailyNameCap(value), expected, `value ${JSON.stringify(value)}`);
});
