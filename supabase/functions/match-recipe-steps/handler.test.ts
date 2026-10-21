// match-recipe-steps (spec 6.8) end to end through handleRequest, with a fake store and the mock
// or a MockLanguageModelV4. Nothing touches the network.
import type { MatchRecipeStepsRequestInput } from '@shared/index.ts';
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { APICallError, type LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { MATCH_RECIPE_STEPS_PROMPT_VERSION } from '../_shared/ai/prompts/match-recipe-steps.v1.ts';
import type { AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import type { LimitResult } from '../categorize-ingredients/handler.ts';
import { matchSteps, type MatchStepsDeps, type StepMatchStore } from './handler.ts';
import { AI_FAILED_RETRY_AFTER, handleRequest, PAUSED_RETRY_AFTER } from './request.ts';

const ENDPOINT = 'http://localhost/functions/v1/match-recipe-steps';
const ENV_KEYS = ['AI_MODEL_STEPS', 'AI_MODEL_STEPS_FALLBACK', 'AI_MODEL_RECIPE', 'AI_MODEL_RECIPE_FALLBACK'];

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

class FakeStore implements StepMatchStore {
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

/** A model answering every call with `answer`, keeping each prompt it was sent. */
function answering(answer: unknown): { instance: LanguageModel; modelId: string; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    instance: new MockLanguageModelV4({
      doGenerate: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        return {
          content: [{ type: 'text', text: JSON.stringify(answer) }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        };
      },
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

function setup(overrides: Partial<MatchStepsDeps> = {}) {
  const store = new FakeStore();
  const deps: MatchStepsDeps = { store, caller: CALLER, ...overrides };
  const post = (body: unknown) =>
    handleRequest(new Request(ENDPOINT, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), {
      matchSteps: (request) => matchSteps(request, deps),
      env: (k) => Deno.env.get(k),
      now: () => Date.parse('2026-10-18T12:00:00Z'),
    });
  return { store, post };
}

const ing = (id: string, name: string, quantity: number | null = null, unit: 'lb' | 'tbsp' | null = null, note = '') => ({ id, name, quantity, unit, note });

const TACOS: MatchRecipeStepsRequestInput = {
  steps: ['Juice one lime and toss the chicken thighs with it.', 'Sear the chicken in the oil.', 'Serve with the other limes.'],
  ingredients: [
    ing('ing-thighs', 'chicken thighs', 2, 'lb'),
    ing('ing-limes', 'limes', 3),
    ing('ing-oil', 'oil', 2, 'tbsp'),
    ing('ing-cotija', 'cotija', null, null, 'to serve'),
  ],
};

const answer = (...steps: { ingredient: number; quantity: number | null }[][]) => ({ steps: steps.map((uses, i) => ({ step: i + 1, uses })) });

// --- Success ------------------------------------------------------------------------------------

Deno.test('the mock matches end to end, answering with the request ids and the prompt version', async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const { store, post } = setup();
    const res = await post(TACOS);
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      steps: [
        [{ id: 'ing-thighs', quantity: null }, { id: 'ing-limes', quantity: null }],
        [{ id: 'ing-oil', quantity: null }],
        [{ id: 'ing-limes', quantity: null }],
      ],
      promptVersion: MATCH_RECIPE_STEPS_PROMPT_VERSION,
    });
    assertEquals(store.steps, ['limit', 'ai_call']);
  });
});

Deno.test('AI_MODEL_STEPS unset falls back to AI_MODEL_RECIPE', async () => {
  await withEnv({ AI_MODEL_RECIPE: 'mock' }, async () => {
    const { store, post } = setup();
    assertEquals((await post(TACOS)).status, 200);
    assertEquals(store.aiCalls[0].model, 'mock');
    assertEquals(store.aiCalls[0].task, 'matchRecipeSteps');
  });
});

Deno.test('the model numbers map back to the request ids, with shares, in the request order', async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const model = answering(answer([{ ingredient: 2, quantity: 1 }, { ingredient: 1, quantity: null }], [{ ingredient: 3, quantity: null }], [{ ingredient: 2, quantity: 2 }]));
    const { post } = setup({ model });
    const res = await post(TACOS);
    assertEquals((await res.json()).steps, [
      [{ id: 'ing-thighs', quantity: null }, { id: 'ing-limes', quantity: 1 }],
      [{ id: 'ing-oil', quantity: null }],
      [{ id: 'ing-limes', quantity: 2 }],
    ]);
  });
});

Deno.test('an ingredient with an empty name is not sent, so the numbers skip it and map to the right ids', async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const model = answering(answer([{ ingredient: 1, quantity: null }, { ingredient: 2, quantity: null }]));
    const { post } = setup({ model });
    const res = await post({ steps: ['Fry the egg in the butter.'], ingredients: [ing('a', '  '), ing('b', 'egg'), ing('c', 'butter')] });
    assertEquals((await res.json()).steps, [[{ id: 'b', quantity: null }, { id: 'c', quantity: null }]]);
    assert(!model.prompts[0].includes('"a"'));
  });
});

Deno.test('a blank step is not sent and answers with no ingredients, keeping the others in line', async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const model = answering(answer([{ ingredient: 1, quantity: null }], [{ ingredient: 2, quantity: null }]));
    const { post } = setup({ model });
    const res = await post({ steps: ['Crack the egg.', '   ', 'Melt the butter.'], ingredients: [ing('b', 'egg'), ing('c', 'butter')] });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).steps, [[{ id: 'b', quantity: null }], [], [{ id: 'c', quantity: null }]]);
  });
});

Deno.test('unknown or repeated ingredient numbers are dropped, and a share over the total is null', async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const model = answering(answer([{ ingredient: 9, quantity: null }, { ingredient: 2, quantity: 5 }, { ingredient: 2, quantity: 1 }], [], []));
    const { post } = setup({ model });
    assertEquals((await (await post(TACOS)).json()).steps, [[{ id: 'ing-limes', quantity: null }], [], []]);
  });
});

Deno.test('ai_calls gets the prompt, the output and the caller, with no household or ingredient ids', async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const { store, post } = setup();
    await post(TACOS);
    const [call] = store.aiCalls;
    assertEquals(call.status, 'ok');
    assertEquals(call.prompt_version, MATCH_RECIPE_STEPS_PROMPT_VERSION);
    assertStringIncludes(call.prompt, '2 lb chicken thighs');
    assert(!call.prompt.includes('ing-thighs'), 'the ids never reach the model');
    assertEquals([call.user_id, call.household_id], [CALLER.userId, null]);
  });
});

Deno.test('a failed call is logged with the caller too', async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const { store, post } = setup({ model: answering({ nope: true }) });
    assertEquals((await post(TACOS)).status, 503);
    assertEquals(store.aiCalls.map((c) => [c.status, c.user_id, c.household_id]), [['invalid_output', CALLER.userId, null]]);
  });
});

const HOUSEHOLD_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

Deno.test('a household the caller is in is recorded on ai_calls, checked once after the limit', async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const { store, post } = setup();
    store.households.add(HOUSEHOLD_ID);
    assertEquals((await post({ ...TACOS, householdId: HOUSEHOLD_ID })).status, 200);
    assertEquals(store.aiCalls.map((c) => [c.user_id, c.household_id]), [[CALLER.userId, HOUSEHOLD_ID]]);
    assertEquals(store.steps, ['limit', `member:${HOUSEHOLD_ID}`, 'ai_call']);
  });
});

Deno.test("a household the caller isn't in is ignored: the match still answers, with no household on the row", async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const { store, post } = setup();
    const res = await post({ ...TACOS, householdId: HOUSEHOLD_ID });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).steps[1], [{ id: 'ing-oil', quantity: null }]);
    assertEquals(store.aiCalls.map((c) => [c.user_id, c.household_id]), [[CALLER.userId, null]]);
  });
});

Deno.test('a failed call carries the household too', async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const { store, post } = setup({ model: answering({ nope: true }) });
    store.households.add(HOUSEHOLD_ID);
    assertEquals((await post({ ...TACOS, householdId: HOUSEHOLD_ID })).status, 503);
    assertEquals(store.aiCalls.map((c) => [c.status, c.household_id]), [['invalid_output', HOUSEHOLD_ID]]);
  });
});

Deno.test('a householdId that is not a uuid is 400 invalid_request, with nothing counted', async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const { store, post } = setup();
    const res = await post({ ...TACOS, householdId: 42 });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, 'invalid_request');
    assertEquals(store.steps, []);
  });
});

Deno.test('a refused match (limit) never asks about the household', async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const { store, post } = setup();
    store.limit = 'daily_limit';
    assertEquals((await post({ ...TACOS, householdId: HOUSEHOLD_ID })).status, 429);
    assertEquals(store.steps, ['limit']);
  });
});

// --- Order and refusals ---------------------------------------------------------------------------

Deno.test('answers a user on the free plan (no feature check)', async () => {
  // Step ingredients are for everyone (spec 4.12). A store whose plan check would refuse every
  // feature, as the old `requireFeature` did for a plan without `step_ingredients`, is never asked.
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const { store, post } = setup();
    Object.assign(store, {
      requireFeature(feature: string) {
        store.steps.push(`feature:${feature}`);
        return Promise.reject(new Error(`Your plan doesn't include ${feature}`));
      },
    });
    const res = await post(TACOS);
    assertEquals(res.status, 200);
    assertEquals((await res.json()).steps, [
      [{ id: 'ing-thighs', quantity: null }, { id: 'ing-limes', quantity: null }],
      [{ id: 'ing-oil', quantity: null }],
      [{ id: 'ing-limes', quantity: null }],
    ]);
    assertEquals(store.steps, ['limit', 'ai_call']);
  });
});

Deno.test('AI_MODEL_STEPS=off is 503 unavailable, using no budget and calling no model', async () => {
  await withEnv({ AI_MODEL_STEPS: 'off', AI_MODEL_RECIPE: 'mock' }, async () => {
    const { store, post } = setup();
    const res = await post(TACOS);
    assertEquals(res.status, 503);
    assertEquals(res.headers.get('Retry-After'), String(PAUSED_RETRY_AFTER));
    assertEquals(await res.json(), { error: 'unavailable', message: 'Step matching is turned off' });
    assertEquals(store.steps, []);
  });
});

Deno.test('AI_MODEL_RECIPE=off turns matching off too while AI_MODEL_STEPS is unset', async () => {
  await withEnv({ AI_MODEL_RECIPE: 'off' }, async () => {
    const { store, post } = setup();
    assertEquals((await post(TACOS)).status, 503);
    assertEquals(store.aiCalls, []);
  });
});

Deno.test('the per-user limit is 429 rate_limited with no model call', async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const { store, post } = setup();
    store.limit = 'user_limit';
    const res = await post(TACOS);
    assertEquals(res.status, 429);
    assertEquals(res.headers.get('Retry-After'), null);
    assertEquals(await res.json(), { error: 'rate_limited', message: 'Too many step matches; try again later' });
    assertEquals(store.steps, ['limit']);
  });
});

Deno.test('the daily limit is 429 daily_limit with the next UTC midnight as resets_at, and no model call', async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const { store, post } = setup();
    store.limit = 'daily_limit';
    const res = await post(TACOS);
    assertEquals(res.status, 429);
    assertEquals(res.headers.get('Retry-After'), null);
    assertEquals(await res.json(), {
      error: 'daily_limit',
      message: "Today's step matches are used up",
      resets_at: '2026-10-19T00:00:00.000Z',
    });
    assertEquals(store.steps, ['limit']);
    assertEquals(store.aiCalls, []);
  });
});

Deno.test('the monthly limit is 429 limit_reached with next month as resets_at, and no model call', async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const { store, post } = setup();
    store.limit = 'monthly_limit';
    const res = await post(TACOS);
    assertEquals(res.status, 429);
    assertEquals(res.headers.get('Retry-After'), null);
    assertEquals(await res.json(), {
      error: 'limit_reached',
      message: "This month's step matches are used up",
      resets_at: '2026-11-01T00:00:00.000Z',
    });
    assertEquals(store.steps, ['limit']);
    assertEquals(store.aiCalls, []);
  });
});

Deno.test('a provider error is 503 unavailable with Retry-After 30 s, logged as api_error', async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const err = new APICallError({ message: 'overloaded', url: 'https://x', requestBodyValues: {}, statusCode: 503, isRetryable: false });
    const { store, post } = setup({ model: failing(err) });
    const res = await post(TACOS);
    assertEquals(res.status, 503);
    assertEquals(res.headers.get('Retry-After'), String(AI_FAILED_RETRY_AFTER));
    assertEquals((await res.json()).error, 'unavailable');
    assertEquals(store.aiCalls.map((c) => c.status), ['api_error']);
  });
});

Deno.test('a timeout is 503 unavailable', async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const timeout = new DOMException('The operation timed out', 'TimeoutError');
    const { store, post } = setup({ model: failing(timeout as unknown as Error) });
    const res = await post(TACOS);
    assertEquals(res.status, 503);
    assertEquals(res.headers.get('Retry-After'), String(AI_FAILED_RETRY_AFTER));
    assertEquals(store.aiCalls.map((c) => c.status), ['timeout']);
  });
});

Deno.test('output that fails the schema is 503 unavailable, logged as invalid_output', async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const { store, post } = setup({ model: answering({ steps: 'all of them' }) });
    const res = await post(TACOS);
    assertEquals(res.status, 503);
    assertEquals(res.headers.get('Retry-After'), String(AI_FAILED_RETRY_AFTER));
    assertEquals(store.aiCalls.map((c) => c.status), ['invalid_output']);
  });
});

Deno.test("an answer whose steps don't line up is 503 unavailable with Retry-After 30 s", async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const { post } = setup({ model: answering(answer([], [])) });
    const res = await post(TACOS);
    assertEquals(res.status, 503);
    assertEquals(res.headers.get('Retry-After'), String(AI_FAILED_RETRY_AFTER));
    assertStringIncludes((await res.json()).message, "don't match the recipe's");
  });
});

Deno.test('an unexpected store error is a 500 internal_error', async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const { store, post } = setup();
    store.checkLimit = () => Promise.reject(new Error('db down'));
    const res = await post(TACOS);
    assertEquals(res.status, 500);
    assertEquals((await res.json()).error, 'internal_error');
  });
});

Deno.test('an invalid request never reaches the plan check', async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const { store, post } = setup();
    const res = await post({ steps: ['  '], ingredients: TACOS.ingredients });
    assertEquals(res.status, 400);
    assertEquals(store.steps, []);
  });
});
