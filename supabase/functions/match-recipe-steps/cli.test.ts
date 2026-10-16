// Tests for `yarn ai:steps` with the mock models; nothing touches the network.
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';

import { CliUsageError, formatAmount, formatMatch, matchIndexes, parseArgs, run, type CliIo } from './cli.ts';

const MODEL_VARS = ['AI_MODEL_STEPS', 'AI_MODEL_RECIPE', 'AI_MODEL_CATEGORIZE'] as const;

/** Runs `fn` with the model env vars set (null = unset), and checks the CLI restored them. */
async function withEnv<T>(values: Record<(typeof MODEL_VARS)[number], string | null>, fn: () => Promise<T>): Promise<T> {
  const saved = MODEL_VARS.map((k) => [k, Deno.env.get(k)] as const);
  for (const k of MODEL_VARS) {
    if (values[k] === null) Deno.env.delete(k);
    else Deno.env.set(k, values[k]!);
  }
  try {
    const result = await fn();
    for (const k of MODEL_VARS) assertEquals(Deno.env.get(k) ?? null, values[k], `${k} restored`);
    return result;
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

function io(extra: Partial<CliIo> = {}) {
  let out = '';
  let err = '';
  const cliIo: CliIo = { out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`), env: (k) => Deno.env.get(k), ...extra };
  return { cliIo, out: () => out, err: () => err };
}

const typed = ['--step', 'Toss the chicken thighs with the lime.', '--step', 'Serve.', '--ingredient', '2 lb chicken thighs', '--ingredient', '3 limes', '--ingredient', '2 oz cotija, to serve'];

// --- parseArgs ----------------------------------------------------------------------------------

Deno.test('parseArgs reads a URL, a file, or repeated steps and ingredients, and the flags', () => {
  assertEquals(parseArgs(['https://example.com/r', '--model', 'mock', '--quiet']).url, 'https://example.com/r');
  assertEquals(parseArgs(['--file=page.html', '--recipe-model', 'mock', '--json']).file, 'page.html');
  const args = parseArgs([...typed, '--raw', '--dry-run']);
  assertEquals(args.steps, ['Toss the chicken thighs with the lime.', 'Serve.']);
  assertEquals(args.ingredients, ['2 lb chicken thighs', '3 limes', '2 oz cotija, to serve']);
  assert(args.raw && args.dryRun);
  assert(parseArgs(['-h']).help);
});

Deno.test('parseArgs wants exactly one recipe, and a typed one needs both steps and ingredients', () => {
  assertThrows(() => parseArgs([]), CliUsageError, 'No recipe given');
  assertThrows(() => parseArgs(['https://a.example', ...typed]), CliUsageError, 'Give one recipe');
  assertThrows(() => parseArgs(['https://a.example', 'https://b.example']), CliUsageError, 'one URL');
  assertThrows(() => parseArgs(['--step', 'Stir.']), CliUsageError, 'at least one --step and one --ingredient');
  assertThrows(() => parseArgs(['--step']), CliUsageError, '--step needs a value');
  assertThrows(() => parseArgs(['--nope']), CliUsageError, 'Unknown option');
});

// --- Formatting ---------------------------------------------------------------------------------

Deno.test('formatAmount reads like the cook screen, with a step share', () => {
  assertEquals(formatAmount(2, 'lb'), '2 lb');
  assertEquals(formatAmount(3, null, 1), '1 of 3');
  assertEquals(formatAmount(1, 'tbsp', 0.5), '0.5 of 1 tbsp');
  assertEquals(formatAmount(null, null), '');
});

Deno.test('formatMatch prints each step with its ingredients, then the ones in no step', () => {
  const recipe = {
    steps: ['Juice a lime.', 'Rest.'],
    ingredients: [
      { name: 'limes', quantity: 3, unit: null, note: '' },
      { name: 'cotija', quantity: 2, unit: 'oz' as const, note: '' },
    ],
  };
  assertEquals(
    formatMatch(recipe, [[{ ingredient: 0, quantity: 1 }], []]),
    [' 1. Juice a lime.', '      Limes  1 of 3', '', ' 2. Rest.', '      (no ingredients)', '', 'Not in a step', '      Cotija  2 oz'].join('\n'),
  );
});

// --- run ----------------------------------------------------------------------------------------

Deno.test('run matches a typed recipe with the mock and restores the env', async () => {
  const { cliIo, out } = io();
  const code = await withEnv({ AI_MODEL_STEPS: null, AI_MODEL_RECIPE: null, AI_MODEL_CATEGORIZE: null }, () => run([...typed, '--model', 'mock', '--quiet'], cliIo));
  assertEquals(code, 0);
  assertStringIncludes(out(), ' 1. Toss the chicken thighs with the lime.\n      Chicken thighs  2 lb\n      Limes           3');
  assertStringIncludes(out(), 'Not in a step\n      Cotija  2 oz');
  assertStringIncludes(out(), 'prompt version: match-recipe-steps.v1');
});

Deno.test('run reads a page through the import, and --json prints only JSON on stdout', async () => {
  const html = `<html><head><title>Lime chicken</title><script type="application/ld+json">${JSON.stringify({
    '@type': 'Recipe',
    name: 'Lime chicken',
    recipeIngredient: ['2 lb chicken thighs', '3 limes'],
    recipeInstructions: [{ '@type': 'HowToStep', text: 'Toss the thighs with the limes.' }, { '@type': 'HowToStep', text: 'Grill the chicken.' }],
  })}</script></head><body></body></html>`;
  const { cliIo, out, err } = io({ readFile: async () => html });
  const code = await withEnv({ AI_MODEL_STEPS: 'mock', AI_MODEL_RECIPE: 'mock', AI_MODEL_CATEGORIZE: null }, () => run(['--file', 'page.html', '--json', '--quiet'], cliIo));
  assertEquals(code, 0, err());
  const json = JSON.parse(out());
  assertEquals(json.name, 'Lime chicken');
  assertEquals(json.request.steps, ['Toss the thighs with the limes.', 'Grill the chicken.']);
  assertEquals(json.request.ingredients.map((i: { id: string }) => i.id), ['1', '2']);
  assertEquals(json.response, {
    steps: [[{ id: '1', quantity: null }, { id: '2', quantity: null }], []],
    promptVersion: 'match-recipe-steps.v1',
  });
  assertStringIncludes(err(), 'extract-recipe');
});

Deno.test('run goes through the function handler: ids for a typed recipe, and --model off is the 503 path', async () => {
  const typedJson = io();
  const code = await withEnv({ AI_MODEL_STEPS: null, AI_MODEL_RECIPE: null, AI_MODEL_CATEGORIZE: null }, () => run([...typed, '--model', 'mock', '--json', '--quiet'], typedJson.cliIo));
  assertEquals(code, 0, typedJson.err());
  assertEquals(JSON.parse(typedJson.out()).response.steps, [[{ id: '1', quantity: null }, { id: '2', quantity: null }], []]);

  const off = io();
  assertEquals(await withEnv({ AI_MODEL_STEPS: null, AI_MODEL_RECIPE: null, AI_MODEL_CATEGORIZE: null }, () => run([...typed, '--model', 'off', '--quiet'], off.cliIo)), 1);
  assertStringIncludes(off.err(), 'Match failed: unavailable (ai_off): Step matching is turned off');
});

Deno.test('matchIndexes maps the response ids back to the request order', () => {
  const request = { steps: ['A.', 'B.'], ingredients: [{ id: 'x', name: 'salt', quantity: null, unit: null, note: '' }, { id: 'y', name: 'oil', quantity: 2, unit: null, note: '' }] };
  assertEquals(matchIndexes(request, [[{ id: 'y', quantity: 1 }], [{ id: 'x', quantity: null }]]), [[{ ingredient: 1, quantity: 1 }], [{ ingredient: 0, quantity: null }]]);
});

Deno.test('run explains bad usage, a missing model, and a recipe with nothing to match', async () => {
  const usage = io();
  assertEquals(await run([], usage.cliIo), 2);
  assertStringIncludes(usage.err(), 'Usage: yarn ai:steps');

  const noModel = io({ env: () => undefined });
  assertEquals(await run(typed, noModel.cliIo), 2);
  assertStringIncludes(noModel.err(), 'Neither AI_MODEL_STEPS nor AI_MODEL_RECIPE is set');

  const noSteps = io({ readFile: async () => '<html><body><p>2 cups flour</p><p>1 egg</p></body></html>' });
  const code = await withEnv({ AI_MODEL_STEPS: 'mock', AI_MODEL_RECIPE: 'mock', AI_MODEL_CATEGORIZE: null }, () => run(['--file', 'page.html', '--quiet'], noSteps.cliIo));
  assertEquals(code, 1);
  assertStringIncludes(noSteps.err(), 'Nothing to match');
});

Deno.test('--dry-run prints the prompt and makes no match call', async () => {
  const { cliIo, out } = io();
  assertEquals(await run([...typed, '--model', 'mock', '--dry-run'], cliIo), 0);
  assertStringIncludes(out(), '--- instructions (match-recipe-steps.v1) ---');
  assertStringIncludes(out(), 'Dry run: no match call made (would use mock).');
});
