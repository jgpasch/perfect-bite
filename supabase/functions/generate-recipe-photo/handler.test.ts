// generate-recipe-photo (spec 6.11) end to end through handleRequest, with a fake store, the mock
// or a MockLanguageModelV4 for the description, and a fake image call. Nothing touches the network.
import { assert, assertEquals, assertFalse, assertStringIncludes } from '@std/assert';
import { APICallError, type LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { MOCK_PHOTO_DESCRIPTION } from '../_shared/ai/mock-model.ts';
import { RECIPE_PHOTO_DESCRIPTION_PROMPT_VERSION } from '../_shared/ai/prompts/recipe-photo-description.v1.ts';
import type { AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { NotEntitledError, type Feature } from '../_shared/entitlements.ts';
import { generateRecipePhoto, type GenerateDeps, type RecipePhotoStore, type ReserveResult, type StoredRecipe } from './handler.ts';
import { ImageFailedError, ImageRefusedError, type GeneratedImage } from './image.ts';
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
  /** Every step, in order: `feature:<name>`, `reserve`, `read`, `ai_call`, `upload:<path>`, `complete`, `release`. */
  steps: string[] = [];
  aiCalls: AiCallRecord[] = [];
  features = new Set<Feature>(['recipe_photo_ai']);
  reservation: ReserveResult = { status: 'ok', householdId: HOUSEHOLD_ID };
  recipe: StoredRecipe | null = TACOS;
  uploads: { path: string; bytes: Uint8Array }[] = [];
  completed: { recipeId: string; description: string; path: string }[] = [];
  completeAnswer = true;
  failUpload = false;

  async requireFeature(feature: Feature) {
    this.steps.push(`feature:${feature}`);
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
    this.completed.push({ recipeId, description, path });
    return this.completeAnswer;
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

/** A fake image call that records each prompt and answers `JPEG`, or throws `error`. */
function fakeImage(error?: Error) {
  const prompts: string[] = [];
  const generate = async (prompt: string): Promise<GeneratedImage> => {
    prompts.push(prompt);
    if (error) throw error;
    return { bytes: JPEG, model: 'gpt-image-1-mini', quality: 'medium', ms: 5, usage: { inputTokens: 60, outputTokens: 1584 } };
  };
  return { prompts, generate };
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

type Setup = {
  store?: FakeStore;
  image?: ReturnType<typeof fakeImage>;
  model?: GenerateDeps['model'];
  env?: Record<string, string>;
  /** The signed-in caller; USER_ID unless set (null for none). */
  userId?: string | null;
};

/** POSTs `{ recipeId }` through handleRequest with the fakes; the env defaults to the mock description and an image key. */
async function call(setup: Setup = {}, body: unknown = { recipeId: RECIPE_ID }) {
  const store = setup.store ?? new FakeStore();
  const image = setup.image ?? fakeImage();
  const env = { OPENAI_API_KEY: 'sk-test', AI_MODEL_PHOTO_DESCRIPTION: 'mock', ...setup.env };
  const read = (key: string) => (env as Record<string, string | undefined>)[key];
  const userId = setup.userId === undefined ? USER_ID : (setup.userId ?? undefined);
  const res = await handleRequest(post(body), {
    env: read,
    generateRecipePhoto: (request) =>
      generateRecipePhoto(request, { store, userId, model: setup.model, generateImage: image.generate, newId: () => PHOTO_ID, env: read }),
    now: () => Date.parse('2026-10-18T12:00:00Z'),
  });
  return { res, json: await res.json(), store, image };
}

// --- success ----------------------------------------------------------------------------------------

Deno.test('success: reads the recipe, describes it, makes the image, uploads it to the photo_path shape and completes', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { res, json, store, image } = await call();
    const path = `${HOUSEHOLD_ID}/${RECIPE_ID}/${PHOTO_ID}.jpg`;
    assertEquals(res.status, 200);
    assertEquals(json, { path });
    assertEquals(store.steps, ['feature:recipe_photo_ai', 'reserve', 'read', 'ai_call', `upload:${path}`, 'complete']);
    assertEquals(store.uploads, [{ path, bytes: JPEG }]);
    assertEquals(store.completed, [{ recipeId: RECIPE_ID, description: MOCK_PHOTO_DESCRIPTION, path }]);
    assertEquals(image.prompts.length, 1);
    assertStringIncludes(image.prompts[0], MOCK_PHOTO_DESCRIPTION);
    assertEquals(store.aiCalls[0].task, 'recipePhotoDescription');
    assertEquals(store.aiCalls[0].prompt_version, RECIPE_PHOTO_DESCRIPTION_PROMPT_VERSION);
  });
});

Deno.test("the description's ai_calls row carries the caller and the recipe's household", async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { res, store } = await call();
    assertEquals(res.status, 200);
    assertEquals(store.aiCalls.map((c) => [c.task, c.user_id, c.household_id]), [['recipePhotoDescription', USER_ID, HOUSEHOLD_ID]]);
  });
});

Deno.test('a failed description is logged with the caller and household too', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { res, store } = await call({ model: answering({ nope: true }) });
    assertEquals(res.status, 502);
    assertEquals(store.aiCalls.map((c) => [c.status, c.user_id, c.household_id]), [['invalid_output', USER_ID, HOUSEHOLD_ID]]);
  });
});

Deno.test('with no caller the row has a null user and household', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { store } = await call({ userId: null });
    assertEquals(store.aiCalls.map((c) => [c.user_id, c.household_id]), [[null, null]]);
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

// --- the order of checks ------------------------------------------------------------------------------

Deno.test('not entitled: 403 before anything else', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const store = new FakeStore();
    store.features.clear();
    const { res, json, image } = await call({ store });
    assertEquals(res.status, 403);
    assertEquals(json.error, 'not_entitled');
    assertEquals(store.steps, ['feature:recipe_photo_ai']);
    assertEquals(image.prompts, []);
  });
});

Deno.test('the description kill switch: 503 after the plan, before the reservation', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'off' }, async () => {
    const { res, json, store } = await call({ env: { AI_MODEL_PHOTO_DESCRIPTION: 'off' } });
    assertEquals(res.status, 503);
    assertEquals(json.error, 'unavailable');
    assertEquals(res.headers.get('Retry-After'), String(PAUSED_RETRY_AFTER));
    assertEquals(store.steps, ['feature:recipe_photo_ai']);
  });
});

Deno.test('the image kill switch (AI_IMAGE_MODEL=off): 503 before the reservation', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { res, json, store, image } = await call({ env: { AI_IMAGE_MODEL: 'off' } });
    assertEquals(res.status, 503);
    assertEquals(json.error, 'unavailable');
    assertEquals(store.steps, ['feature:recipe_photo_ai']);
    assertEquals(image.prompts, []);
  });
});

Deno.test('reservation answers: not_found 404, already_generated 409, monthly_limit 429, with no model call or release', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const cases: [ReserveResult['status'], number, string][] = [
      ['not_found', 404, 'not_found'],
      ['already_generated', 409, 'already_generated'],
      ['monthly_limit', 429, 'limit_reached'],
    ];
    for (const [status, httpStatus, code] of cases) {
      const store = new FakeStore();
      store.reservation = { status } as ReserveResult;
      const { res, json, image } = await call({ store });
      assertEquals(res.status, httpStatus, status);
      assertEquals(json.error, code, status);
      assertEquals(store.steps, ['feature:recipe_photo_ai', 'reserve'], status);
      assertEquals(store.aiCalls, [], `${status}: no description call`);
      assertEquals(image.prompts, [], `${status}: no image call`);
    }
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
    assertEquals(store.steps, ['feature:recipe_photo_ai', 'reserve', 'read', 'release']);
  });
});

// --- refusals and failures release the slot -------------------------------------------------------------

Deno.test('isFood false: 422 not_food, released, no image call', async () => {
  await withEnv({ AI_MODEL_PHOTO_DESCRIPTION: 'mock' }, async () => {
    const { res, json, store, image } = await call({ model: answering({ isFood: false, description: 'ignored' }) });
    assertEquals(res.status, 422);
    assertEquals(json.error, 'not_food');
    assertEquals(store.steps, ['feature:recipe_photo_ai', 'reserve', 'read', 'ai_call', 'release']);
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
    assertEquals(store.steps, ['feature:recipe_photo_ai', 'reserve', 'read', 'ai_call', 'release']);
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
