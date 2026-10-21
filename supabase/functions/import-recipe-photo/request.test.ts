// The HTTP layer of import-recipe-photo (spec 6.10): validation, the body cap and the statuses.
import type { RecipePhotoImportRequest } from '@shared/index.ts';
import { assertEquals, assertStringIncludes } from '@std/assert';

import { ImportRecipePhotoError } from './handler.ts';
import { handleRequest, MAX_BODY_BYTES, PAUSED_RETRY_AFTER } from './request.ts';

const ENDPOINT = 'http://localhost/functions/v1/import-recipe-photo';
/** The household a request names (required). */
const HOUSEHOLD = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request(ENDPOINT, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

/** Standard base64 of `n` zero bytes. */
const zeros = (n: number) => 'A'.repeat(Math.floor(n / 3) * 4) + (n % 3 === 1 ? 'AA==' : n % 3 === 2 ? 'AAA=' : '');
const jpeg = (n = 3000) => ({ mediaType: 'image/jpeg' as const, data: zeros(n) });

/** handleRequest with a fake importer that records what it got. */
function setup(env: Record<string, string> = { AI_MODEL_RECIPE: 'mock' }) {
  const got: RecipePhotoImportRequest[] = [];
  const send = (req: Request) =>
    handleRequest(req, {
      importRecipePhoto: async (request) => {
        got.push(request);
        return { name: 'Toast', sourceUrl: null, servings: null, ingredients: [], tags: null, totalMinutes: null, steps: [], stepIngredients: null, imageUrl: null };
      },
      env: (key) => env[key],
    });
  return { got, send };
}

async function expect400(res: Response, field: string) {
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, 'invalid_request');
  assertStringIncludes(body.message, field);
}

Deno.test('a valid request reaches the importer as sent, images in order', async () => {
  const { got, send } = setup();
  const images = [jpeg(10), { mediaType: 'image/png' as const, data: zeros(11) }, { mediaType: 'image/webp' as const, data: zeros(12) }];
  const res = await send(post(JSON.stringify({ images, householdId: HOUSEHOLD })));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).sourceUrl, null);
  assertEquals(got, [{ images, householdId: HOUSEHOLD }]);
});

Deno.test('householdId: a uuid reaches the importer; none (an old build) or anything else is 400 invalid_request', async () => {
  const { got, send } = setup();
  const images = [jpeg(10)];
  assertEquals((await send(post(JSON.stringify({ images, householdId: HOUSEHOLD })))).status, 200);
  assertEquals(got[0].householdId, HOUSEHOLD);
  await expect400(await send(post(JSON.stringify({ images }))), 'householdId');
  await expect400(await send(post(JSON.stringify({ images, householdId: 'h1' }))), 'householdId');
  await expect400(await send(post(JSON.stringify({ images, householdId: null }))), 'householdId');
  assertEquals(got.length, 1);
});

Deno.test('the image count: none or more than 3 is 400 invalid_request', async () => {
  const { got, send } = setup();
  await expect400(await send(post(JSON.stringify({ householdId: HOUSEHOLD, images:[] }))), 'images');
  await expect400(await send(post(JSON.stringify({ householdId: HOUSEHOLD, images:[jpeg(), jpeg(), jpeg(), jpeg()] }))), 'images');
  await expect400(await send(post(JSON.stringify({}))), 'images');
  assertEquals(got.length, 0);
});

Deno.test('an image over 2 MB decoded is 400 invalid_request, naming it; exactly 2 MB passes', async () => {
  const { got, send } = setup();
  const res = await send(post(JSON.stringify({ householdId: HOUSEHOLD, images:[jpeg(), jpeg(2 * 1024 * 1024 + 1)] })));
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: 'invalid_request', message: 'images.1.data: Image over 2 MB' });
  assertEquals((await send(post(JSON.stringify({ householdId: HOUSEHOLD, images:[jpeg(2 * 1024 * 1024)] })))).status, 200);
  assertEquals(got.length, 1);
});

Deno.test('a media type other than JPEG, PNG or WebP is 400 invalid_request', async () => {
  const { got, send } = setup();
  for (const mediaType of ['image/heic', 'image/gif', 'text/html']) {
    await expect400(await send(post(JSON.stringify({ householdId: HOUSEHOLD, images:[{ mediaType, data: zeros(10) }] }))), 'images.0.mediaType');
  }
  assertEquals(got.length, 0);
});

Deno.test('bad base64 is 400 invalid_request, without echoing the data', async () => {
  const { got, send } = setup();
  for (const data of ['not base64!', 'TWE', 'data:image/jpeg;base64,TWFu', '-_9z', '']) {
    const res = await send(post(JSON.stringify({ householdId: HOUSEHOLD, images:[{ mediaType: 'image/jpeg', data }] })));
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body, { error: 'invalid_request', message: 'images.0.data: Not base64' });
  }
  assertEquals(got.length, 0);
});

Deno.test('a body that isn’t JSON is 400 invalid_request', async () => {
  const { send } = setup();
  const res = await send(post('{"images": ['));
  assertEquals(await res.json(), { error: 'invalid_request', message: 'Body is not valid JSON' });
});

Deno.test('a body over 8 MB is 413, by Content-Length or as read', async () => {
  const { got, send } = setup();
  const declared = await send(new Request(ENDPOINT, { method: 'POST', body: '{}', headers: { 'content-length': String(MAX_BODY_BYTES + 1) } }));
  assertEquals(declared.status, 413);
  assertEquals((await declared.json()).error, 'payload_too_large');
  // Three images under the per-image cap, but over the body cap together.
  const big = JSON.stringify({ householdId: HOUSEHOLD, images:[jpeg(2_000_000), jpeg(2_000_000), jpeg(2_000_000), jpeg(400_000)] });
  const read = await send(new Request(ENDPOINT, { method: 'POST', body: big }));
  assertEquals(read.status, 413);
  assertEquals(got.length, 0);
});

Deno.test('only POST', async () => {
  const { send } = setup();
  const res = await send(new Request(ENDPOINT, { method: 'GET' }));
  assertEquals(res.status, 405);
  assertEquals((await res.json()).error, 'method_not_allowed');
});

Deno.test('neither AI_MODEL_RECIPE_PHOTO nor AI_MODEL_RECIPE set is 500 not_configured; either one is enough', async () => {
  const none = await setup({}).send(post(JSON.stringify({ householdId: HOUSEHOLD, images:[jpeg()] })));
  assertEquals(none.status, 500);
  assertEquals((await none.json()).error, 'not_configured');
  assertEquals((await setup({ AI_MODEL_RECIPE_PHOTO: 'mock' }).send(post(JSON.stringify({ householdId: HOUSEHOLD, images:[jpeg()] })))).status, 200);
  assertEquals((await setup({ AI_MODEL_RECIPE: 'off' }).send(post(JSON.stringify({ householdId: HOUSEHOLD, images:[jpeg()] })))).status, 200, 'off is the handler’s 503');
});

Deno.test('each failure’s status and body', async () => {
  const cases: [ImportRecipePhotoError, number, string, string | null][] = [
    [new ImportRecipePhotoError({ code: 'not_entitled' }, 'no'), 403, 'not_entitled', null],
    [new ImportRecipePhotoError({ code: 'not_a_recipe' }, 'no'), 422, 'not_a_recipe', null],
    [new ImportRecipePhotoError({ code: 'rate_limited' }, 'no'), 429, 'rate_limited', null],
    [new ImportRecipePhotoError({ code: 'unavailable', reason: 'ai_off' }, 'no'), 503, 'unavailable', String(PAUSED_RETRY_AFTER)],
    [new ImportRecipePhotoError({ code: 'unavailable', reason: 'ai_failed' }, 'no'), 503, 'unavailable', '30'],
  ];
  for (const [err, status, code, retryAfter] of cases) {
    const res = await handleRequest(post(JSON.stringify({ householdId: HOUSEHOLD, images:[jpeg()] })), {
      importRecipePhoto: () => Promise.reject(err),
      env: () => 'mock',
    });
    assertEquals(res.status, status, code);
    assertEquals(await res.json(), { error: code, message: 'no' });
    assertEquals(res.headers.get('Retry-After'), retryAfter, code);
  }
});

Deno.test('limit_reached is 429 with resets_at, the first instant of next month (UTC)', async () => {
  const res = await handleRequest(post(JSON.stringify({ householdId: HOUSEHOLD, images:[jpeg()] })), {
    importRecipePhoto: () => Promise.reject(new ImportRecipePhotoError({ code: 'limit_reached' }, 'no')),
    env: () => 'mock',
    now: () => Date.parse('2026-10-18T09:00:00Z'),
  });
  assertEquals(res.status, 429);
  assertEquals(res.headers.get('Retry-After'), null);
  assertEquals(await res.json(), { error: 'limit_reached', message: 'no', resets_at: '2026-11-01T00:00:00.000Z' });
});

Deno.test('daily_limit is 429 with resets_at, the next UTC midnight', async () => {
  const res = await handleRequest(post(JSON.stringify({ householdId: HOUSEHOLD, images:[jpeg()] })), {
    importRecipePhoto: () => Promise.reject(new ImportRecipePhotoError({ code: 'daily_limit' }, 'no')),
    env: () => 'mock',
    now: () => Date.parse('2026-10-31T23:59:59.999Z'),
  });
  assertEquals(res.status, 429);
  assertEquals(res.headers.get('Retry-After'), null);
  assertEquals(await res.json(), { error: 'daily_limit', message: 'no', resets_at: '2026-11-01T00:00:00.000Z' });
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
    const body = JSON.stringify({ householdId: HOUSEHOLD, images:[jpeg()] });
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
