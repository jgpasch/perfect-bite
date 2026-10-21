// The moderation call (spec 6.11) over a fake fetch: the request, the answers, and every failure.
// Nothing touches the network.
import { assertEquals, assertRejects } from '@std/assert';

import { moderateText, ModerationFailedError, moderationModelId, MODERATION_TIMEOUT_MS } from './moderation.ts';

const KEY_ENV = (key: string) => (key === 'OPENAI_API_KEY' ? 'sk-test' : undefined);

/** A fake fetch answering `status` and `body` (a string is sent as is), recording each request. */
function answering(status: number, body: unknown) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init! });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

const CLEAN = { id: 'modr-1', model: 'omni-moderation-latest', results: [{ flagged: false, categories: { violence: false, sexual: false } }] };

Deno.test('the request: POST to the moderations URL with the key, the model and the exact text', async () => {
  const fake = answering(200, CLEAN);
  const text = 'A realistic, appetizing food photograph.\n\nThe dish: Blood orange salad.';
  await moderateText(text, { env: KEY_ENV, fetch: fake.fetch });
  assertEquals(fake.sent.length, 1);
  const [{ url, init }] = fake.sent;
  assertEquals(url, 'https://api.openai.com/v1/moderations');
  assertEquals(init.method, 'POST');
  assertEquals(init.headers, { authorization: 'Bearer sk-test', 'content-type': 'application/json' });
  assertEquals(JSON.parse(String(init.body)), { model: 'omni-moderation-latest', input: text });
  assertEquals(MODERATION_TIMEOUT_MS, 10_000);
});

Deno.test('not flagged: flagged false and no categories', async () => {
  assertEquals(await moderateText('soup', { env: KEY_ENV, fetch: answering(200, CLEAN).fetch }), { flagged: false, categories: [] });
});

Deno.test('flagged: the names of the true categories, sorted', async () => {
  const body = {
    results: [{ flagged: true, categories: { violence: true, 'violence/graphic': true, harassment: false, 'self-harm': true, sexual: null } }],
  };
  assertEquals(await moderateText('x', { env: KEY_ENV, fetch: answering(200, body).fetch }), {
    flagged: true,
    categories: ['self-harm', 'violence', 'violence/graphic'],
  });
});

Deno.test('flagged with no categories object still answers flagged', async () => {
  assertEquals(await moderateText('x', { env: KEY_ENV, fetch: answering(200, { results: [{ flagged: true }] }).fetch }), { flagged: true, categories: [] });
});

Deno.test('an HTTP error throws api_error with the status and body', async () => {
  const body = { error: { message: 'Incorrect API key provided' } };
  const err = await assertRejects(() => moderateText('x', { env: KEY_ENV, fetch: answering(401, body).fetch }), ModerationFailedError);
  assertEquals([err.failure, err.httpStatus, err.body, err.message], ['api_error', 401, JSON.stringify(body), 'OpenAI answered 401: Incorrect API key provided']);
});

Deno.test('a network error throws api_error with no status', async () => {
  const fetch = (() => Promise.reject(new TypeError('connection refused'))) as typeof globalThis.fetch;
  const err = await assertRejects(() => moderateText('x', { env: KEY_ENV, fetch }), ModerationFailedError);
  assertEquals([err.failure, err.httpStatus, err.body, err.message], ['api_error', null, null, 'Request failed: connection refused']);
});

Deno.test('no answer within the timeout throws timeout', async () => {
  const fetch = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)))) as typeof globalThis.fetch;
  const err = await assertRejects(() => moderateText('x', { env: KEY_ENV, fetch, timeoutMs: 20 }), ModerationFailedError);
  assertEquals([err.failure, err.message], ['timeout', 'No moderation answer within the timeout']);
});

Deno.test('a malformed answer throws invalid_output', async () => {
  for (const body of [{}, { results: [] }, { results: [{ flagged: 'yes' }] }, { results: [{ categories: {} }] }, 'not json']) {
    const err = await assertRejects(() => moderateText('x', { env: KEY_ENV, fetch: answering(200, body).fetch }), ModerationFailedError, undefined, JSON.stringify(body));
    assertEquals(err.failure, 'invalid_output', JSON.stringify(body));
    assertEquals(err.httpStatus, 200);
  }
});

Deno.test('no key or AI_IMAGE_MODEL=off throws error and makes no call', async () => {
  const fake = answering(200, CLEAN);
  const noKey = await assertRejects(() => moderateText('x', { env: () => undefined, fetch: fake.fetch }), ModerationFailedError, 'OPENAI_API_KEY is not set');
  assertEquals(noKey.failure, 'error');
  const off = await assertRejects(
    () => moderateText('x', { env: (key) => (key === 'AI_IMAGE_MODEL' ? 'off' : KEY_ENV(key)), fetch: fake.fetch }),
    ModerationFailedError,
    'AI_IMAGE_MODEL is off',
  );
  assertEquals(off.failure, 'error');
  assertEquals(fake.sent, []);
});

Deno.test('AI_IMAGE_MODEL=mock answers not flagged with no network call and no key', async () => {
  const fake = answering(500, {});
  const env = (key: string) => (key === 'AI_IMAGE_MODEL' ? 'mock' : undefined);
  assertEquals(await moderateText('anything at all', { env, fetch: fake.fetch }), { flagged: false, categories: [] });
  assertEquals(fake.sent, []);
});

Deno.test('moderationModelId: openai:omni-moderation-latest, or mock with the mock image model', () => {
  assertEquals(moderationModelId(() => undefined), 'openai:omni-moderation-latest');
  assertEquals(moderationModelId((key) => (key === 'AI_IMAGE_MODEL' ? 'gpt-image-1' : undefined)), 'openai:omni-moderation-latest');
  assertEquals(moderationModelId((key) => (key === 'AI_IMAGE_MODEL' ? 'mock' : undefined)), 'mock');
});
