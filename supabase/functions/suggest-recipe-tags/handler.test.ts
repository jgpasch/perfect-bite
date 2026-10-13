// suggest-recipe-tags (spec 6.7) end to end through handleRequest, with a fake store and the mock
// or a MockLanguageModelV4. Nothing touches the network.
import { emptyRecipeTags, type SuggestRecipeTagsRequestInput } from '@shared/index.ts';
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { APICallError, type LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { SUGGEST_RECIPE_TAGS_PROMPT_VERSION } from '../_shared/ai/prompts/suggest-recipe-tags.v1.ts';
import type { AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { NotEntitledError, type Feature } from '../_shared/entitlements.ts';
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
  /** Every step, in order: `feature:<name>`, `limit`, `ai_call`. */
  steps: string[] = [];
  aiCalls: AiCallRecord[] = [];
  features = new Set<Feature>(['categorize', 'recipe_import', 'recipe_tags']);
  limit: LimitResult = 'ok';

  async requireFeature(feature: Feature) {
    this.steps.push(`feature:${feature}`);
    if (!this.features.has(feature)) throw new NotEntitledError(feature);
  }
  async checkLimit() {
    this.steps.push('limit');
    return this.limit;
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

function setup(overrides: Partial<SuggestDeps> = {}) {
  const store = new FakeStore();
  const deps: SuggestDeps = { store, ...overrides };
  const post = (body: unknown) =>
    handleRequest(new Request(ENDPOINT, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), {
      suggestRecipeTags: (request) => suggestRecipeTags(request, deps),
      env: (k) => Deno.env.get(k),
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

const tags = (partial: Partial<ReturnType<typeof emptyRecipeTags>>) => ({ ...emptyRecipeTags(), ...partial });

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
    assertEquals(store.steps, ['feature:recipe_tags', 'limit', 'ai_call']);
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
    assertEquals((await res.json()).tags, emptyRecipeTags());
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

Deno.test('ai_calls gets the prompt and output with no user id', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { store, post } = setup();
    await post(TIKKA);
    const [call] = store.aiCalls;
    assertEquals(call.status, 'ok');
    assertEquals(call.prompt_version, SUGGEST_RECIPE_TAGS_PROMPT_VERSION);
    assertStringIncludes(call.prompt, '2 lb chicken thighs, skinless');
    assertEquals(call.output, { meal: [], cuisine: ['indian'], protein: ['chicken'], diet: [], method: [] });
    assert(!('user_id' in call));
  });
});

// --- Order and refusals ---------------------------------------------------------------------------

Deno.test('not_entitled is 403 before the limit or any model work', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { store, post } = setup();
    store.features.delete('recipe_tags');
    const res = await post(TIKKA);
    assertEquals(res.status, 403);
    assertEquals(await res.json(), { error: 'not_entitled', message: "Tag suggestions aren't included in your plan" });
    assertEquals(store.steps, ['feature:recipe_tags']);
  });
});

Deno.test('not_entitled comes first even with the kill switch on', async () => {
  await withEnv({ AI_MODEL_TAGS: 'off' }, async () => {
    const { store, post } = setup();
    store.features.clear();
    assertEquals((await post(TIKKA)).status, 403);
    assertEquals(store.steps, ['feature:recipe_tags']);
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
    assertEquals(store.steps, ['feature:recipe_tags', 'limit']);
  });
});

Deno.test('the global cap is 503 unavailable with Retry-After an hour, and no model call', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock' }, async () => {
    const { store, post } = setup();
    store.limit = 'global_cap';
    const res = await post(TIKKA);
    assertEquals(res.status, 503);
    assertEquals(res.headers.get('Retry-After'), String(PAUSED_RETRY_AFTER));
    assertEquals((await res.json()).error, 'unavailable');
    assertEquals(store.steps, ['feature:recipe_tags', 'limit']);
  });
});

Deno.test('AI_MODEL_TAGS=off is 503 unavailable, using no budget and calling no model', async () => {
  await withEnv({ AI_MODEL_TAGS: 'off', AI_MODEL_RECIPE: 'mock' }, async () => {
    const { store, post } = setup();
    const res = await post(TIKKA);
    assertEquals(res.status, 503);
    assertEquals(res.headers.get('Retry-After'), String(PAUSED_RETRY_AFTER));
    assertEquals(await res.json(), { error: 'unavailable', message: 'Tag suggestions are turned off' });
    assertEquals(store.steps, ['feature:recipe_tags']);
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
