// generate-recipe-photo (spec 6.11) end to end through handleRequest, with a fake store, the mock
// or a MockLanguageModelV4 for the description, and a fake image call. Nothing touches the network.
import { assert, assertEquals, assertFalse, assertMatch, assertNotEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { APICallError, type LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { MOCK_PHOTO_DESCRIPTION } from '../_shared/ai/mock-model.ts';
import { RECIPE_PHOTO_DESCRIPTION_PROMPT_VERSION } from '../_shared/ai/prompts/recipe-photo-description.v1.ts';
import { RECIPE_PHOTO_IMAGE_PROMPT_VERSION } from '../_shared/ai/prompts/recipe-photo-image.v1.ts';
import type { AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { NotEntitledError, type Feature } from '../_shared/entitlements.ts';
import { generateRecipePhoto, GeneratePhotoError, type GenerateDeps, type RecipePhotoStore, type ReserveResult, type StoredRecipe } from './handler.ts';
import { generateImage as realGenerateImage, ImageFailedError, ImageRefusedError, safetyIdentifierFor, type GeneratedImage, type ImageOptions } from './image.ts';
import { ModerationFailedError, moderateText, type ModerationResult } from './moderation.ts';
import { handleRequest, PAUSED_RETRY_AFTER } from './request.ts';

const ENDPOINT = 'http://localhost/functions/v1/generate-recipe-photo';
const RECIPE_ID = '6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';
const HOUSEHOLD_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const PHOTO_ID = '0b9c8d7e-6f5a-4b3c-2d1e-0f9a8b7c6d5e';
const ENV_KEYS = [
  'AI_MODEL_PHOTO_DESCRIPTION',
  'AI_MODEL_PHOTO_DESCRIPTION_FALLBACK',
  'AI_MODEL_TAGS',
  'AI_MODEL_TAGS_FALLBACK',
  'AI_MODEL_RECIPE',
  'AI_MODEL_RECIPE_FALLBACK',
];

/** Runs `fn` with exactly these AI env vars set, restoring the old values afterwards. */
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, Deno.env.get(k)]));
  for (const k of ENV_KEYS) Deno.env.delete(k);
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const TACOS: StoredRecipe = {
  name: 'Grandma’s Fish Tacos',
  ingredients: ['cod fillets', 'corn tortillas', 'red cabbage', 'lime'],
  tags: { saved: ['favorite'], meal: ['dinner'], cuisine: ['mexican'], protein: ['fish'], diet: [], method: [] },
};

class FakeStore implements RecipePhotoStore {
  /** Every step, in order: `household`, `feature:<name>`, `reserve`, `read`, `ai_call`, `upload:<path>`, `complete`, `release`. */
  steps: string[] = [];
  aiCalls: AiCallRecord[] = [];
  /** The live recipe's household; null when it's gone. */
  household: string | null = HOUSEHOLD_ID;
  features = new Set<Feature>(['recipe_photo_ai']);
  /** The household each plan check was for. */
  featureHouseholds: string[] = [];
  reservation: ReserveResult = { status: 'ok', householdId: HOUSEHOLD_ID };
  recipe: StoredRecipe | null = TACOS;
  uploads: { path: string; bytes: Uint8Array }[] = [];
  completed: { recipeId: string; description: string; path: string }[] = [];
  completeAnswer = true;
  failUpload = false;
  /** complete throws this, when set. */
  completeError: Error | null = null;
  removed: string[] = [];
  failRemove = false;

  async recipeHousehold(recipeId: string) {
    this.steps.push('household');
    assertEquals(recipeId, RECIPE_ID);
    return this.household;
  }
  async requireFeature(feature: Feature, householdId: string) {
    this.steps.push(`feature:${feature}`);
    this.featureHouseholds.push(householdId);
    if (!this.features.has(feature)) throw new NotEntitledError(feature);
  }
  async reserve(_recipeId: string) {
    this.steps.push('reserve');
    return this.reservation;
  }
  async readRecipe(recipeId: string, householdId: string) {
    this.steps.push('read');
    assertEquals([recipeId, householdId], [RECIPE_ID, HOUSEHOLD_ID]);
    return this.recipe;
  }
  async upload(path: string, bytes: Uint8Array) {
    this.steps.push(`upload:${path}`);
    if (this.failUpload) throw new Error('storage down');
    this.uploads.push({ path, bytes });
  }
  async complete(recipeId: string, description: string, path: string) {
    this.steps.push('complete');
    if (this.completeError) throw this.completeError;
    this.completed.push({ recipeId, description, path });
    return this.completeAnswer;
  }
  async remove(path: string) {
    this.steps.push(`remove:${path}`);
    if (this.failRemove) throw new Error('storage down');
    this.removed.push(path);
  }
  async release(_recipeId: string) {
    this.steps.push('release');
  }
  async logAiCall(call: AiCallRecord) {
    this.steps.push('ai_call');
    this.aiCalls.push(call);
  }
}

const JPEG = Uint8Array.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);

/** A fake image call that records each prompt and its options and answers `JPEG`, or throws `error`. */
function fakeImage(error?: Error) {
  const prompts: string[] = [];
  const options: Pick<ImageOptions, 'safetyIdentifier'>[] = [];
  const generate = async (prompt: string, given: Pick<ImageOptions, 'safetyIdentifier'>): Promise<GeneratedImage> => {
    prompts.push(prompt);
    options.push(given);
    if (error) throw error;
    return { bytes: JPEG, model: 'gpt-image-1-mini', quality: 'medium', ms: 5, usage: { inputTokens: 60, outputTokens: 1584 } };
  };
  return { prompts, options, generate };
}

/** A description model answering every call with `answer`. */
function answering(answer: unknown): { instance: LanguageModel; modelId: string } {
  return {
    instance: new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: JSON.stringify(answer) }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
    }),
    modelId: 'test:answering',
  };
}

function failing(error: Error): { instance: LanguageModel; modelId: string } {
  return {
    instance: new MockLanguageModelV4({
      doGenerate: async () => {
        throw error;
      },
    }),
    modelId: 'test:failing',
  };
}

const apiError = () => new APICallError({ message: 'overloaded', url: 'https://x', requestBodyValues: {}, statusCode: 503, isRetryable: false });

const post = (body: unknown) => new Request(ENDPOINT, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

const USER_ID = '11111111-1111-4111-8111-111111111111';

/** A fake moderation check that records each text and answers `answer`, or throws `error`. */
function fakeModeration(answer: ModerationResult = { flagged: false, categories: [] }, error?: Error) {
  const texts: string[] = [];
  const moderate = async (text: string): Promise<ModerationResult> => {
    texts.push(text);
    if (error) throw error;
    return answer;
  };
  return { texts, moderate };
}

type Setup = {
  store?: FakeStore;
  image?: { prompts: string[]; generate: NonNullable<GenerateDeps['generateImage']> };
  /** The moderation check; not flagged unless set. */
  moderation?: { texts: string[]; moderate: NonNullable<GenerateDeps['moderate']> };
  model?: GenerateDeps['model'];
  env?: Record<string, string>;
  /** The signed-in caller; USER_ID unless set (null for none). */
  userId?: string | null;
};

/** POSTs `{ recipeId }` through handleRequest with the fakes; the env defaults to the mock description and an image key. */
async function call(setup: Setup = {}, body: unknown = { recipeId: RECIPE_ID }) {
  const store = setup.store ?? new FakeStore();
  const image = setup.image ?? fakeImage();
  const moderation = setup.moderation ?? fakeModeration();
  const env = { OPENAI_API_KEY: 'sk-test', AI_MODEL_PHOTO_DESCRIPTION: 'mock', ...setup.env };
  const read = (key: string) => (env as Record<string, string | undefined>)[key];
  const userId = setup.userId === undefined ? USER_ID : (setup.userId ?? undefined);
  const res = await handleRequest(post(body), {
    env: read,
    generateRecipePhoto: (request) =>
      generateRecipePhoto(request, {
        store,
        userId,
        model: setup.model,
        generateImage: image.generate,
        moderate: moderation.moderate,
        newId: () => PHOTO_ID,
        env: read,
      }),
    now: () => Date.parse('2026-10-18T12:00:00Z'),
  });
  return { res, json: await res.json(), store, image, moderation };
}

// --- success ----------------------------------------------------------------------------------------

Deno.test('success: reads the recipe, describes it, makes the image, uploads it to the photo_path shape and completes', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { res, json, store, image } = await call();
    const path = `${HOUSEHOLD_ID}/${RECIPE_ID}/${PHOTO_ID}.jpg`;
    assertEquals(res.status, 200);
    assertEquals(json, { path });
    assertEquals(store.steps, ['household', 'feature:recipe_photo_ai', 'reserve', 'read', 'ai_call', 'ai_call', 'ai_call', `upload:${path}`, 'complete']);
    assertEquals(store.uploads, [{ path, bytes: JPEG }]);
    assertEquals(store.completed, [{ recipeId: RECIPE_ID, description: MOCK_PHOTO_DESCRIPTION, path }]);
    assertEquals(image.prompts.length, 1);
    assertStringIncludes(image.prompts[0], MOCK_PHOTO_DESCRIPTION);
    assertEquals(store.aiCalls[0].task, 'recipePhotoDescription');
    assertEquals(store.aiCalls[0].prompt_version, RECIPE_PHOTO_DESCRIPTION_PROMPT_VERSION);
  });
});

Deno.test("every ai_calls row carries the caller and the recipe's household", async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { res, store } = await call();
    assertEquals(res.status, 200);
    assertEquals(store.aiCalls.map((c) => [c.task, c.user_id, c.household_id]), [
      ['recipePhotoDescription', USER_ID, HOUSEHOLD_ID],
      ['recipePhotoModeration', USER_ID, HOUSEHOLD_ID],
      ['recipePhotoImage', USER_ID, HOUSEHOLD_ID],
    ]);
  });
});

Deno.test('a failed description is logged with the caller and household too', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { res, store } = await call({ model: answering({ nope: true }) });
    assertEquals(res.status, 502);
    assertEquals(store.aiCalls.map((c) => [c.status, c.user_id, c.household_id]), [['invalid_output', USER_ID, HOUSEHOLD_ID]]);
  });
});

Deno.test('with no caller the rows have a null user and household', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { store } = await call({ userId: null });
    assertEquals(store.aiCalls.map((c) => [c.user_id, c.household_id]), [
      [null, null],
      [null, null],
      [null, null],
    ]);
  });
});

// --- the safety identifier ------------------------------------------------------------------------------

const OK_IMAGE = { data: [{ b64_json: btoa(String.fromCharCode(...JPEG)) }] };

Deno.test("the image call carries the SHA-256 of the caller's id as safety_identifier, never the id", async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const image = openAi(200, OK_IMAGE);
    const { res } = await call({ image });
    assertEquals(res.status, 200);
    const identifier = image.sent[0].safety_identifier;
    assertEquals(identifier, await safetyIdentifierFor(USER_ID));
    assertMatch(String(identifier), /^[0-9a-f]{64}$/);
    assertNotEquals(identifier, USER_ID);
    assertFalse(JSON.stringify(image.sent[0]).includes(USER_ID));
  });
});

Deno.test('the safety identifier is the same for the same caller across calls', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const image = fakeImage();
    await call({ image });
    await call({ image });
    assertEquals(image.options.length, 2);
    assertEquals(image.options[0], image.options[1]);
    assertEquals(image.options[0].safetyIdentifier, await safetyIdentifierFor(USER_ID));
  });
});

Deno.test('with no caller the image call has no safety identifier', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const image = openAi(200, OK_IMAGE);
    const { res } = await call({ image, userId: null });
    assertEquals(res.status, 200);
    assertFalse('safety_identifier' in image.sent[0]);
  });
});

// --- the image call's ai_calls row ----------------------------------------------------------------------

const IMAGE_PATH = `${HOUSEHOLD_ID}/${RECIPE_ID}/${PHOTO_ID}.jpg`;

/** The real image call over a fake OpenAI answering `status` and `body` (a string is sent as is), recording the request bodies. */
function openAi(status: number, body: unknown, timeoutMs?: number) {
  const prompts: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const generate = (prompt: string, options: Pick<ImageOptions, 'safetyIdentifier'>) => {
    prompts.push(prompt);
    return realGenerateImage(prompt, { env: (key) => (key === 'OPENAI_API_KEY' ? 'sk-test' : undefined), fetch, timeoutMs, ...options });
  };
  return { prompts, sent, generate };
}

/** A fake OpenAI that never answers, so the real image call times out. */
function hangingOpenAi() {
  const prompts: string[] = [];
  const fetch = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)))) as typeof globalThis.fetch;
  const generate = (prompt: string) => {
    prompts.push(prompt);
    return realGenerateImage(prompt, { env: (key) => (key === 'OPENAI_API_KEY' ? 'sk-test' : undefined), fetch, timeoutMs: 20 });
  };
  return { prompts, generate };
}

Deno.test('a generated photo logs the description row and an ok image row linked to it, both with the recipe', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { res, store, image } = await call();
    assertEquals(res.status, 200);
    const [description, , imageRow] = store.aiCalls;
    assertEquals(store.aiCalls.length, 3);
    assertEquals([description.task, description.status, description.recipe_id], ['recipePhotoDescription', 'ok', RECIPE_ID]);
    assertEquals(imageRow, {
      id: imageRow.id,
      user_id: USER_ID,
      household_id: HOUSEHOLD_ID,
      recipe_id: RECIPE_ID,
      task: 'recipePhotoImage',
      model: 'openai:gpt-image-1-mini',
      prompt_version: RECIPE_PHOTO_IMAGE_PROMPT_VERSION,
      status: 'ok',
      instructions: '',
      prompt: image.prompts[0],
      output: { quality: 'medium', path: IMAGE_PATH },
      response_text: null,
      finish_reason: null,
      raw_finish_reason: null,
      provider_metadata: null,
      input_tokens: 60,
      output_tokens: 1584,
      cached_input_tokens: null,
      reasoning_tokens: null,
      duration_ms: imageRow.duration_ms,
      error: null,
      http_status: null,
      error_body: null,
      fallback_of: description.id,
    });
    assert(imageRow.id !== description.id);
    assert(imageRow.duration_ms >= 0);
  });
});

Deno.test("an upper-case recipe id is lowercased in both rows' recipe_id", async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { store } = await call({}, { recipeId: RECIPE_ID.toUpperCase() });
    assertEquals(store.aiCalls.map((c) => c.recipe_id), [RECIPE_ID, RECIPE_ID, RECIPE_ID]);
  });
});

Deno.test('the mock image model logs an ok row too, named mock, with no tokens', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const store = new FakeStore();
    const env = (key: string) => (key === 'AI_IMAGE_MODEL' ? 'mock' : undefined);
    const answer = await generateRecipePhoto({ recipeId: RECIPE_ID }, { store, userId: USER_ID, newId: () => PHOTO_ID, env });
    assertEquals(answer, { path: IMAGE_PATH });
    const moderationRow = store.aiCalls[1];
    assertEquals([moderationRow.task, moderationRow.model, moderationRow.status, moderationRow.output], ['recipePhotoModeration', 'mock', 'ok', { flagged: false, categories: [] }]);
    const row = store.aiCalls[2];
    assertEquals([row.task, row.model, row.status, row.input_tokens, row.output_tokens], ['recipePhotoImage', 'mock', 'ok', null, null]);
    assertEquals(row.output, { quality: 'medium', path: IMAGE_PATH });
  });
});

// --- the mock refusal word (testing blocks by hand) --------------------------------------------------

const REFUSE_ME: StoredRecipe = { ...TACOS, name: 'refuse-me pasta' };
const MOCK_IMAGE_ENV = (key: string) => (key === 'AI_IMAGE_MODEL' ? 'mock' : undefined);

Deno.test('with the mock models, a title with refuse-me is flagged by moderation: a refused row, not_food, the slot given back', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const store = new FakeStore();
    store.recipe = REFUSE_ME;
    const err = await assertRejects(
      () => generateRecipePhoto({ recipeId: RECIPE_ID }, { store, userId: USER_ID, newId: () => PHOTO_ID, env: MOCK_IMAGE_ENV }),
      GeneratePhotoError,
    );
    assertEquals(err.failure, { code: 'not_food', by: 'moderation' });
    assertEquals(store.aiCalls.map((c) => [c.task, c.model, c.status]), [
      ['recipePhotoDescription', 'mock', 'ok'],
      ['recipePhotoModeration', 'mock', 'refused'],
    ]);
    const row = store.aiCalls[1];
    assertEquals([row.user_id, row.household_id, row.error, row.output], [USER_ID, HOUSEHOLD_ID, 'Flagged: mock', { flagged: true, categories: ['mock'] }]);
    assertStringIncludes(row.prompt, `${MOCK_PHOTO_DESCRIPTION} (refuse-me)`);
    assertEquals(store.steps.at(-1), 'release');
    assertEquals(store.uploads, []);
  });
});

Deno.test('with the mock image model past moderation, a title with refuse-me is a refused image row', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const store = new FakeStore();
    store.recipe = { ...TACOS, name: 'Weeknight REFUSE-ME soup' };
    const moderation = fakeModeration();
    const err = await assertRejects(
      () => generateRecipePhoto({ recipeId: RECIPE_ID }, { store, userId: USER_ID, moderate: moderation.moderate, newId: () => PHOTO_ID, env: MOCK_IMAGE_ENV }),
      GeneratePhotoError,
    );
    assertEquals(err.failure, { code: 'not_food', by: 'image' });
    assertStringIncludes(moderation.texts[0], 'refuse-me');
    const row = store.aiCalls[2];
    assertEquals([row.task, row.model, row.status, row.error], ['recipePhotoImage', 'mock', 'refused', 'ImageRefusedError: Refused: moderation_blocked (mock)']);
    assertEquals(store.uploads, []);
  });
});

Deno.test('with the mock models, a recipe without refuse-me gets its photo and the prompt has no word added', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const store = new FakeStore();
    const answer = await generateRecipePhoto({ recipeId: RECIPE_ID }, { store, userId: USER_ID, newId: () => PHOTO_ID, env: MOCK_IMAGE_ENV });
    assertEquals(answer, { path: IMAGE_PATH });
    assertFalse(store.aiCalls[1].prompt.includes('refuse-me'));
  });
});

Deno.test('a real image model never sees the title: refuse-me in it changes nothing', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const store = new FakeStore();
    store.recipe = REFUSE_ME;
    const { res, image, moderation } = await call({ store });
    assertEquals(res.status, 200);
    assertFalse(image.prompts[0].includes('refuse-me'));
    assertFalse(moderation.texts[0].includes('refuse-me'));
  });
});

Deno.test('a moderation refusal logs a refused image row with the HTTP status and body', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const body = { error: { code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' } };
    const { res, json, store } = await call({ image: openAi(400, body) });
    assertEquals([res.status, json.error], [422, 'not_food']);
    const [description, , row] = store.aiCalls;
    assertEquals([row.task, row.status, row.http_status, row.error_body], ['recipePhotoImage', 'refused', 400, JSON.stringify(body)]);
    assertEquals(row.error, 'ImageRefusedError: Refused: Your request was rejected by the safety system.');
    assertEquals([row.output, row.input_tokens, row.output_tokens], [null, null, null]);
    assertEquals([row.fallback_of, row.recipe_id, row.user_id], [description.id, RECIPE_ID, USER_ID]);
  });
});

Deno.test('a 500 logs an api_error image row with the HTTP status and body', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const body = { error: { message: 'The server had an error while processing your request.' } };
    const { res, json, store } = await call({ image: openAi(500, body) });
    assertEquals([res.status, json.error], [502, 'generation_failed']);
    const row = store.aiCalls[2];
    assertEquals([row.status, row.http_status, row.error_body], ['api_error', 500, JSON.stringify(body)]);
    assertEquals(row.error, 'ImageFailedError: OpenAI answered 500: The server had an error while processing your request.');
    assertEquals(row.fallback_of, store.aiCalls[0].id);
  });
});

Deno.test('a long error body is cut to 4000 characters', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { store } = await call({ image: openAi(500, 'x'.repeat(5000)) });
    assertEquals(store.aiCalls[2].error_body, 'x'.repeat(4000));
  });
});

Deno.test('a timeout logs a timeout image row with no HTTP status or body', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { res, store } = await call({ image: hangingOpenAi() });
    assertEquals(res.status, 502);
    const row = store.aiCalls[2];
    assertEquals([row.status, row.http_status, row.error_body, row.error], ['timeout', null, null, 'ImageFailedError: No image within the timeout']);
  });
});

Deno.test('no image in the answer logs invalid_output; a failure with no status (no key) logs error', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { store } = await call({ image: openAi(200, { data: [] }) });
    assertEquals([store.aiCalls[2].status, store.aiCalls[2].http_status, store.aiCalls[2].error_body], ['invalid_output', null, null]);
    const noKey = await call({ image: fakeImage(new ImageFailedError('OPENAI_API_KEY is not set')) });
    assertEquals([noKey.store.aiCalls[2].status, noKey.store.aiCalls[2].error], ['error', 'ImageFailedError: OPENAI_API_KEY is not set']);
  });
});

Deno.test('the image bytes are never in a row', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0x51, 0x52, 0x53, 0x54, 0x55, 0xff, 0xd9]);
    const b64 = btoa(String.fromCharCode(...bytes));
    const { res, store } = await call({ image: openAi(200, { data: [{ b64_json: b64 }], usage: { input_tokens: 70, output_tokens: 1584 } }) });
    assertEquals(res.status, 200);
    assertEquals(store.uploads[0].bytes, bytes);
    const rows = JSON.stringify(store.aiCalls);
    assertFalse(rows.includes(b64), 'no base64');
    assertFalse(rows.includes('b64_json'), 'no response body');
    assertEquals([store.aiCalls[2].input_tokens, store.aiCalls[2].output_tokens], [70, 1584]);
    for (const row of store.aiCalls) for (const value of Object.values(row)) assertFalse(value instanceof Uint8Array);
  });
});

Deno.test("a failure to log the image row doesn't fail the request", async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    class BrokenLog extends FakeStore {
      override async logAiCall(call: AiCallRecord) {
        await super.logAiCall(call);
        throw new Error('insert failed');
      }
    }
    const store = new BrokenLog();
    const { res, json } = await call({ store });
    assertEquals([res.status, json], [200, { path: IMAGE_PATH }]);
    assertEquals(store.completed.length, 1);
    const refused = new BrokenLog();
    const failed = await call({ store: refused, image: fakeImage(new ImageRefusedError('Refused: moderation_blocked')) });
    assertEquals([failed.res.status, failed.json.error], [422, 'not_food']);
    assertEquals(refused.steps.at(-1), 'release');
  });
});

Deno.test('isFood false or a failed description logs no image row', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    for (const model of [answering({ isFood: false, description: 'ignored' }), failing(apiError())]) {
      const { store } = await call({ model });
      assertEquals(store.aiCalls.map((c) => [c.task, c.recipe_id]), [['recipePhotoDescription', RECIPE_ID]], model.modelId);
    }
  });
});

Deno.test('success: an upper-case recipe id is lowercased in the reservation and the path', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { res, json } = await call({}, { recipeId: RECIPE_ID.toUpperCase() });
    assertEquals(res.status, 200);
    assertEquals(json.path, `${HOUSEHOLD_ID}/${RECIPE_ID}/${PHOTO_ID}.jpg`);
  });
});

Deno.test('the description call gets only the title, ingredient names and cuisine labels, in its data block', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const store = new FakeStore();
    store.recipe = { ...TACOS, tags: { ...(TACOS.tags as object), cuisine: ['mexican', 'made-up'] } };
    await call({ store });
    const prompt = store.aiCalls[0].prompt;
    assertStringIncludes(prompt, '<recipe>\n{"title":"Grandma’s Fish Tacos","ingredients":["cod fillets","corn tortillas","red cabbage","lime"],"cuisines":["Mexican"]}\n</recipe>');
    assertFalse(prompt.includes('favorite'), 'no Saved tags');
    assertFalse(prompt.includes('dinner'), 'no other facets');
    assertFalse(prompt.includes('made-up'), 'no unknown slugs');
  });
});

Deno.test("the image prompt wraps the description and never the recipe's own text", async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const store = new FakeStore();
    store.recipe = { name: 'Zanzibar pilau XYZZY', ingredients: ['basmati rice', 'PLUGH cardamom pods'], tags: { cuisine: ['african'] } };
    const description = 'Golden spiced rice in a shallow clay bowl, flecked with green herbs.';
    const { res, image } = await call({ store, model: answering({ isFood: true, description }) });
    assertEquals(res.status, 200);
    const prompt = image.prompts[0];
    assertStringIncludes(prompt, `The dish: ${description}`);
    assertStringIncludes(prompt, 'No people, hands or other body parts.');
    assertStringIncludes(prompt, 'No text, letters, labels, logos or watermarks.');
    for (const raw of ['Zanzibar', 'XYZZY', 'PLUGH', 'basmati', 'African']) assertFalse(prompt.includes(raw), raw);
  });
});

Deno.test('a long description is cut to 60 words before it reaches the image prompt and complete', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`);
    const { store, image } = await call({ model: answering({ isFood: true, description: `  ${words.join('   ')}\n` }) });
    const expected = words.slice(0, 60).join(' ');
    assertEquals(store.completed[0].description, expected);
    assert(image.prompts[0].endsWith(`The dish: ${expected}`));
  });
});

// --- the moderation check before the image ------------------------------------------------------------------

/** The real moderation call over a fake OpenAI answering `status` and `body`, recording the request bodies. */
function openAiModeration(status: number, body: unknown) {
  const texts: string[] = [];
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const moderate = (text: string) => {
    texts.push(text);
    return moderateText(text, { env: (key) => (key === 'OPENAI_API_KEY' ? 'sk-test' : undefined), fetch });
  };
  return { texts, sent, moderate };
}

Deno.test('a clean prompt goes on to the image, and the moderated text is exactly the image prompt', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const description = 'Golden spiced rice in a shallow clay bowl, flecked with green herbs.';
    const { res, store, image, moderation } = await call({ model: answering({ isFood: true, description }) });
    assertEquals(res.status, 200);
    assertEquals(moderation.texts.length, 1);
    assertEquals(image.prompts.length, 1);
    assertEquals(moderation.texts[0], image.prompts[0]);
    assertStringIncludes(moderation.texts[0], `The dish: ${description}`);
    const [descriptionRow, row] = store.aiCalls;
    assertEquals(row, {
      id: row.id,
      user_id: USER_ID,
      household_id: HOUSEHOLD_ID,
      recipe_id: RECIPE_ID,
      task: 'recipePhotoModeration',
      model: 'openai:omni-moderation-latest',
      prompt_version: RECIPE_PHOTO_IMAGE_PROMPT_VERSION,
      status: 'ok',
      instructions: '',
      prompt: image.prompts[0],
      output: { flagged: false, categories: [] },
      response_text: null,
      finish_reason: null,
      raw_finish_reason: null,
      provider_metadata: null,
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      reasoning_tokens: null,
      duration_ms: row.duration_ms,
      error: null,
      http_status: null,
      error_body: null,
      fallback_of: descriptionRow.id,
    });
    assert(row.id !== descriptionRow.id && row.id !== store.aiCalls[2].id);
  });
});

Deno.test('a flagged prompt: 422 not_food, released, the image model never called, a refused moderation row', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const moderation = fakeModeration({ flagged: true, categories: ['violence', 'violence/graphic'] });
    const { res, json, store, image } = await call({ moderation });
    assertEquals([res.status, json], [422, { error: 'not_food', message: "This recipe can't have an AI photo" }]);
    assertEquals(store.steps, ['household', 'feature:recipe_photo_ai', 'reserve', 'read', 'ai_call', 'ai_call', 'release']);
    assertEquals(image.prompts, []);
    assertEquals([store.uploads, store.completed], [[], []]);
    assertEquals(store.aiCalls.map((c) => c.task), ['recipePhotoDescription', 'recipePhotoModeration']);
    const row = store.aiCalls[1];
    assertEquals([row.status, row.output, row.error], ['refused', { flagged: true, categories: ['violence', 'violence/graphic'] }, 'Flagged: violence, violence/graphic']);
    assertEquals([row.fallback_of, row.user_id, row.recipe_id, row.prompt], [store.aiCalls[0].id, USER_ID, RECIPE_ID, moderation.texts[0]]);
  });
});

Deno.test('a flagged prompt through the real moderation call: the URL, the body and the 422', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const moderation = openAiModeration(200, { id: 'modr-1', results: [{ flagged: true, categories: { violence: true, sexual: false, 'self-harm': true } }] });
    const { res, json, store, image } = await call({ moderation });
    assertEquals([res.status, json.error], [422, 'not_food']);
    assertEquals(moderation.sent, [{ url: 'https://api.openai.com/v1/moderations', body: { model: 'omni-moderation-latest', input: moderation.texts[0] } }]);
    assertEquals(image.prompts, []);
    assertEquals(store.aiCalls[1].output, { flagged: true, categories: ['self-harm', 'violence'] });
    assertEquals(store.steps.at(-1), 'release');
  });
});

Deno.test('a moderation failure: 502 generation_failed, released, no image call, the failure in its row', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const errorBody = { error: { message: 'The server had an error.' } };
    const cases: [{ texts: string[]; moderate: NonNullable<GenerateDeps['moderate']> }, string, number | null, string | null][] = [
      [openAiModeration(500, errorBody), 'api_error', 500, JSON.stringify(errorBody)],
      [openAiModeration(200, { results: [] }), 'invalid_output', 200, '{"results":[]}'],
      [fakeModeration(undefined, new ModerationFailedError('No moderation answer within the timeout', 'timeout')), 'timeout', null, null],
    ];
    for (const [moderation, status, httpStatus, errorBodyText] of cases) {
      const { res, json, store, image } = await call({ moderation });
      assertEquals([res.status, json.error], [502, 'generation_failed'], status);
      assertEquals(store.steps, ['household', 'feature:recipe_photo_ai', 'reserve', 'read', 'ai_call', 'ai_call', 'release'], status);
      assertEquals(image.prompts, [], status);
      const row = store.aiCalls[1];
      assertEquals([row.task, row.status, row.http_status, row.error_body, row.output], ['recipePhotoModeration', status, httpStatus, errorBodyText, null], status);
      assert(row.error?.startsWith('ModerationFailedError: '), row.error ?? '');
      assertEquals(row.fallback_of, store.aiCalls[0].id);
    }
  });
});

Deno.test('an unexpected moderation error: 500, released, no image call, an error row', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { res, json, store, image } = await call({ moderation: fakeModeration(undefined, new TypeError('boom')) });
    assertEquals([res.status, json.error], [500, 'internal_error']);
    assertEquals(store.steps.at(-1), 'release');
    assertEquals(image.prompts, []);
    assertEquals([store.aiCalls[1].status, store.aiCalls[1].error], ['error', 'TypeError: boom']);
  });
});

Deno.test('isFood false or a failed description never reaches moderation', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    for (const model of [answering({ isFood: false, description: 'ignored' }), failing(apiError())]) {
      const { moderation } = await call({ model });
      assertEquals(moderation.texts, [], model.modelId);
    }
  });
});

// --- the order of checks ------------------------------------------------------------------------------

Deno.test('not entitled: 403 before anything else', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const store = new FakeStore();
    store.features.clear();
    const { res, json, image } = await call({ store });
    assertEquals(res.status, 403);
    assertEquals(json.error, 'not_entitled');
    assertEquals(store.steps, ['household', 'feature:recipe_photo_ai']);
    assertEquals(image.prompts, []);
  });
});

Deno.test("the plan is checked in the live recipe's household", async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const OTHER_HOUSEHOLD = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
    const store = new FakeStore();
    store.household = OTHER_HOUSEHOLD;
    store.features.clear();
    const { res, json } = await call({ store });
    assertEquals([res.status, json.error], [403, 'not_entitled']);
    assertEquals(store.featureHouseholds, [OTHER_HOUSEHOLD]);
  });
});

Deno.test('success: one plan check, in the recipe’s household', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { res, store } = await call();
    assertEquals(res.status, 200);
    assertEquals(store.featureHouseholds, [HOUSEHOLD_ID]);
  });
});

Deno.test('a recipe gone (or never there) at the lookup: 404 not_found with no plan check, reservation or call', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const store = new FakeStore();
    store.household = null;
    const { res, json, image, moderation } = await call({ store });
    assertEquals([res.status, json.error], [404, 'not_found']);
    assertEquals(store.steps, ['household']);
    assertEquals([store.aiCalls, store.uploads, image.prompts, moderation.texts], [[], [], [], []]);
  });
});

Deno.test('not entitled in the household (a plan without AI photos, or a caller not in it): nothing reserved or written', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const store = new FakeStore();
    store.features.clear();
    const { res } = await call({ store });
    assertEquals(res.status, 403);
    assertFalse(store.steps.includes('reserve'));
    assertEquals([store.aiCalls, store.uploads, store.completed], [[], [], []]);
  });
});

Deno.test('an error from the household lookup is a 500, with nothing reserved', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const store = new FakeStore();
    store.recipeHousehold = () => Promise.reject(new Error('db down'));
    const { res, json } = await call({ store });
    assertEquals([res.status, json.error], [500, 'internal_error']);
    assertEquals(store.steps, []);
  });
});

Deno.test('the description kill switch: 503 after the plan, before the reservation', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'off' }, async () => {
    const { res, json, store } = await call({ env: { AI_MODEL_PHOTO_DESCRIPTION: 'off' } });
    assertEquals(res.status, 503);
    assertEquals(json.error, 'unavailable');
    assertEquals(res.headers.get('Retry-After'), String(PAUSED_RETRY_AFTER));
    assertEquals(store.steps, ['household', 'feature:recipe_photo_ai']);
  });
});

Deno.test('the image kill switch (AI_IMAGE_MODEL=off): 503 before the reservation', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { res, json, store, image } = await call({ env: { AI_IMAGE_MODEL: 'off' } });
    assertEquals(res.status, 503);
    assertEquals(json.error, 'unavailable');
    assertEquals(store.steps, ['household', 'feature:recipe_photo_ai']);
    assertEquals(image.prompts, []);
  });
});

Deno.test('reservation answers: not_found 404, already_generated 409, user_limit, daily_limit and monthly_limit 429, with no model call or release', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const cases: [ReserveResult['status'], number, string][] = [
      ['not_found', 404, 'not_found'],
      ['already_generated', 409, 'already_generated'],
      ['user_limit', 429, 'rate_limited'],
      ['daily_limit', 429, 'daily_limit'],
      ['monthly_limit', 429, 'limit_reached'],
    ];
    for (const [status, httpStatus, code] of cases) {
      const store = new FakeStore();
      store.reservation = { status } as ReserveResult;
      const { res, json, image, moderation } = await call({ store });
      assertEquals(res.status, httpStatus, status);
      assertEquals(json.error, code, status);
      assertEquals(store.steps, ['household', 'feature:recipe_photo_ai', 'reserve'], status);
      assertEquals(store.aiCalls, [], `${status}: no description call`);
      assertEquals(moderation.texts, [], `${status}: no moderation call`);
      assertEquals(image.prompts, [], `${status}: no image call`);
      assertEquals(store.uploads, [], `${status}: nothing uploaded`);
      assertEquals(store.completed, [], `${status}: nothing completed`);
    }
  });
});

Deno.test('the per-minute limit: 429 rate_limited with no resets_at or Retry-After', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const store = new FakeStore();
    store.reservation = { status: 'user_limit' };
    const { res, json } = await call({ store });
    assertEquals(res.status, 429);
    assertEquals(res.headers.get('Retry-After'), null);
    assertEquals(json, { error: 'rate_limited', message: 'Too many AI photos; try again later' });
  });
});

Deno.test('the daily limit: 429 daily_limit with the next UTC midnight as resets_at', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const store = new FakeStore();
    store.reservation = { status: 'daily_limit' };
    const { res, json } = await call({ store });
    assertEquals(res.status, 429);
    assertEquals(res.headers.get('Retry-After'), null);
    assertEquals(json, { error: 'daily_limit', message: "Today's AI photos are used up", resets_at: '2026-10-19T00:00:00.000Z' });
  });
});

Deno.test('a blocked user: 403 ai_photos_blocked, with no model call, moderation or release', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const store = new FakeStore();
    store.reservation = { status: 'blocked' };
    const { res, json, image, moderation } = await call({ store });
    assertEquals(res.status, 403);
    assertEquals(json, { error: 'ai_photos_blocked', message: 'AI photos are turned off for your account' });
    assertEquals(store.steps, ['household', 'feature:recipe_photo_ai', 'reserve']);
    assertEquals(store.aiCalls, []);
    assertEquals(moderation.texts, []);
    assertEquals(image.prompts, []);
  });
});

Deno.test('the monthly limit: 429 limit_reached with next month as resets_at', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const store = new FakeStore();
    store.reservation = { status: 'monthly_limit' };
    const { res, json } = await call({ store });
    assertEquals(res.status, 429);
    assertEquals(res.headers.get('Retry-After'), null);
    assertEquals(json, { error: 'limit_reached', message: "This month's AI photos are used up", resets_at: '2026-11-01T00:00:00.000Z' });
  });
});

Deno.test('the recipe gone after the reservation: 404 and released', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const store = new FakeStore();
    store.recipe = null;
    const { res, json } = await call({ store });
    assertEquals(res.status, 404);
    assertEquals(json.error, 'not_found');
    assertEquals(store.steps, ['household', 'feature:recipe_photo_ai', 'reserve', 'read', 'release']);
  });
});

// --- refusals and failures release the slot -------------------------------------------------------------

Deno.test('isFood false: 422 not_food, released, no image call', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { res, json, store, image } = await call({ model: answering({ isFood: false, description: 'ignored' }) });
    assertEquals(res.status, 422);
    assertEquals(json.error, 'not_food');
    assertEquals(store.steps, ['household', 'feature:recipe_photo_ai', 'reserve', 'read', 'ai_call', 'release']);
    assertEquals(image.prompts, []);
    assertEquals(store.completed, []);
  });
});

Deno.test('the mock refuses a recipe that says "not food": 422', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const store = new FakeStore();
    store.recipe = { name: 'Play dough', ingredients: ['flour', 'salt (not food!)'], tags: null };
    const { res, json } = await call({ store });
    assertEquals(res.status, 422);
    assertEquals(json.error, 'not_food');
    assertEquals(store.steps.at(-1), 'release');
  });
});

Deno.test('a moderation refusal from the image model: 422 not_food, released, nothing uploaded', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { res, json, store } = await call({ image: fakeImage(new ImageRefusedError('Refused: moderation_blocked')) });
    assertEquals(res.status, 422);
    assertEquals(json.error, 'not_food');
    assertEquals(store.steps, ['household', 'feature:recipe_photo_ai', 'reserve', 'read', 'ai_call', 'ai_call', 'ai_call', 'release']);
    assertEquals(store.uploads, []);
  });
});

Deno.test('an image timeout or error: 502 generation_failed, released', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { res, json, store } = await call({ image: fakeImage(new ImageFailedError('No image within the timeout')) });
    assertEquals(res.status, 502);
    assertEquals(json.error, 'generation_failed');
    assertEquals(store.steps.at(-1), 'release');
    assertEquals(store.uploads, []);
  });
});

Deno.test('a description provider error, invalid output or empty description: 502, released, no image call', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    for (const model of [failing(apiError()), answering({ wrong: 'shape' }), answering({ isFood: true, description: '   ' })]) {
      const { res, json, store, image } = await call({ model });
      assertEquals(res.status, 502, model.modelId);
      assertEquals(json.error, 'generation_failed');
      assertEquals(store.steps.at(-1), 'release');
      assertEquals(image.prompts, []);
    }
  });
});

Deno.test('an upload failure: 500, released, not completed', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const store = new FakeStore();
    store.failUpload = true;
    const { res, json } = await call({ store });
    assertEquals(res.status, 500);
    assertEquals(json.error, 'internal_error');
    assertEquals(store.steps.at(-1), 'release');
    assertEquals(store.completed, []);
  });
});

Deno.test('the recipe deleted while the photo was made: complete answers false, 404, not released', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const store = new FakeStore();
    store.completeAnswer = false;
    const { res, json } = await call({ store });
    assertEquals(res.status, 404);
    assertEquals(json.error, 'not_found');
    assertEquals(store.steps.at(-1), 'complete');
  });
});

Deno.test('complete throwing after the upload: 500, released, the uploaded object removed', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const path = `${HOUSEHOLD_ID}/${RECIPE_ID}/${PHOTO_ID}.jpg`;
    for (const failRemove of [false, true]) {
      const store = new FakeStore();
      store.completeError = new Error('database down');
      store.failRemove = failRemove;
      const { res, json } = await call({ store });
      assertEquals([res.status, json.error], [500, 'internal_error'], `failRemove ${failRemove}`);
      assertEquals(store.steps.slice(-4), [`upload:${path}`, 'complete', 'release', `remove:${path}`], `failRemove ${failRemove}`);
      assertEquals(store.removed, failRemove ? [] : [path]);
    }
  });
});

Deno.test('nothing is removed when the upload fails, complete answers false, or it succeeds', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const failedUpload = new FakeStore();
    failedUpload.failUpload = true;
    const gone = new FakeStore();
    gone.completeAnswer = false;
    for (const store of [failedUpload, gone, new FakeStore()]) {
      await call({ store });
      assertFalse(store.steps.some((step) => step.startsWith('remove:')), store.steps.join(' '));
    }
  });
});

Deno.test('a 502 never carries the provider text, only a fixed message', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const secret = 'Billing hard limit reached for org-XYZ';
    const body = { error: { message: secret } };
    const setups: Setup[] = [
      { image: openAi(500, body) },
      { image: fakeImage(new ImageFailedError(`OpenAI answered 500: ${secret}`)) },
      { moderation: openAiModeration(500, body) },
      { moderation: fakeModeration(undefined, new ModerationFailedError(`OpenAI answered 500: ${secret}`, 'api_error')) },
      { model: failing(new APICallError({ message: secret, url: 'https://x', requestBodyValues: {}, statusCode: 500, isRetryable: false })) },
    ];
    for (const setup of setups) {
      const { res, json, store } = await call(setup);
      assertEquals(res.status, 502);
      assertEquals(json, { error: 'generation_failed', message: 'The photo could not be made' });
      // The detail stays in the failed step's ai_calls row.
      assert(store.aiCalls.some((row) => row.error?.includes(secret) || row.error_body?.includes(secret)), JSON.stringify(store.aiCalls.at(-1)));
    }
  });
});

// --- the HTTP layer ------------------------------------------------------------------------------------

Deno.test('bad requests: 405, 400 for bad JSON or a missing or malformed id, 413 for a big body', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const get = await handleRequest(new Request(ENDPOINT), { env: () => 'x', generateRecipePhoto: () => Promise.reject(new Error('unreached')) });
    assertEquals(get.status, 405);
    for (const body of ['{', {}, { recipeId: 'nope' }, { recipeId: 42 }]) {
      const { res, json, store } = await call({}, body);
      assertEquals(res.status, 400, JSON.stringify(body));
      assertEquals(json.error, 'invalid_request');
      assertEquals(store.steps, []);
    }
    const { res } = await call({}, { recipeId: RECIPE_ID, padding: 'x'.repeat(5000) });
    assertEquals(res.status, 413);
  });
});

Deno.test('not configured: no description model, or no OpenAI key for a real image model, is a 500', async () => {
  const notCalled = () => Promise.reject(new Error('unreached'));
  const envOf = (vars: Record<string, string>) => (key: string) => vars[key];
  const noModel = await handleRequest(post({ recipeId: RECIPE_ID }), { env: envOf({ OPENAI_API_KEY: 'sk' }), generateRecipePhoto: notCalled });
  assertEquals(noModel.status, 500);
  assertEquals((await noModel.json()).error, 'not_configured');
  const noKey = await handleRequest(post({ recipeId: RECIPE_ID }), { env: envOf({ AI_MODEL_TAGS: 'mock' }), generateRecipePhoto: notCalled });
  assertEquals(noKey.status, 500);
  assertStringIncludes((await noKey.json()).message, 'OPENAI_API_KEY');
  // The mock image model needs no key, and the description follows AI_MODEL_RECIPE when nothing else is set.
  const mockImage = await handleRequest(post({ recipeId: 'x' }), {
    env: envOf({ AI_MODEL_RECIPE: 'mock', AI_IMAGE_MODEL: 'mock' }),
    generateRecipePhoto: notCalled,
  });
  assertEquals(mockImage.status, 400);
});
