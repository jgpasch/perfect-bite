// The step-matching eval's harness (cook mode, spec 4.5): parsing recipes.json, scoring and the
// report, with the mock model; nothing touches the network.
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';

import { EvalUsageError, formatReport, parseArgs, parseRecipes, run, scoreRecipe, type EvalIo, type EvalRecipe } from './eval.ts';

const ing = (name: string, quantity: number | null = null) => ({ name, quantity, unit: null, note: '' });

const recipe: EvalRecipe = {
  id: 'tiny',
  source: 'test',
  name: 'Tiny tacos',
  steps: ['Juice one lime over the chicken.', 'Sear the chicken.', 'Serve with the other limes and salt.'],
  ingredients: [ing('chicken', 1), ing('limes', 3), ing('salt')],
  expected: [{ uses: [0, 1], shares: { '1': 1 } }, { uses: [], optional: [0] }, { uses: [1], shares: { '1': 2 }, any_share: [] }],
};

const file = (recipes: unknown[]) => ({ recipes });

// --- parseRecipes ---------------------------------------------------------------------------------

Deno.test('parseRecipes accepts the shipped recipes.json', async () => {
  const recipes = parseRecipes(JSON.parse(await Deno.readTextFile(new URL('./recipes.json', import.meta.url))));
  assert(recipes.length >= 15, 'at least 15 recipes');
  assert(recipes.every((r) => r.expected.length === r.steps.length));
});

Deno.test('parseRecipes refuses bad labels', () => {
  assertThrows(() => parseRecipes(file([recipe, recipe])), EvalUsageError, 'listed twice');
  assertThrows(() => parseRecipes(file([{ ...recipe, expected: recipe.expected.slice(1) }])), EvalUsageError, '3 steps but 2 expected');
  assertThrows(() => parseRecipes(file([{ ...recipe, expected: [{ uses: [7] }, { uses: [] }, { uses: [] }] }])), EvalUsageError, "isn't there");
  assertThrows(() => parseRecipes(file([{ ...recipe, expected: [{ uses: [0], optional: [0] }, { uses: [] }, { uses: [] }] }])), EvalUsageError, 'both needed and optional');
  assertThrows(() => parseRecipes(file([{ ...recipe, expected: [{ uses: [0], shares: { '1': 1 } }, { uses: [] }, { uses: [] }] }])), EvalUsageError, "doesn't need");
  assertThrows(() => parseRecipes({ recipes: [] }), EvalUsageError, 'invalid');
});

// --- scoreRecipe ------------------------------------------------------------------------------------

Deno.test('scoreRecipe counts right, wrong and missed pairs, skipping optional ones', () => {
  const o = scoreRecipe(recipe, [
    [{ ingredient: 0, quantity: null }, { ingredient: 1, quantity: 1 }],
    [{ ingredient: 0, quantity: null }, { ingredient: 2, quantity: null }],
    [],
  ]);
  assertEquals([o.right, o.wrong, o.missed], [2, 1, 1]);
  assertEquals(o.pairMisses, [
    { step: 2, ingredient: 2, kind: 'wrong' },
    { step: 3, ingredient: 1, kind: 'missed' },
  ]);
  assertEquals(o.unplaced, 0);
});

Deno.test('scoreRecipe scores shares: the split where labelled, none elsewhere', () => {
  const o = scoreRecipe(recipe, [
    [{ ingredient: 0, quantity: 0.5 }, { ingredient: 1, quantity: 1.01 }],
    [],
    [{ ingredient: 1, quantity: null }],
  ]);
  assertEquals([o.sharesScored, o.sharesRight], [3, 1]);
  assertEquals(o.shareMisses, [
    { step: 1, ingredient: 0, expected: null, got: 0.5 },
    { step: 3, ingredient: 1, expected: 2, got: null },
  ]);
  assertEquals(o.unplaced, 1, 'salt is in no step');
});

Deno.test('scoreRecipe counts a failed match as every needed pair missed', () => {
  const o = scoreRecipe(recipe, null, [], 'ai_failed: boom');
  assertEquals([o.right, o.wrong, o.missed], [0, 0, 3]);
  assertStringIncludes(formatReport([o]), 'error: ai_failed: boom');
});

Deno.test('formatReport prints the totals, the bar and every miss', () => {
  const perfect = scoreRecipe(recipe, [
    [{ ingredient: 0, quantity: null }, { ingredient: 1, quantity: 1 }],
    [],
    [{ ingredient: 1, quantity: 2 }],
  ]);
  const report = formatReport([perfect], { input: 0.5, output: 2 });
  assertStringIncludes(report, 'precision:  3/3 (100%)');
  assertStringIncludes(report, 'recall:     3/3 (100%)');
  assertStringIncludes(report, 'shares:     3/3 (100%)');
  assertStringIncludes(report, 'bar:        met');
  assertStringIncludes(report, 'No misses.');
  const bad = formatReport([scoreRecipe(recipe, [[], [{ ingredient: 2, quantity: null }], []])]);
  assertStringIncludes(bad, 'bar:        NOT met');
  assertStringIncludes(bad, 'step 2: wrong salt');
  assertStringIncludes(bad, 'step 1: missed chicken');
});

// --- parseArgs and run --------------------------------------------------------------------------------

Deno.test('parseArgs reads the model, --only and the prices', () => {
  assertEquals(parseArgs(['--model', 'mock', '--only', 'a', '--only=b', '--price-in', '0.3', '--price-out=2.5']), {
    model: 'mock',
    only: ['a', 'b'],
    priceIn: 0.3,
    priceOut: 2.5,
    help: false,
  });
  assertThrows(() => parseArgs(['--price-in', 'free']), EvalUsageError, 'needs a price');
  assertThrows(() => parseArgs(['--what']), EvalUsageError, 'Unknown option');
});

function io(recipes: unknown): { evalIo: EvalIo; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    evalIo: { out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`), readRecipes: async () => JSON.stringify(recipes), env: () => undefined },
    out: () => out,
    err: () => err,
  };
}

Deno.test('run scores the mock end to end and restores AI_MODEL_STEPS', async () => {
  const saved = Deno.env.get('AI_MODEL_STEPS');
  Deno.env.set('AI_MODEL_STEPS', 'google:untouched');
  try {
    const { evalIo, out, err } = io(file([recipe]));
    assertEquals(await run(['--model', 'mock'], evalIo), 0);
    assertStringIncludes(err(), 'its score means nothing');
    assertStringIncludes(out(), '1 recipes, model mock');
    assertStringIncludes(out(), 'tiny');
    assertEquals(Deno.env.get('AI_MODEL_STEPS'), 'google:untouched');
  } finally {
    if (saved === undefined) Deno.env.delete('AI_MODEL_STEPS');
    else Deno.env.set('AI_MODEL_STEPS', saved);
  }
});

Deno.test('run refuses an unknown --only id and a missing model', async () => {
  const unknown = io(file([recipe]));
  assertEquals(await run(['--model', 'mock', '--only', 'nope'], unknown.evalIo), 2);
  assertStringIncludes(unknown.err(), 'No recipe with id nope');
  const noModel = io(file([recipe]));
  assertEquals(await run([], noModel.evalIo), 2);
  assertStringIncludes(noModel.err(), 'The eval needs a model');
});
