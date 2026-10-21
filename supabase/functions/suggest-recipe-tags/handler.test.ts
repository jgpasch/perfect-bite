// suggest-recipe-tags (spec 6.7) end to end through handleRequest, with a fake store and the mock
// or a MockLanguageModelV4. Nothing touches the network.
import { emptyAiRecipeTags, type SuggestRecipeTagsRequestInput } from '@shared/index.ts';
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { APICallError, type LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { SUGGEST_RECIPE_TAGS_PROMPT_VERSION } from '../_shared/ai/prompts/suggest-recipe-tags.v1.ts';
import type { AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import type { LimitResult } from '../categorize-ingredients/handler.ts';
import { suggestRecipeTags, type SuggestDeps, type SuggestTagsStore } from './handler.ts';
import { AI_FAILED_RETRY_AFTER, handleRequest, PAUSED_RETRY_AFTER } from './request.ts';

const ENDPOINT = 'http://localhost/functions/v1/suggest-recipe-tags';
const ENV_KEYS = ['AI_MODEL_TAGS', 'AI_MODEL_TAGS_FALLBACK', 'AI_MODEL_RECIPE', 'AI_MODEL_RECIPE_FALLBACK'];

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

class FakeStore implements SuggestTagsStore {
  /** Every step, in order: `limit`, `member:<household>`, `ai_call`. */
  steps: string[] = [];
  aiCalls: AiCallRecord[] = [];
  limit: LimitResult = 'ok';
  /** The households the caller is a member of. */
  households = new Set<string>();

  async checkLimit() {
    this.steps.push('limit');
    return this.limit;
  }
  async isMember(householdId: string) {
    this.steps.push(`member:${householdId}`);
    return this.households.has(householdId);
  }
  async logAiCall(call: AiCallRecord) {
    this.steps.push('ai_call');
    this.aiCalls.push(call);
  }
}

/** A model answering every call with `answer`. */
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

/** A model whose every call throws `error`. */
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

const CALLER = { userId: '11111111-1111-4111-8111-111111111111', householdId: null };

function setup(overrides: Partial<SuggestDeps> = {}) {
  const store = new FakeStore();
  const deps: SuggestDeps = { store, caller: CALLER, ...overrides };
  const post = (body: unknown) =>
    handleRequest(new Request(ENDPOINT, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), {
      suggestRecipeTags: (request) => suggestRecipeTags(request, deps),
      env: (k) => Deno.env.get(k),
      now: () => Date.parse('2026-10-18T12:00:00Z'),
    });
  return { store, post };
}

const TIKKA: SuggestRecipeTagsRequestInput = {
  name: 'Chicken tikka masala',
  notes: 'Serve with rice.',
  ingredients: [
    { name: 'chicken thighs', quantity: 2, unit: 'lb', note: 'skinless' },
    { name: 'yogurt', quantity: 1, unit: 'cup', note: '' },
    { name: 'garam masala', quantity: null, unit: null, note: null },
  ],
};

const tags = (partial: Partial<ReturnType<typeof emptyAiRecipeTags>>) => ({ ...emptyAiRecipeTags(), ...partial });

// --- Success ------------------------------------------------------------------------------------

Deno.test('the mock suggests tags from the name and ingredients, with the prompt version', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { store, post } = setup();
    const res = await post(TIKKA);
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      tags: tags({ cuisine: ['indian'], protein: ['chicken'] }),
      promptVersion: SUGGEST_RECIPE_TAGS_PROMPT_VERSION,
    });
    assertEquals(store.steps, ['limit', 'ai_call']);
  });
});

Deno.test('AI_MODEL_TAGS unset falls back to AI_MODEL_RECIPE', async () => {
  await withEnv({ AI_MODEL_RECIPE: 'mock' }, async () => {
    const { store, post } = setup();
    const res = await post({ name: 'Tofu stir fry', notes: null, ingredients: [{ name: 'firm tofu', quantity: 1, unit: null, note: '' }] });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).tags, tags({ protein: ['tofu-tempeh'] }));
    assertEquals(store.aiCalls[0].model, 'mock');
    assertEquals(store.aiCalls[0].task, 'suggestRecipeTags');
  });
});

Deno.test('nothing fitting is a 200 with every facet empty', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { post } = setup();
    const res = await post({ name: 'Mystery dish', notes: null, ingredients: [{ name: 'salt', quantity: null, unit: null, note: '' }] });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).tags, emptyAiRecipeTags());
  });
});

Deno.test('a recipe with no ingredients is still sent: the name alone can suggest tags', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { store, post } = setup();
    const res = await post({ name: 'Chocolate cake', notes: null, ingredients: [] });
    assertEquals((await res.json()).tags, tags({ meal: ['dessert'] }));
    assertEquals(store.aiCalls.length, 1);
  });
});

Deno.test('an unknown slug drops only its facet', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { post } = setup({
      model: answering({ meal: ['dinner'], cuisine: ['italian', 'martian'], protein: ['chicken'], diet: [], method: ['grill'] }),
    });
    const res = await post(TIKKA);
    assertEquals(res.status, 200);
    assertEquals((await res.json()).tags, tags({ meal: ['dinner'], protein: ['chicken'], method: ['grill'] }));
  });
});

Deno.test('saved never comes from the model: a saved facet in its answer is dropped', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { post } = setup({
      model: answering({ saved: ['favorite', 'want-to-try'], meal: ['dinner'], cuisine: [], protein: [], diet: [], method: [] }),
    });
    const res = await post(TIKKA);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.tags, tags({ meal: ['dinner'] }));
    assertEquals('saved' in body.tags, false);
  });
});

Deno.test('a facet over its maximum is cut, and repeats are dropped', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { post } = setup({
      model: answering({
        meal: ['dinner', 'lunch', 'side'],
        cuisine: [],
        protein: ['chicken', 'chicken', 'beef', 'pork', 'lamb'],
        diet: [],
        method: [],
      }),
    });
    const res = await post(TIKKA);
    assertEquals((await res.json()).tags, tags({ meal: ['dinner', 'lunch'], protein: ['chicken', 'beef', 'pork'] }));
  });
});

Deno.test('ai_calls gets the prompt, the output and the caller, with no household', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { store, post } = setup();
    await post(TIKKA);
    const [call] = store.aiCalls;
    assertEquals(call.status, 'ok');
    assertEquals(call.prompt_version, SUGGEST_RECIPE_TAGS_PROMPT_VERSION);
    assertStringIncludes(call.prompt, '2 lb chicken thighs, skinless');
    assertEquals(call.output, { meal: [], cuisine: ['indian'], protein: ['chicken'], diet: [], method: [] });
    assertEquals([call.user_id, call.household_id], [CALLER.userId, null]);
  });
});

Deno.test('a failed call is logged with the caller too', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { store, post } = setup({ model: answering({ nope: true }) });
    assertEquals((await post(TIKKA)).status, 503);
    assertEquals(store.aiCalls.map((c) => [c.status, c.user_id, c.household_id]), [['invalid_output', CALLER.userId, null]]);
  });
});

const HOUSEHOLD_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

Deno.test('a household the caller is in is recorded on ai_calls, checked once after the limit',async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { store, post } = setup();
    store.households.add(HOUSEHOLD_ID);
    assertEquals((await post({ ...TIKKA, householdId: HOUSEHOLD_ID })).status, 200);
    assertEquals(store.aiCalls.map((c) => [c.user_id, c.household_id]), [[CALLER.userId, HOUSEHOLD_ID]]);
    assertEquals(store.steps, ['limit', `member:${HOUSEHOLD_ID}`, 'ai_call']);
  });
});

Deno.test("a household the caller isn't in is ignored: the suggestion still answers, with no household on the row", async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { store, post } = setup();
    const res = await post({ ...TIKKA, householdId: HOUSEHOLD_ID });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).tags.cuisine, ['indian']);
    assertEquals(store.aiCalls.map((c) => [c.user_id, c.household_id]), [[CALLER.userId, null]]);
  });
});

Deno.test('no household asks nothing; a failed call carries the household too', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const plain = setup();
    await plain.post(TIKKA);
    assertEquals(plain.store.steps, ['limit', 'ai_call']);
    const failed = setup({ model: answering({ nope: true }) });
    failed.store.households.add(HOUSEHOLD_ID);
    assertEquals((await failed.post({ ...TIKKA, householdId: HOUSEHOLD_ID })).status, 503);
    assertEquals(failed.store.aiCalls.map((c) => [c.status, c.household_id]), [['invalid_output', HOUSEHOLD_ID]]);
  });
});

Deno.test('a householdId that is not a uuid is 400 invalid_request, with nothing counted', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { store, post } = setup();
    const res = await post({ ...TIKKA, householdId: 'not-a-uuid' });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, 'invalid_request');
    assertEquals(store.steps, []);
  });
});

Deno.test('a refused suggestion (limit) never asks about the household', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { store, post } = setup();
    store.limit = 'user_limit';
    assertEquals((await post({ ...TIKKA, householdId: HOUSEHOLD_ID })).status, 429);
    assertEquals(store.steps, ['limit']);
  });
});

// --- Order and refusals ---------------------------------------------------------------------------

Deno.test('answers a user on the free plan (no feature check)', async () => {
  // Tag suggestions are for everyone (spec 4.12). A store whose plan check would refuse every
  // feature, as the old `requireFeature` did for a plan without `recipe_tags`, is never asked.
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { store, post } = setup();
    Object.assign(store, {
      requireFeature(feature: string) {
        store.steps.push(`feature:${feature}`);
        return Promise.reject(new Error(`Your plan doesn't include ${feature}`));
      },
    });
    const res = await post(TIKKA);
    assertEquals(res.status, 200);
    assertEquals((await res.json()).tags, tags({ cuisine: ['indian'], protein: ['chicken'] }));
    assertEquals(store.steps, ['limit', 'ai_call']);
  });
});

Deno.test('the per-user limit is 429 rate_limited with no model call', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { store, post } = setup();
    store.limit = 'user_limit';
    const res = await post(TIKKA);
    assertEquals(res.status, 429);
    assertEquals(res.headers.get('Retry-After'), null);
    assertEquals((await res.json()).error, 'rate_limited');
    assertEquals(store.steps, ['limit']);
  });
});

Deno.test('the monthly limit is 429 limit_reached with next month as resets_at, and no model call', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { store, post } = setup();
    store.limit = 'monthly_limit';
    const res = await post(TIKKA);
    assertEquals(res.status, 429);
    assertEquals(res.headers.get('Retry-After'), null);
    assertEquals(await res.json(), {
      error: 'limit_reached',
      message: "This month's tag suggestions are used up",
      resets_at: '2026-11-01T00:00:00.000Z',
    });
    assertEquals(store.steps, ['limit']);
  });
});

Deno.test('the daily limit is 429 daily_limit with the next UTC midnight as resets_at, and no model call', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { store, post } = setup();
    store.limit = 'daily_limit';
    const res = await post(TIKKA);
    assertEquals(res.status, 429);
    assertEquals(res.headers.get('Retry-After'), null);
    assertEquals(await res.json(), {
      error: 'daily_limit',
      message: "Today's tag suggestions are used up",
      resets_at: '2026-10-19T00:00:00.000Z',
    });
    assertEquals(store.steps, ['limit']);
  });
});

Deno.test('AI_MODEL_TAGS=off is 503 unavailable, using no budget and calling no model', async () => {
  await withEnv({ AI_MODEL_TAGS: 'off', AI_MODEL_RECIPE: 'mock' }, async () => {
    const { store, post } = setup();
    const res = await post(TIKKA);
    assertEquals(res.status, 503);
    assertEquals(res.headers.get('Retry-After'), String(PAUSED_RETRY_AFTER));
    assertEquals(await res.json(), { error: 'unavailable', message: 'Tag suggestions are turned off' });
    assertEquals(store.steps, []);
  });
});

Deno.test('AI_MODEL_RECIPE=off turns tagging off too while AI_MODEL_TAGS is unset', async () => {
  await withEnv({ AI_MODEL_RECIPE: 'off' }, async () => {
    const { post } = setup();
    assertEquals((await post(TIKKA)).status, 503);
  });
});

Deno.test('a provider error is 503 unavailable with Retry-After 30 s, logged as api_error', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const err = new APICallError({ message: 'overloaded', url: 'https://x', requestBodyValues: {}, statusCode: 503, isRetryable: false });
    const { store, post } = setup({ model: failing(err) });
    const res = await post(TIKKA);
    assertEquals(res.status, 503);
    assertEquals(res.headers.get('Retry-After'), String(AI_FAILED_RETRY_AFTER));
    assertEquals((await res.json()).error, 'unavailable');
    assertEquals(store.aiCalls.map((c) => c.status), ['api_error']);
  });
});

Deno.test('a timeout is 503 unavailable', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const timeout = new DOMException('The operation timed out', 'TimeoutError');
    const { store, post } = setup({ model: failing(timeout as unknown as Error) });
    const res = await post(TIKKA);
    assertEquals(res.status, 503);
    assertEquals(store.aiCalls.map((c) => c.status), ['timeout']);
  });
});

Deno.test('output that fails the schema is 503 unavailable, logged as invalid_output', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { store, post } = setup({ model: answering({ meal: 'dinner' }) });
    const res = await post(TIKKA);
    assertEquals(res.status, 503);
    assertEquals(res.headers.get('Retry-After'), String(AI_FAILED_RETRY_AFTER));
    assertEquals(store.aiCalls.map((c) => c.status), ['invalid_output']);
  });
});

Deno.test('an unexpected store error is a 500 internal_error', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { store, post } = setup();
    store.checkLimit = () => Promise.reject(new Error('db down'));
    const res = await post(TIKKA);
    assertEquals(res.status, 500);
    assertEquals((await res.json()).error, 'internal_error');
  });
});

Deno.test('an invalid request never reaches the plan check', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { store, post } = setup();
    const res = await post({ name: '   ', notes: null, ingredients: [] });
    assertEquals(res.status, 400);
    assertEquals(store.steps, []);
  });
});
