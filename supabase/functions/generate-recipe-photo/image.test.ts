// The image call (spec 6.11) over a fake OpenAI: the request it sends, refusals, failures, the
// timeout, the mock and the kill switch. Nothing touches the network.
import { assert, assertEquals, assertFalse, assertMatch, assertNotEquals, assertRejects } from '@std/assert';

import { MOCK_RECIPE_PHOTO_JPEG } from '../_shared/fixtures/mock-recipe-photo.ts';
import {
  estimateImageCost,
  generateImage,
  hasMockRefusalWord,
  ImageFailedError,
  ImageRefusedError,
  imageModel,
  imageModelId,
  imageQuality,
  isContentPolicyError,
  isImageEnabled,
  MOCK_REFUSAL_WORD,
  OPENAI_IMAGES_URL,
  safetyIdentifierFor,
} from './image.ts';

const envOf = (vars: Record<string, string>) => (key: string) => vars[key];
const KEYED = envOf({ OPENAI_API_KEY: 'sk-test' });

type Sent = { url: string; init: RequestInit };

/** A fake fetch answering `status` and `body`, recording what it was sent. */
function fakeFetch(status: number, body: unknown) {
  const sent: Sent[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

const OK_BODY = { data: [{ b64_json: btoa(String.fromCharCode(0xff, 0xd8, 0x10, 0xff, 0xd9)) }], usage: { input_tokens: 70, output_tokens: 1584 } };

Deno.test('sends one JPEG request to the Images API with the defaults, and decodes the answer', async () => {
  const { sent, fetch } = fakeFetch(200, OK_BODY);
  const image = await generateImage('A bowl of soup', { env: KEYED, fetch });
  assertEquals(sent.length, 1);
  assertEquals(sent[0].url, OPENAI_IMAGES_URL);
  assertEquals(sent[0].init.method, 'POST');
  assertEquals((sent[0].init.headers as Record<string, string>).authorization, 'Bearer sk-test');
  assertEquals(JSON.parse(String(sent[0].init.body)), {
    model: 'gpt-image-1-mini',
    prompt: 'A bowl of soup',
    quality: 'medium',
    size: '1536x1024',
    n: 1,
    output_format: 'jpeg',
    output_compression: 80,
  });
  assertEquals([...image.bytes], [0xff, 0xd8, 0x10, 0xff, 0xd9]);
  assertEquals([image.model, image.quality], ['gpt-image-1-mini', 'medium']);
  assertEquals(image.usage, { inputTokens: 70, outputTokens: 1584 });
});

Deno.test('a safety identifier goes in the body as safety_identifier', async () => {
  const { sent, fetch } = fakeFetch(200, OK_BODY);
  await generateImage('x', { env: KEYED, fetch, safetyIdentifier: 'abc123' });
  assertEquals(JSON.parse(String(sent[0].init.body)).safety_identifier, 'abc123');
});

Deno.test('no safety identifier, or an empty one, leaves the key out of the body', async () => {
  for (const safetyIdentifier of [undefined, '']) {
    const { sent, fetch } = fakeFetch(200, OK_BODY);
    await generateImage('x', { env: KEYED, fetch, safetyIdentifier });
    assertFalse('safety_identifier' in JSON.parse(String(sent[0].init.body)), String(safetyIdentifier));
  }
});

Deno.test('safetyIdentifierFor is the lowercase hex SHA-256 of the id, the same every time', async () => {
  // sha256('abc'), the FIPS 180-2 test vector.
  assertEquals(await safetyIdentifierFor('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const id = '11111111-1111-4111-8111-111111111111';
  const hash = await safetyIdentifierFor(id);
  assertMatch(hash, /^[0-9a-f]{64}$/);
  assertEquals(await safetyIdentifierFor(id), hash);
  assertNotEquals(await safetyIdentifierFor('22222222-2222-4222-8222-222222222222'), hash);
});

Deno.test('AI_IMAGE_MODEL and AI_IMAGE_QUALITY change the request; an unknown quality is medium', async () => {
  const { sent, fetch } = fakeFetch(200, OK_BODY);
  await generateImage('x', { env: envOf({ OPENAI_API_KEY: 'k', AI_IMAGE_MODEL: 'gpt-image-1', AI_IMAGE_QUALITY: 'low' }), fetch });
  const body = JSON.parse(String(sent[0].init.body));
  assertEquals([body.model, body.quality], ['gpt-image-1', 'low']);
  assertEquals(imageQuality(envOf({ AI_IMAGE_QUALITY: 'ultra' })), 'medium');
  assertEquals(imageModel(envOf({ AI_IMAGE_MODEL: '  ' })), 'gpt-image-1-mini');
});

Deno.test('a moderation refusal is ImageRefusedError', async () => {
  const blocked = fakeFetch(400, { error: { code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' } });
  await assertRejects(() => generateImage('x', { env: KEYED, fetch: blocked.fetch }), ImageRefusedError);
  const policy = fakeFetch(400, { error: { code: null, type: 'invalid_request_error', message: 'This request violates our content policy.' } });
  await assertRejects(() => generateImage('x', { env: KEYED, fetch: policy.fetch }), ImageRefusedError);
});

Deno.test('any other error is ImageFailedError: an HTTP error, no image, bad JSON, a network error', async () => {
  for (const [status, body] of [
    [500, { error: { message: 'server error' } }],
    [429, { error: { code: 'rate_limit_exceeded', message: 'slow down' } }],
    [200, { data: [] }],
    [200, 'not json at all'],
  ] as const) {
    const { fetch } = fakeFetch(status, body);
    await assertRejects(() => generateImage('x', { env: KEYED, fetch }), ImageFailedError, undefined, `${status} ${JSON.stringify(body)}`);
  }
  const broken = (async () => {
    throw new TypeError('connection reset');
  }) as typeof globalThis.fetch;
  await assertRejects(() => generateImage('x', { env: KEYED, fetch: broken }), ImageFailedError, 'connection reset');
});

Deno.test('no answer within the timeout is ImageFailedError', async () => {
  const hanging = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      const signal = init!.signal!;
      signal.addEventListener('abort', () => reject(signal.reason));
    })) as typeof globalThis.fetch;
  await assertRejects(() => generateImage('x', { env: KEYED, fetch: hanging, timeoutMs: 20 }), ImageFailedError, 'timeout');
});

Deno.test('mock answers the fixed JPEG with no network call or key; off and a missing key fail', async () => {
  const { sent, fetch } = fakeFetch(200, OK_BODY);
  const image = await generateImage('x', { env: envOf({ AI_IMAGE_MODEL: 'mock' }), fetch });
  assertEquals(sent, []);
  assertEquals(image.bytes, MOCK_RECIPE_PHOTO_JPEG);
  assertEquals([image.model, image.usage], ['mock', null]);
  await assertRejects(() => generateImage('x', { env: envOf({ AI_IMAGE_MODEL: 'off', OPENAI_API_KEY: 'k' }), fetch }), ImageFailedError);
  await assertRejects(() => generateImage('x', { env: envOf({}), fetch }), ImageFailedError, 'OPENAI_API_KEY');
  assertEquals(sent, []);
  assertEquals(isImageEnabled(envOf({ AI_IMAGE_MODEL: 'off' })), false);
  assertEquals(isImageEnabled(envOf({})), true);
});

Deno.test('the mock refuses a prompt with refuse-me, in any case, and makes a photo otherwise', async () => {
  const { sent, fetch } = fakeFetch(200, OK_BODY);
  const env = envOf({ AI_IMAGE_MODEL: 'mock' });
  for (const prompt of ['The dish: refuse-me pasta.', 'The dish: Refuse-Me pasta.']) {
    const err = await assertRejects(() => generateImage(prompt, { env, fetch }), ImageRefusedError);
    assertEquals([err.message, err.httpStatus, err.body], ['Refused: moderation_blocked (mock)', null, null]);
  }
  const image = await generateImage('The dish: refuse pasta, me.', { env, fetch });
  assertEquals(image.bytes, MOCK_RECIPE_PHOTO_JPEG);
  assertEquals(sent, []);
  assertEquals(MOCK_REFUSAL_WORD, 'refuse-me');
  assert(hasMockRefusalWord('xREFUSE-MEx'));
  assertFalse(hasMockRefusalWord('refuse_me'));
});

Deno.test('a real model sends refuse-me on to OpenAI like any prompt', async () => {
  const { sent, fetch } = fakeFetch(200, OK_BODY);
  await generateImage('refuse-me', { env: KEYED, fetch });
  assertEquals(sent.length, 1);
});

Deno.test('the mock JPEG is a small baseline JPEG', () => {
  const bytes = MOCK_RECIPE_PHOTO_JPEG;
  assertEquals([bytes[0], bytes[1]], [0xff, 0xd8], 'starts with SOI');
  assertEquals([bytes.at(-2), bytes.at(-1)], [0xff, 0xd9], 'ends with EOI');
  const sof = bytes.findIndex((b, i) => b === 0xff && bytes[i + 1] === 0xc0);
  assert(sof > 0, 'has a baseline frame header');
  assertEquals((bytes[sof + 5] << 8) | bytes[sof + 6], 48, 'height');
  assertEquals((bytes[sof + 7] << 8) | bytes[sof + 8], 64, 'width');
  assert(bytes.length < 300);
});

/** The error `generateImage` rejects with. */
async function rejection(options: Parameters<typeof generateImage>[1]): Promise<ImageFailedError | ImageRefusedError> {
  try {
    await generateImage('x', options);
  } catch (err) {
    if (err instanceof ImageFailedError || err instanceof ImageRefusedError) return err;
    throw err;
  }
  throw new Error('expected a rejection');
}

Deno.test('a refusal carries the HTTP status and the body as sent', async () => {
  const body = { error: { code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' } };
  const err = await rejection({ env: KEYED, fetch: fakeFetch(400, body).fetch });
  assert(err instanceof ImageRefusedError);
  assertEquals([err.httpStatus, err.body], [400, JSON.stringify(body)]);
});

Deno.test('each failure carries its ai_calls status, and the HTTP status and body when OpenAI answered', async () => {
  const serverError = { error: { message: 'server error' } };
  const http = await rejection({ env: KEYED, fetch: fakeFetch(500, serverError).fetch });
  assert(http instanceof ImageFailedError);
  assertEquals([http.failure, http.httpStatus, http.body], ['api_error', 500, JSON.stringify(serverError)]);

  const plain = (async () => new Response('Bad gateway', { status: 502 })) as typeof globalThis.fetch;
  const notJson = await rejection({ env: KEYED, fetch: plain });
  assert(notJson instanceof ImageFailedError);
  assertEquals([notJson.failure, notJson.httpStatus, notJson.body], ['api_error', 502, 'Bad gateway']);

  const empty = (async () => new Response('', { status: 503 })) as typeof globalThis.fetch;
  const noBody = await rejection({ env: KEYED, fetch: empty });
  assertEquals([noBody.httpStatus, noBody.body], [503, null]);

  // A 200 never keeps its body: it would hold the image.
  for (const okBody of [{ data: [] }, { data: [{ b64_json: '***not base64***' }] }]) {
    const invalid = await rejection({ env: KEYED, fetch: fakeFetch(200, okBody).fetch });
    assert(invalid instanceof ImageFailedError);
    assertEquals([invalid.failure, invalid.httpStatus, invalid.body], ['invalid_output', null, null], JSON.stringify(okBody));
  }

  const broken = (async () => {
    throw new TypeError('connection reset');
  }) as typeof globalThis.fetch;
  const network = await rejection({ env: KEYED, fetch: broken });
  assert(network instanceof ImageFailedError);
  assertEquals([network.failure, network.httpStatus, network.body], ['api_error', null, null]);

  const hanging = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)))) as typeof globalThis.fetch;
  const timeout = await rejection({ env: KEYED, fetch: hanging, timeoutMs: 20 });
  assert(timeout instanceof ImageFailedError);
  assertEquals([timeout.failure, timeout.httpStatus, timeout.body], ['timeout', null, null]);

  for (const env of [envOf({ AI_IMAGE_MODEL: 'off', OPENAI_API_KEY: 'k' }), envOf({})]) {
    const other = await rejection({ env });
    assert(other instanceof ImageFailedError);
    assertEquals([other.failure, other.httpStatus, other.body], ['error', null, null]);
  }
});

Deno.test('imageModelId names the model as the other ai_calls rows do', () => {
  assertEquals(imageModelId('gpt-image-1-mini'), 'openai:gpt-image-1-mini');
  assertEquals(imageModelId('mock'), 'mock');
});

Deno.test('isContentPolicyError and estimateImageCost', () => {
  assert(isContentPolicyError({ code: 'moderation_blocked' }));
  assert(isContentPolicyError({ code: 'content_policy_violation' }));
  assert(!isContentPolicyError({ code: 'rate_limit_exceeded', message: 'Too many requests' }));
  assert(!isContentPolicyError(null));
  // About a cent for a medium 1536×1024 image on mini.
  assertEquals(estimateImageCost({ model: 'gpt-image-1-mini', usage: { inputTokens: 100, outputTokens: 1584 } }), (100 * 2 + 1584 * 8) / 1_000_000);
  assertEquals(estimateImageCost({ model: 'gpt-image-1', usage: { inputTokens: 1, outputTokens: 1 } }), null);
  assertEquals(estimateImageCost({ model: 'gpt-image-1-mini', usage: null }), null);
});
