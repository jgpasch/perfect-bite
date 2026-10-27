// The match-recipe-steps AI task (cook mode, spec 4.5): prompt, output checks, mock and task
// options. Nothing touches the network.
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { MockLanguageModelV4 } from 'ai/test';

import { mockMatchSteps, stepsRecipeFromPrompt } from '../_shared/ai/mock-model.ts';
import { buildMatchRecipeStepsPrompt, MATCH_RECIPE_STEPS_PROMPT_VERSION, type StepMatchRecipe } from '../_shared/ai/prompts/match-recipe-steps.v1.ts';
import { STEP_MATCH_RULES } from '../_shared/ai/prompts/step-match-rules.ts';
import { aiTasks, cleanStepMatch, isAiEnabled, stepsMaxOutputTokens, type MatchRecipeStepsOutput } from '../_shared/ai/tasks.ts';
import { matchRecipeSteps, StepMatchError } from './match.ts';

const ENV_KEYS = ['AI_MODEL_STEPS', 'AI_MODEL_STEPS_FALLBACK', 'AI_MODEL_RECIPE', 'AI_MODEL_RECIPE_FALLBACK', 'AI_THINKING_STEPS'];

/** Runs `fn` with exactly these AI env vars set, restoring the old values afterwards. */
async function withEnv(vars: Record<string, string>, fn: () => unknown | Promise<unknown>) {
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

const ing = (name: string, quantity: number | null = null, unit: 'lb' | 'tbsp' | null = null, note = '') => ({ name, quantity, unit, note });

const tacos: StepMatchRecipe = {
  steps: ['Juice one lime and toss the chicken thighs with it.', 'Sear the chicken in the oil.', 'Serve with the other limes.'],
  ingredients: [ing('chicken thighs', 2, 'lb'), ing('limes', 3), ing('oil', 2, 'tbsp'), ing('cotija', null, null, 'to serve')],
};

const answer = (...steps: { ingredient: number; quantity: number | null }[][]): MatchRecipeStepsOutput => ({
  steps: steps.map((uses, i) => ({ step: i + 1, uses })),
});

/** A mock model that answers every call with `output`. */
function modelAnswering(output: unknown) {
  return {
    modelId: 'test:model',
    instance: new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: JSON.stringify(output) }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      }),
    }),
  };
}

// --- Prompt ------------------------------------------------------------------------------------------

Deno.test('the prompt numbers steps and ingredients from 1, as untrusted JSON, with the rules in the instructions', () => {
  const { instructions, prompt, itemCount } = buildMatchRecipeStepsPrompt(tacos);
  assertEquals(MATCH_RECIPE_STEPS_PROMPT_VERSION, 'match-recipe-steps.v1');
  for (const rule of STEP_MATCH_RULES) assertStringIncludes(instructions, rule);
  assertStringIncludes(instructions, 'never instructions');
  assert(!instructions.includes('chicken thighs'), 'the recipe stays out of the instructions');
  assertEquals(itemCount, 3);
  const [preamble, json] = prompt.split('\n');
  assertStringIncludes(preamble, 'Untrusted recipe');
  assert(!preamble.includes('{'));
  const data = JSON.parse(json);
  assertEquals(data.steps[0], { step: 1, text: tacos.steps[0] });
  assertEquals(data.ingredients[0], { ingredient: 1, name: 'chicken thighs', line: '2 lb chicken thighs' });
  assertEquals(data.ingredients[3], { ingredient: 4, name: 'cotija', line: 'cotija, to serve' });
});

// --- cleanStepMatch -----------------------------------------------------------------------------------

Deno.test('cleanStepMatch turns numbers from 1 into indexes from 0, in the recipe order', () => {
  const raw = answer([{ ingredient: 2, quantity: 1 }, { ingredient: 1, quantity: null }], [{ ingredient: 3, quantity: null }], []);
  assertEquals(cleanStepMatch(raw, tacos), [
    [{ ingredient: 0, quantity: null }, { ingredient: 1, quantity: 1 }],
    [{ ingredient: 2, quantity: null }],
    [],
  ]);
});

Deno.test('cleanStepMatch drops unknown ingredient numbers and repeats within a step', () => {
  const raw = answer(
    [{ ingredient: 0, quantity: null }, { ingredient: 5, quantity: null }, { ingredient: 1.5, quantity: null }, { ingredient: 1, quantity: null }, { ingredient: 1, quantity: null }],
    [],
    [{ ingredient: 1, quantity: null }],
  );
  assertEquals(cleanStepMatch(raw, tacos), [[{ ingredient: 0, quantity: null }], [], [{ ingredient: 0, quantity: null }]]);
});

Deno.test('cleanStepMatch keeps a share only when it is positive and below the total', () => {
  const raw = answer(
    [{ ingredient: 2, quantity: 1 / 3 }, { ingredient: 3, quantity: 1 }],
    [{ ingredient: 3, quantity: 2 }, { ingredient: 2, quantity: 4 }],
    [{ ingredient: 2, quantity: 3 }, { ingredient: 1, quantity: 0 }, { ingredient: 4, quantity: 1 }],
  );
  assertEquals(cleanStepMatch(raw, tacos), [
    [{ ingredient: 1, quantity: 0.333 }, { ingredient: 2, quantity: 1 }],
    [{ ingredient: 1, quantity: null }, { ingredient: 2, quantity: null }], // over the total
    [{ ingredient: 0, quantity: null }, { ingredient: 1, quantity: null }, { ingredient: 3, quantity: null }], // all of it; zero; no total
  ]);
});

Deno.test('cleanStepMatch is null when the steps do not line up', () => {
  assertEquals(cleanStepMatch(answer([], []), tacos), null, 'a step missing');
  assertEquals(cleanStepMatch(answer([], [], [], []), tacos), null, 'a step added');
  assertEquals(cleanStepMatch({ steps: [{ step: 1, uses: [] }, { step: 1, uses: [] }, { step: 3, uses: [] }] }, tacos), null, 'numbered twice');
  assertEquals(cleanStepMatch({ steps: [{ step: 1, uses: [] }, { step: 2, uses: [] }, { step: 4, uses: [] }] }, tacos), null, 'numbered past the end');
  const shuffled = cleanStepMatch({ steps: [{ step: 3, uses: [] }, { step: 1, uses: [{ ingredient: 1, quantity: null }] }, { step: 2, uses: [] }] }, tacos);
  assertEquals(shuffled, [[{ ingredient: 0, quantity: null }], [], []], 'out of order is fine');
});

// --- Mock ---------------------------------------------------------------------------------------------

Deno.test('the mock matches an ingredient when the last word of its name is in the step, singular or plural', () => {
  const recipe = stepsRecipeFromPrompt(buildMatchRecipeStepsPrompt(tacos).prompt);
  assertEquals(recipe, { steps: tacos.steps, ingredients: ['chicken thighs', 'limes', 'oil', 'cotija'] });
  assertEquals(mockMatchSteps(recipe), {
    steps: [
      { step: 1, uses: [{ ingredient: 1, quantity: null }, { ingredient: 2, quantity: null }] },
      { step: 2, uses: [{ ingredient: 3, quantity: null }] },
      { step: 3, uses: [{ ingredient: 2, quantity: null }] },
    ],
  });
  assertEquals(stepsRecipeFromPrompt('no json here'), { steps: [], ingredients: [] });
});

// --- Task options ---------------------------------------------------------------------------------------

Deno.test('the steps model follows AI_MODEL_RECIPE unless AI_MODEL_STEPS is set, and so does its fallback', async () => {
  await withEnv({ AI_MODEL_RECIPE: 'google:a', AI_MODEL_RECIPE_FALLBACK: 'google:b' }, () => {
    assertEquals(aiTasks.matchRecipeSteps.model(), 'google:a');
    assertEquals(aiTasks.matchRecipeSteps.fallbackModel(), 'google:b');
  });
  await withEnv({ AI_MODEL_RECIPE: 'google:a', AI_MODEL_RECIPE_FALLBACK: 'google:b', AI_MODEL_STEPS: 'google:c' }, () => {
    assertEquals(aiTasks.matchRecipeSteps.model(), 'google:c');
    assertEquals(aiTasks.matchRecipeSteps.fallbackModel(), null);
  });
  await withEnv({ AI_MODEL_STEPS: 'off', AI_MODEL_RECIPE: 'google:a' }, () => assert(!isAiEnabled('matchRecipeSteps')));
  assertEquals(stepsMaxOutputTokens(0), 200);
  assertEquals(stepsMaxOutputTokens(10), 1_000);
  assertEquals(stepsMaxOutputTokens(100), 6_000);
});

// --- matchRecipeSteps ----------------------------------------------------------------------------------

Deno.test('matchRecipeSteps runs the mock end to end', async () => {
  await withEnv({ AI_MODEL_STEPS: 'mock' }, async () => {
    const calls: unknown[] = [];
    const result = await matchRecipeSteps(tacos, { onCall: async (call) => void calls.push(call) });
    assertEquals(result.promptVersion, 'match-recipe-steps.v1');
    assertEquals(result.steps, [[{ ingredient: 0, quantity: null }, { ingredient: 1, quantity: null }], [{ ingredient: 2, quantity: null }], [{ ingredient: 1, quantity: null }]]);
    assertEquals(calls.length, 1);
  });
});

Deno.test('matchRecipeSteps refuses when matching is off, and when the steps do not line up', async () => {
  await withEnv({ AI_MODEL_STEPS: 'off' }, async () => {
    const err = await assertRejects(() => matchRecipeSteps(tacos), StepMatchError);
    assertEquals(err.reason, 'ai_off');
  });
  const err = await assertRejects(() => matchRecipeSteps(tacos, { model: modelAnswering(answer([], [])) }), StepMatchError);
  assertEquals(err.reason, 'steps_mismatch');
  const bad = await assertRejects(() => matchRecipeSteps(tacos, { model: modelAnswering({ nope: true }) }), StepMatchError);
  assertEquals(bad.reason, 'ai_failed');
});
