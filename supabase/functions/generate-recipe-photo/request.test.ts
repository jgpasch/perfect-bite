import type { GenerateRecipePhotoRequest } from '@shared/index.ts';
import { assertEquals } from '@std/assert';

import { GeneratePhotoError, type GenerateFailure } from './handler.ts';
import { handleRequest, type RequestDeps } from './request.ts';

const ENDPOINT = 'http://localhost/functions/v1/generate-recipe-photo';
const RECIPE_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const ENV: Record<string, string> = { AI_MODEL_PHOTO_DESCRIPTION: 'mock', AI_IMAGE_MODEL: 'mock' };

function deps(failure?: GenerateFailure, message = 'No') {
  const calls: GenerateRecipePhotoRequest[] = [];
  const d: RequestDeps = {
    generateRecipePhoto: async (request) => {
      calls.push(request);
      if (failure) throw new GeneratePhotoError(failure, message);
      return { path: `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/${RECIPE_ID}/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jpg` };
    },
    env: (key) => ENV[key],
    now: () => Date.UTC(2026, 9, 21),
  };
  return { d, calls };
}

const post = () =>
  new Request(ENDPOINT, { method: 'POST', body: JSON.stringify({ recipeId: RECIPE_ID }), headers: { 'content-type': 'application/json' } });

Deno.test('ai_photos_blocked → 403 with its code and message', async () => {
  const { d, calls } = deps({ code: 'ai_photos_blocked' }, 'AI photos are turned off for your account');
  const res = await handleRequest(post(), d);
  assertEquals(res.status, 403);
  assertEquals(res.headers.get('Retry-After'), null);
  assertEquals(await res.json(), { error: 'ai_photos_blocked', message: 'AI photos are turned off for your account' });
  assertEquals(calls, [{ recipeId: RECIPE_ID }]);
});

Deno.test('every failure maps to its status and code', async () => {
  const cases: [GenerateFailure, number, string][] = [
    [{ code: 'not_entitled' }, 403, 'not_entitled'],
    [{ code: 'ai_photos_blocked' }, 403, 'ai_photos_blocked'],
    [{ code: 'not_found' }, 404, 'not_found'],
    [{ code: 'already_generated' }, 409, 'already_generated'],
    [{ code: 'not_food', by: 'moderation' }, 422, 'not_food'],
    [{ code: 'rate_limited' }, 429, 'rate_limited'],
    [{ code: 'daily_limit' }, 429, 'daily_limit'],
    [{ code: 'limit_reached' }, 429, 'limit_reached'],
    [{ code: 'generation_failed', step: 'image' }, 502, 'generation_failed'],
    [{ code: 'unavailable', reason: 'ai_off' }, 503, 'unavailable'],
  ];
  for (const [failure, status, code] of cases) {
    const res = await handleRequest(post(), deps(failure).d);
    assertEquals(res.status, status, failure.code);
    assertEquals((await res.json()).error, code, failure.code);
  }
});

Deno.test('daily_limit is 429 with resets_at, the next UTC midnight', async () => {
  const d = { ...deps({ code: 'daily_limit' }, 'Done for today').d, now: () => Date.parse('2026-12-31T23:59:59.999Z') };
  const res = await handleRequest(post(), d);
  assertEquals(res.status, 429);
  assertEquals(res.headers.get('Retry-After'), null);
  assertEquals(await res.json(), { error: 'daily_limit', message: 'Done for today', resets_at: '2027-01-01T00:00:00.000Z' });
});

Deno.test('success → 200 with the path', async () => {
  const res = await handleRequest(post(), deps().d);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).path.endsWith('.jpg'), true);
});
