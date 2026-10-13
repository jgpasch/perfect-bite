// Tests for `yarn ai:tags` with the mock model; nothing touches the network.
import { emptyRecipeTags } from '@shared/index.ts';
import { assertEquals, assertStringIncludes, assertThrows } from '@std/assert';

import { CliUsageError, ingredientFromLine, MemoryTagsStore, parseArgs, run, type CliIo } from './cli.ts';

const defaults = { name: null, ingredients: [], notes: null, model: null, raw: false, quiet: false, dryRun: false, json: false, help: false };

const MODEL_VARS = ['AI_MODEL_TAGS', 'AI_MODEL_RECIPE'] as const;

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

function io() {
  let out = '';
  let err = '';
  const cliIo: CliIo = { out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`), env: (k) => Deno.env.get(k) };
  return { cliIo, out: () => out, err: () => err };
}

// --- parseArgs ----------------------------------------------------------------------------------

Deno.test('parseArgs reads the name, repeated ingredients, notes and flags', () => {
  assertEquals(parseArgs(['Chicken curry', '--ingredient', '2 chicken thighs', '--ingredient=1 onion', '--notes', 'Spicy']), {
    ...defaults,
    name: 'Chicken curry',
    ingredients: ['2 chicken thighs', '1 onion'],
    notes: 'Spicy',
  });
  assertEquals(parseArgs(['--model', 'mock', '--raw', '--quiet', '--json', '--dry-run', 'Toast']), {
    ...defaults,
    name: 'Toast',
    model: 'mock',
    raw: true,
    quiet: true,
    json: true,
    dryRun: true,
  });
  assertEquals(parseArgs(['-h']).help, true);
  assertEquals(parseArgs(['--', '-weird name']).name, '-weird name');
});

Deno.test('parseArgs refuses a second name, an unknown flag and a missing value', () => {
  assertThrows(() => parseArgs(['Toast', 'Jam']), CliUsageError, 'one recipe name');
  assertThrows(() => parseArgs(['--nope']), CliUsageError, 'Unknown option');
  assertThrows(() => parseArgs(['--ingredient']), CliUsageError, '--ingredient needs a value');
  assertThrows(() => parseArgs(['--model', '--raw']), CliUsageError, '--model needs a value');
});

Deno.test('ingredientFromLine parses the amount and keeps what follows the first comma as the note', () => {
  assertEquals(ingredientFromLine('2 lb chicken thighs, skinless, boned'), { name: 'chicken thighs', quantity: 2, unit: 'lb', note: 'skinless, boned' });
  assertEquals(ingredientFromLine('salt'), { name: 'salt', quantity: null, unit: null, note: '' });
});

Deno.test('MemoryTagsStore grants every feature and never limits', async () => {
  const store = new MemoryTagsStore();
  await store.requireFeature('recipe_tags');
  assertEquals(await store.checkLimit(), 'ok');
});

// --- run ------------------------------------------------------------------------------------------

Deno.test('run with the mock prints the tags and the call totals', async () => {
  await withEnv({ AI_MODEL_TAGS: null, AI_MODEL_RECIPE: null }, async () => {
    const { cliIo, out } = io();
    const code = await run(['--model', 'mock', '--quiet', 'Chicken tacos', '--ingredient', '2 chicken thighs'], cliIo);
    assertEquals(code, 0);
    assertStringIncludes(out(), 'tags: Cuisine: Mexican · Protein: Chicken');
    assertStringIncludes(out(), 'prompt version: suggest-recipe-tags.v1');
  });
});

Deno.test('run --json prints only the response on stdout', async () => {
  await withEnv({ AI_MODEL_TAGS: 'mock', AI_MODEL_RECIPE: null }, async () => {
    const { cliIo, out } = io();
    assertEquals(await run(['--json', '--quiet', 'Tofu bowl'], cliIo), 0);
    assertEquals(JSON.parse(out()), { tags: { ...emptyRecipeTags(), protein: ['tofu-tempeh'] }, promptVersion: 'suggest-recipe-tags.v1' });
  });
});

Deno.test('run uses AI_MODEL_RECIPE when AI_MODEL_TAGS is unset', async () => {
  await withEnv({ AI_MODEL_TAGS: null, AI_MODEL_RECIPE: 'mock' }, async () => {
    const { cliIo, out } = io();
    assertEquals(await run(['--quiet', 'Plain rice'], cliIo), 0);
    assertStringIncludes(out(), 'tags: -');
  });
});

Deno.test('run --dry-run prints the prompt and makes no call', async () => {
  await withEnv({ AI_MODEL_TAGS: null, AI_MODEL_RECIPE: null }, async () => {
    const { cliIo, out } = io();
    assertEquals(await run(['--dry-run', '--model', 'google:gemini-3.8-flash', 'Toast', '--ingredient', '2 slices bread'], cliIo), 0);
    assertStringIncludes(out(), '--- instructions (suggest-recipe-tags.v1) ---');
    assertStringIncludes(out(), '"ingredients":["2 slices bread"]');
    assertStringIncludes(out(), 'Dry run: no call made (would use google:gemini-3.8-flash).');
  });
});

Deno.test('run with --model off fails with exit 1', async () => {
  await withEnv({ AI_MODEL_TAGS: null, AI_MODEL_RECIPE: null }, async () => {
    const { cliIo, err } = io();
    assertEquals(await run(['--model', 'off', 'Toast'], cliIo), 1);
    assertStringIncludes(err(), 'Suggestion failed: unavailable');
  });
});

Deno.test('run exits 2 with no name, a blank name, or no model configured', async () => {
  await withEnv({ AI_MODEL_TAGS: null, AI_MODEL_RECIPE: null }, async () => {
    const none = io();
    assertEquals(await run([], none.cliIo), 2);
    assertStringIncludes(none.err(), 'No recipe name given.');
    const blank = io();
    assertEquals(await run(['--model', 'mock', '  '], blank.cliIo), 2);
    assertStringIncludes(blank.err(), 'A recipe name is required');
    const noModel = io();
    assertEquals(await run(['Toast'], noModel.cliIo), 2);
    assertStringIncludes(noModel.err(), 'Neither AI_MODEL_TAGS nor AI_MODEL_RECIPE is set');
  });
});

Deno.test('run --help prints the usage', async () => {
  const { cliIo, out } = io();
  assertEquals(await run(['--help'], cliIo), 0);
  assertStringIncludes(out(), 'Usage: yarn ai:tags');
});
