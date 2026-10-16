// Tests for `yarn ai:recipe` with the mock models and saved fixture pages; nothing is fetched.
import { SYSTEM_CATEGORIES, type RecipeImportResponse } from '@shared/index.ts';
import { assert, assertEquals, assertMatch, assertStringIncludes, assertThrows } from '@std/assert';

import type { AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { FetchPageError, readPage, type FetchedPage } from '../_shared/fetch-page.ts';
import {
  CliUsageError,
  formatCallStats,
  formatRecipe,
  formatStepMatch,
  formatTags,
  MemoryRecipeStore,
  parseArgs,
  placeholderUrl,
  run,
  type CliIo,
} from './cli.ts';

const cat = (slug: string) => SYSTEM_CATEGORIES.find((c) => c.slug === slug)!.id;
const fixture = (file: string) => new URL(`./eval/fixtures/${file}`, import.meta.url).pathname;
const DELISH = fixture('jsonld-delish-shrimp-asparagus-spaghetti.html');

const defaults = { url: null, file: null, model: null, categorizeModel: null, raw: false, quiet: false, json: false, help: false };

const MODEL_VARS = ['AI_MODEL_RECIPE', 'AI_MODEL_CATEGORIZE'] as const;

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

function io(overrides: Partial<CliIo> = {}) {
  let out = '';
  let err = '';
  const cliIo: CliIo = {
    out: (t) => (out += `${t}\n`),
    err: (t) => (err += `${t}\n`),
    env: (k) => Deno.env.get(k),
    fetchPage: () => Promise.reject(new Error('unexpected fetch')),
    ...overrides,
  };
  return { cliIo, out: () => out, err: () => err };
}

// --- parseArgs ----------------------------------------------------------------------------------

Deno.test('parseArgs: a URL', () => {
  assertEquals(parseArgs(['https://example.com/r']), { ...defaults, url: 'https://example.com/r' });
});

Deno.test('parseArgs: empty argv', () => {
  assertEquals(parseArgs([]), defaults);
});

Deno.test('parseArgs: every flag, both spellings, in any position', () => {
  assertEquals(
    parseArgs(['--file', 'page.html', '--model=mock', 'https://example.com/r', '--categorize-model', 'off', '--raw', '--quiet', '--json']),
    { url: 'https://example.com/r', file: 'page.html', model: 'mock', categorizeModel: 'off', raw: true, quiet: true, json: true, help: false },
  );
  assertEquals(parseArgs(['--file=a.html', '--categorize-model=mock', '-h']), { ...defaults, file: 'a.html', categorizeModel: 'mock', help: true });
});

Deno.test('parseArgs: after --, a dash-led argument is the URL', () => {
  assertEquals(parseArgs(['--', '-odd']), { ...defaults, url: '-odd' });
});

Deno.test('parseArgs: errors', () => {
  assertThrows(() => parseArgs(['https://a.com/1', 'https://a.com/2']), CliUsageError, 'one URL at a time');
  assertThrows(() => parseArgs(['--file']), CliUsageError, '--file needs a value');
  assertThrows(() => parseArgs(['--file', '--quiet']), CliUsageError, '--file needs a value');
  assertThrows(() => parseArgs(['--model=']), CliUsageError, '--model needs a value');
  assertThrows(() => parseArgs(['--categorize-model', ' ']), CliUsageError, '--categorize-model needs a value');
  assertThrows(() => parseArgs(['--repeat', '2']), CliUsageError, 'Unknown option: --repeat');
});

Deno.test('placeholderUrl: names the file, on a host that never resolves', () => {
  assertEquals(placeholderUrl('a/b/my page.html'), 'https://file.invalid/my%20page.html');
  assertEquals(placeholderUrl('C:\\pages\\x.html'), 'https://file.invalid/x.html');
  assertEquals(placeholderUrl('dir/'), 'https://file.invalid/page.html');
});

// --- MemoryRecipeStore, formatting --------------------------------------------------------------

Deno.test('MemoryRecipeStore: no limits, cache keyed by URL and prompt version, calls logged', async () => {
  const store = new MemoryRecipeStore();
  assertEquals(await store.checkLimit(), 'ok');
  for (const feature of ['categorize', 'recipe_import', 'recipe_import_photo'] as const) {
    assertEquals(await store.requireFeature(feature), undefined, `${feature} is granted`);
  }
  assertEquals(await store.getCached('https://a.com/r', 'v1'), null);
  const recipe = {
    is_recipe: true,
    name: 'Soup',
    servings: 2,
    ingredients: [],
    tags: { meal: ['lunch'], cuisine: [], protein: [], diet: [], method: [] },
    total_minutes: 30,
    steps: ['Simmer.'],
    step_ingredients: [[]],
    image_url: null,
  };
  await store.saveCached('https://a.com/r', 'v1', recipe);
  const row = await store.getCached('https://a.com/r', 'v1');
  assertEquals(row?.result, recipe);
  assertEquals(row?.is_recipe, true);
  assert(!Number.isNaN(Date.parse(row!.created_at)));
  assertEquals(await store.getCached('https://a.com/r', 'v2'), null);
  await store.logAiCall({ id: 'x' } as AiCallRecord);
  assertEquals(store.aiCalls.length, 1);
});

Deno.test('formatRecipe: header, rounded quantities, dashes for blanks, slug or status', () => {
  const response: RecipeImportResponse = {
    name: 'Soup',
    sourceUrl: 'https://a.com/r',
    servings: null,
    ingredients: [
      { ingredientName: 'brown sugar', displayName: 'brown sugar', quantity: 1 / 3, unit: 'cup', note: '', categoryId: cat('baking'), status: 'categorized' },
      { ingredientName: 'salt', displayName: 'Salt', quantity: null, unit: null, note: 'to taste', categoryId: null, status: 'pending' },
    ],
    tags: null,
    totalMinutes: null,
    steps: [],
    stepIngredients: null,
    imageUrl: null,
  };
  assertEquals(
    formatRecipe(response),
    [
      'name:     Soup',
      'servings: -',
      'time:     -',
      'tags:     -',
      'source:   https://a.com/r',
      '',
      'name         quantity  unit  note      category',
      'brown sugar  0.333     cup   -         baking',
      'Salt         -         -     to taste  (pending)',
    ].join('\n'),
  );
  assertStringIncludes(formatRecipe({ ...response, ingredients: [] }), 'No ingredients.');
});

Deno.test('formatRecipe and formatTags: time in minutes, tags by facet label in facet order', () => {
  const tags = { meal: ['dinner'], cuisine: ['peruvian'], protein: ['chicken', 'beans-lentils'], diet: [], method: ['pressure-cooker'] };
  assertEquals(formatTags(tags), 'Meal: Dinner · Cuisine: peruvian · Protein: Chicken · Protein: Beans & lentils · Method: Instant Pot');
  assertEquals(formatTags({ meal: [], cuisine: [], protein: [], diet: [], method: [] }), '-');
  assertEquals(formatTags(null), '-');
  const out = formatRecipe({ name: 'Stew', sourceUrl: 'https://a.com/s', servings: 4, ingredients: [], tags, totalMinutes: 95, steps: [], stepIngredients: null, imageUrl: null });
  assertStringIncludes(out, 'servings: 4\ntime:     95 min\ntags:     Meal: Dinner · Cuisine: peruvian');
});

Deno.test('formatRecipe: the step match under the ingredient table, as ai:steps prints it', () => {
  const response: RecipeImportResponse = {
    name: 'Tacos',
    sourceUrl: 'https://a.com/t',
    servings: null,
    ingredients: [
      { ingredientName: 'chicken thigh', displayName: 'chicken thighs', quantity: 2, unit: 'lb', note: '', categoryId: null, status: 'pending' },
      { ingredientName: 'lime', displayName: 'limes', quantity: 3, unit: null, note: '', categoryId: null, status: 'pending' },
      { ingredientName: 'cilantro', displayName: 'cilantro', quantity: null, unit: null, note: 'to serve', categoryId: null, status: 'pending' },
    ],
    tags: null,
    totalMinutes: null,
    steps: ['Marinate the chicken in lime.', 'Serve.'],
    stepIngredients: [[{ index: 0, quantity: null }, { index: 1, quantity: 1 }], []],
    imageUrl: null,
  };
  const out = formatRecipe(response);
  assertStringIncludes(
    out,
    [
      'limes           3         -     -         (pending)',
      'cilantro        -         -     to serve  (pending)',
      '',
      'step match:',
      '',
      ' 1. Marinate the chicken in lime.',
      '      Chicken thighs  2 lb',
      '      Limes           1 of 3',
      '',
      ' 2. Serve.',
      '      (no ingredients)',
      '',
      'Not in a step',
      '      Cilantro',
    ].join('\n'),
  );
  assertEquals(formatStepMatch({ ...response, stepIngredients: null }), 'step match: none (the app matches the recipe after it saves)');
  assertEquals(formatStepMatch({ ...response, steps: [], stepIngredients: null }), '');
  assert(!formatRecipe({ ...response, steps: [], stepIngredients: null }).includes('step match'));
});

Deno.test('formatCallStats: one block per task, or none', () => {
  assertEquals(formatCallStats([], []), 'No LLM call made.');
  const call = { model: 'mock', prompt_version: 'extract-recipe.v1', status: 'ok', input_tokens: 5, output_tokens: 7, cached_input_tokens: 0, reasoning_tokens: 0, duration_ms: 3 } as AiCallRecord;
  const text = formatCallStats([call], []);
  assertStringIncludes(text, 'extract-recipe\nmodel:          mock');
  assertStringIncludes(text, 'total tokens:   12');
  assertStringIncludes(text, 'categorize\nNo LLM call made.');
});

// --- run ----------------------------------------------------------------------------------------

Deno.test('run: --file with the mock models prints the recipe and categories, fetching nothing', async () => {
  const t = io();
  const code = await withEnv({ AI_MODEL_RECIPE: null, AI_MODEL_CATEGORIZE: null }, () =>
    run(['--quiet', '--file', DELISH, '--model', 'mock', '--categorize-model', 'mock'], t.cliIo));
  assertEquals(code, 0, t.err());
  const out = t.out();
  // The mock doesn't tag; the time is the page's JSON-LD totalTime.
  assertStringIncludes(
    out,
    'name:     Lemony Shrimp and Asparagus Spaghetti\nservings: 4\ntime:     25 min\ntags:     -\nsource:   https://file.invalid/jsonld-delish-shrimp-asparagus-spaghetti.html',
  );
  assertMatch(out, /^spaghetti +12 +oz +- +pasta-grains$/m);
  assertMatch(out, /^garlic +3 +clove +minced +pantry$/m);
  assertMatch(out, /^kosher salt +- +- +- +spices$/m);
  assertStringIncludes(out, 'extract-recipe\nmodel:          mock');
  assertStringIncludes(out, 'categorize\nmodel:          mock');
});

Deno.test('run: --json prints only the response on stdout, with the given URL canonicalized', async () => {
  const t = io();
  const code = await withEnv({ AI_MODEL_RECIPE: 'mock', AI_MODEL_CATEGORIZE: 'mock' }, () =>
    run(['--json', '--file', DELISH, 'https://www.delish.com/x/?utm_source=a'], t.cliIo));
  assertEquals(code, 0, t.err());
  const response = JSON.parse(t.out()) as RecipeImportResponse;
  assertEquals(response.sourceUrl, 'https://delish.com/x');
  assertEquals(response.servings, 4);
  assertEquals(response.totalMinutes, 25);
  assertEquals(response.tags, { meal: [], cuisine: [], protein: [], diet: [], method: [] });
  assertEquals(response.ingredients.length, 11);
  assertEquals(response.ingredients[0], {
    ingredientName: 'spaghetti',
    displayName: 'spaghetti',
    quantity: 12,
    unit: 'oz',
    note: '',
    categoryId: cat('pasta-grains'),
    status: 'categorized',
  });
  // The trace and the stats went to stderr.
  assertStringIncludes(t.err(), 'extract-recipe\nmodel:          mock');
});

Deno.test('run: with categorize unset, names stay pending and no categorize call is made', async () => {
  const t = io();
  const code = await withEnv({ AI_MODEL_RECIPE: 'mock', AI_MODEL_CATEGORIZE: null }, () => run(['--quiet', '--file', DELISH], t.cliIo));
  assertEquals(code, 0, t.err());
  assertMatch(t.out(), /^spaghetti +12 +oz +- +\(pending\)$/m);
  assertStringIncludes(t.out(), 'categorize\nNo LLM call made.');
});

Deno.test('run: a URL goes through fetchPage as given', async () => {
  const fetched: string[] = [];
  const html = await Deno.readTextFile(DELISH);
  const t = io({
    fetchPage: (url): Promise<FetchedPage> => {
      fetched.push(url);
      return Promise.resolve({ ...readPage(html), finalUrl: url });
    },
  });
  const code = await withEnv({ AI_MODEL_RECIPE: 'mock', AI_MODEL_CATEGORIZE: 'off' }, () =>
    run(['--quiet', 'https://www.delish.com/recipe/?fbclid=1'], t.cliIo));
  assertEquals(code, 0, t.err());
  assertEquals(fetched, ['https://www.delish.com/recipe/?fbclid=1']);
  assertStringIncludes(t.out(), 'source:   https://delish.com/recipe\n');
});

Deno.test('run: fetch failures and blocked URLs exit 1 with the import error', async () => {
  for (const [reason, code] of [['blocked_address', 'invalid_url'], ['http_status', 'fetch_failed']] as const) {
    const t = io({ fetchPage: () => Promise.reject(new FetchPageError(reason, 'nope')) });
    const exit = await withEnv({ AI_MODEL_RECIPE: 'mock', AI_MODEL_CATEGORIZE: null }, () => run(['--quiet', 'http://10.0.0.1/r'], t.cliIo));
    assertEquals(exit, 1);
    assertStringIncludes(t.err(), `Import failed: ${code}: nope`);
    assertEquals(t.out(), 'No LLM call made.\n');
  }
});

Deno.test('run: a page that is not a recipe exits 1', async () => {
  const t = io();
  const code = await withEnv({ AI_MODEL_RECIPE: 'mock', AI_MODEL_CATEGORIZE: null }, () =>
    run(['--quiet', '--file', fixture('notrecipe-jamieoliver-chicken-index.html')], t.cliIo));
  assertEquals(code, 1);
  assertStringIncludes(t.err(), 'Import failed: not_a_recipe: That page is not a recipe');
  assertStringIncludes(t.out(), 'extract-recipe\nmodel:          mock');
});

Deno.test('run: --model off exits 1 as unavailable, with no call', async () => {
  const t = io();
  const code = await withEnv({ AI_MODEL_RECIPE: 'mock', AI_MODEL_CATEGORIZE: null }, () => run(['--file', DELISH, '--model', 'off'], t.cliIo));
  assertEquals(code, 1);
  assertStringIncludes(t.err(), 'Import failed: unavailable: Recipe import is turned off');
});

Deno.test('run: usage errors exit 2', async () => {
  for (const argv of [[], ['--bogus'], ['a', 'b'], ['--file']]) {
    const t = io();
    assertEquals(await run(argv, t.cliIo), 2, argv.join(' '));
    assertStringIncludes(t.err(), 'Usage: yarn ai:recipe');
  }
});

Deno.test('run: --help prints usage and exits 0', async () => {
  const t = io();
  assertEquals(await run(['--help'], t.cliIo), 0);
  assertStringIncludes(t.out(), '--file <path>');
});

Deno.test('run: no AI_MODEL_RECIPE and no --model exits 2', async () => {
  const t = io({ env: () => undefined });
  assertEquals(await run(['https://a.com/r'], t.cliIo), 2);
  assertStringIncludes(t.err(), 'AI_MODEL_RECIPE is not set');
});

Deno.test('run: an unreadable file exits 2', async () => {
  const t = io({ readFile: () => Promise.reject(new Error('No such file')) });
  assertEquals(await run(['--model', 'mock', '--file', 'missing.html'], t.cliIo), 2);
  assertStringIncludes(t.err(), "Can't read missing.html: No such file");
});

Deno.test('run: a non-http URL exits 1 as invalid_url', async () => {
  const t = io();
  const code = await withEnv({ AI_MODEL_RECIPE: 'mock', AI_MODEL_CATEGORIZE: null }, () => run(['--quiet', 'ftp://a.com/r'], t.cliIo));
  assertEquals(code, 1);
  assertStringIncludes(t.err(), 'Import failed: invalid_url');
});
