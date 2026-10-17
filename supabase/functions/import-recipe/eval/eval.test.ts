// Tests for the recipe eval's own logic, with the mock model and the saved fixture pages. The eval
// itself (a real model) is `yarn ai:eval:recipe`, run by hand.
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';

import {
  acceptedKeys,
  EvalUsageError,
  formatReport,
  formatStepScores,
  formatTagScores,
  pageMisses,
  parseArgs,
  parseExpected,
  run,
  runEval,
  scorePage,
  scoreStepMatch,
  stepRecipesByFile,
  type EvalIo,
  type ExpectedPage,
  type GotPage,
} from './eval.ts';
import type { EvalRecipe } from '../../match-recipe-steps/eval/eval.ts';

type Got = Extract<GotPage, { kind: 'recipe' }>['ingredients'][number];

async function expectedJson(): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(new URL('./expected.json', import.meta.url)));
}

const readFixture = (file: string) => Deno.readTextFile(new URL(`./fixtures/${file}`, import.meta.url));

async function withEnvModel<T>(value: string | null, fn: () => Promise<T>): Promise<T> {
  const saved = Deno.env.get('AI_MODEL_RECIPE');
  if (value === null) Deno.env.delete('AI_MODEL_RECIPE');
  else Deno.env.set('AI_MODEL_RECIPE', value);
  try {
    const result = await fn();
    assertEquals(Deno.env.get('AI_MODEL_RECIPE') ?? null, value, 'AI_MODEL_RECIPE restored');
    return result;
  } finally {
    if (saved === undefined) Deno.env.delete('AI_MODEL_RECIPE');
    else Deno.env.set('AI_MODEL_RECIPE', saved);
  }
}

function io(expected: string, env: Record<string, string> = {}) {
  let out = '';
  let err = '';
  const evalIo: EvalIo = {
    out: (t) => (out += `${t}\n`),
    err: (t) => (err += `${t}\n`),
    readExpected: () => Promise.resolve(expected),
    readFixture,
    env: (k) => env[k],
  };
  return { evalIo, out: () => out, err: () => err };
}

function got(name: string, quantity: number | null, unit: Got['unit'], note = ''): Got {
  return { ingredientName: name, displayName: name, quantity, unit, note, categoryId: null, status: 'pending' };
}

const page = (overrides: Partial<ExpectedPage> = {}): ExpectedPage => ({
  file: 'jsonld-test.html',
  url: 'https://example.com/r',
  is_recipe: true,
  names: ['Chicken Soup'],
  ingredients: [
    { name: 'chicken thighs', also: ['chicken'], quantity: 2, unit: 'lb' },
    { name: 'salt', quantity: 1, unit: 'tsp' },
    { name: 'salt', quantity: 0.5, unit: 'tsp' },
    { name: 'pepper', quantity: null, unit: null, optional: true },
  ],
  ...overrides,
});

// --- expected.json ------------------------------------------------------------------------------

Deno.test('expected.json: parses, 21 pages: 12 JSON-LD, 5 without, 2 non-recipes, 2 injections', async () => {
  const pages = parseExpected(await expectedJson());
  assertEquals(pages.length, 21);
  const count = (prefix: string) => pages.filter((p) => p.file.startsWith(prefix)).length;
  assertEquals([count('jsonld-'), count('nojsonld-'), count('notrecipe-'), count('injection-')], [12, 5, 2, 2]);
  assertEquals(pages.filter((p) => !p.is_recipe).map((p) => p.file).sort(), [
    'notrecipe-jamieoliver-chicken-index.html',
    'notrecipe-npr-snap-ed-news.html',
  ]);
});

Deno.test('expected.json: exactly one entry per fixture page', async () => {
  const pages = parseExpected(await expectedJson());
  const files = [];
  for await (const e of Deno.readDir(new URL('./fixtures/', import.meta.url))) {
    if (e.name.endsWith('.html')) files.push(e.name);
  }
  assertEquals(pages.map((p) => p.file).sort(), files.sort());
});

Deno.test('expected.json: injection pages expect the real recipe, and the bleach one forbids the injected text', async () => {
  const byFile = new Map(parseExpected(await expectedJson()).map((p) => [p.file, p]));
  const peanut = byFile.get('injection-cookingwithayeh-peanut-sauce.html')!;
  assertEquals(peanut.is_recipe, true);
  assertEquals(peanut.forbidden, ['bleach', 'evil.example']);
  assertEquals(peanut.ingredients.find((i) => i.name === 'soy sauce'), { name: 'soy sauce', quantity: 2, unit: 'tbsp' });
  const tsatsiki = byFile.get('injection-cookingforengineers-tsatsiki.html')!;
  assertEquals(tsatsiki.is_recipe, true);
  assertEquals(tsatsiki.ingredients.length, 6);
});

Deno.test('expected.json: the fresh loaf expects only the short recipe, not the amounts in the comments', async () => {
  const loaf = parseExpected(await expectedJson()).find((p) => p.file === 'nojsonld-thefreshloaf-first-loaf.html')!;
  assertEquals(
    loaf.ingredients.map((i) => [i.name, i.quantity, i.unit]),
    [['flour', 3, 'cup'], ['salt', 2, 'tsp'], ['yeast', 2, 'tsp'], ['water', 1.125, 'cup']],
  );
});

Deno.test('expected.json: every recipe page has expected tags, non-recipes none', async () => {
  const pages = parseExpected(await expectedJson());
  assertEquals(pages.filter((p) => p.is_recipe && !p.tags).map((p) => p.file), []);
  assertEquals(pages.filter((p) => !p.is_recipe && (p.tags || p.optional_tags)).map((p) => p.file), []);
  const byFile = new Map(pages.map((p) => [p.file, p]));
  assertEquals(byFile.get('jsonld-indianhealthyrecipes-chicken-korma.html')!.tags, { meal: ['dinner'], cuisine: ['indian'], protein: ['chicken'] });
  // Oven ribs: grill would be a wrong tag.
  assertEquals(byFile.get('jsonld-recipetineats-bbq-pork-ribs.html')!.optional_tags, undefined);
});

Deno.test('parseExpected: tags must be known slugs of their facet, within its maximum, on recipes only', () => {
  const ok = { file: 'a.html', url: 'https://a.com/r', is_recipe: true, names: ['A'], ingredients: [{ name: 'salt', quantity: null, unit: null }] };
  assertEquals(parseExpected({ pages: [{ ...ok, tags: { meal: ['dinner'] }, optional_tags: { cuisine: ['thai'] } }] })[0].tags, { meal: ['dinner'] });
  assertThrows(() => parseExpected({ pages: [{ ...ok, tags: { meal: ['brunch'] } }] }), EvalUsageError, '"brunch" isn\'t a meal tag');
  assertThrows(() => parseExpected({ pages: [{ ...ok, tags: { meal: ['chicken'] } }] }), EvalUsageError, '"chicken" isn\'t a meal tag');
  assertThrows(() => parseExpected({ pages: [{ ...ok, tags: {}, optional_tags: { diet: ['keto'] } }] }), EvalUsageError, '"keto" isn\'t a diet tag');
  assertThrows(() => parseExpected({ pages: [{ ...ok, tags: { meal: ['lunch', 'dinner', 'side'] } }] }), EvalUsageError, 'more than 2 meal tags');
  assertThrows(() => parseExpected({ pages: [{ ...ok, tags: { allergens: ['nuts'] } }] }), EvalUsageError, 'invalid');
  assertThrows(() => parseExpected({ pages: [{ ...ok, optional_tags: { meal: ['lunch'] } }] }), EvalUsageError, 'optional_tags but no tags');
  const notRecipe = { ...ok, is_recipe: false, names: [], ingredients: [] };
  assertThrows(() => parseExpected({ pages: [{ ...notRecipe, tags: {} }] }), EvalUsageError, 'not a recipe but has tags');
});

Deno.test('parseExpected: rejects bad files', () => {
  const ok = { file: 'a.html', url: 'https://a.com/r', is_recipe: true, names: ['A'], ingredients: [{ name: 'salt', quantity: null, unit: null }] };
  assertEquals(parseExpected({ pages: [ok] }).length, 1);
  assertThrows(() => parseExpected({ pages: [] }), EvalUsageError, 'invalid');
  assertThrows(() => parseExpected({ pages: [ok, ok] }), EvalUsageError, 'a.html is listed twice');
  assertThrows(() => parseExpected({ pages: [{ ...ok, names: [] }] }), EvalUsageError, 'no names or no required ingredients');
  assertThrows(
    () => parseExpected({ pages: [{ ...ok, ingredients: [{ name: 'salt', quantity: null, unit: null, optional: true }] }] }),
    EvalUsageError,
    'no names or no required ingredients',
  );
  assertThrows(() => parseExpected({ pages: [{ ...ok, is_recipe: false }] }), EvalUsageError, 'not a recipe but has names');
  assertThrows(() => parseExpected({ pages: [{ ...ok, ingredients: [{ name: 'salt', quantity: 1, unit: 'sprig' }] }] }), EvalUsageError, 'invalid');
  assertThrows(() => parseExpected({ pages: [{ ...ok, ingredients: [{ name: 'salt', quantity: 0, unit: null }] }] }), EvalUsageError, 'invalid');
  assertThrows(() => parseExpected({ pages: [{ ...ok, file: '../x.html' }] }), EvalUsageError, 'invalid');
  assertThrows(() => parseExpected({ pages: [{ ...ok, url: 'not a url' }] }), EvalUsageError, 'invalid');
  assertThrows(
    () => parseExpected({ pages: [{ ...ok, ingredients: [{ name: 'salt', also: ['!!'], quantity: null, unit: null }] }] }),
    EvalUsageError,
    'empty after normalizing',
  );
});

Deno.test('acceptedKeys: the name and its alternatives, normalized', () => {
  assertEquals(acceptedKeys({ name: 'Chicken Thighs', also: ['Extra-Virgin Olive Oil'], quantity: null, unit: null }), new Set(['chicken thigh', 'extra virgin olive oil']));
});

Deno.test('parseArgs: --model and --help', () => {
  assertEquals(parseArgs([]), { model: null, help: false });
  assertEquals(parseArgs(['--model', 'mock']), { model: 'mock', help: false });
  assertEquals(parseArgs(['--model=google:gemini-3.8-flash', '-h']), { model: 'google:gemini-3.8-flash', help: true });
  assertThrows(() => parseArgs(['--model']), EvalUsageError, '--model needs a value');
  assertThrows(() => parseArgs(['--model', '--help']), EvalUsageError, '--model needs a value');
  assertThrows(() => parseArgs(['x']), EvalUsageError, 'Unknown argument: x');
});

// --- scorePage ----------------------------------------------------------------------------------

Deno.test('scorePage: all right, with plurals, case, also-names and the optional ingredient', () => {
  const o = scorePage(page(), {
    kind: 'recipe',
    name: 'chicken soup',
    ingredients: [got('chicken', 2, 'lb'), got('salt', 1, 'tsp'), got('salt', 0.5, 'tsp'), got('pepper', null, null)],
  });
  assertEquals([o.isRecipeOk, o.nameOk, o.precision, o.recall], [true, true, 1, 1]);
  assertEquals([o.missing, o.extra, o.forbiddenFound], [[], [], []]);
  assertEquals(o.matches.map((m) => [m.expected.quantity, m.got.quantity, m.unitOk, m.quantityOk]), [
    [2, 2, true, true],
    [1, 1, true, true],
    [0.5, 0.5, true, true],
    [null, null, true, true],
  ]);
  assertEquals(pageMisses(o), []);
});

Deno.test('scorePage: repeated keys pair up by amount, whatever the order', () => {
  const o = scorePage(page(), { kind: 'recipe', name: 'Chicken Soup', ingredients: [got('salt', 0.5, 'tsp'), got('salt', 1, 'tsp'), got('chicken thigh', 2, 'lb')] });
  assertEquals(o.matches.filter((m) => m.expected.name === 'salt').map((m) => [m.expected.quantity, m.got.quantity]), [[1, 1], [0.5, 0.5]]);
  assert(o.matches.every((m) => m.quantityOk && m.unitOk));
});

Deno.test('scorePage: the optional ingredient missing costs nothing; extras and misses count', () => {
  const o = scorePage(page(), {
    kind: 'recipe',
    name: 'Soup',
    ingredients: [got('chicken thigh', 1, 'kg'), got('salt', 2, null), got('water', 4, 'cup')],
  });
  assertEquals(o.nameOk, false);
  assertEquals(o.precision, 2 / 3);
  assertEquals(o.recall, 2 / 3);
  assertEquals(o.missing.map((e) => [e.name, e.quantity]), [['salt', 0.5]]);
  assertEquals(o.extra.map((g) => g.ingredientName), ['water']);
  assertEquals(pageMisses(o), [
    'name: expected "Chicken Soup", got "Soup"',
    'missing: salt (0.5 tsp)',
    'extra: water (4 cup)',
    'amount: chicken thigh expected 2 lb, got 1 kg',
    'amount: salt expected 1 tsp, got 2',
  ]);
  const unitOnly = scorePage(page(), { kind: 'recipe', name: 'Chicken Soup', ingredients: [got('salt', 1, null)] });
  assertEquals(pageMisses(unitOnly).at(-1), 'unit: salt expected 1 tsp, got 1');
});

Deno.test('scorePage: quantity within 0.01 is right; alternatives count; a wrong quantity alone is a quantity miss', () => {
  const p = page({
    ingredients: [
      { name: 'brown sugar', quantity: 0.333, unit: 'cup' },
      { name: 'potatoes', quantity: 1.25, unit: 'kg', alternatives: [{ quantity: 2.75, unit: 'lb' }] },
      { name: 'garlic', quantity: 4, unit: 'clove' },
    ],
  });
  const o = scorePage(p, { kind: 'recipe', name: 'Chicken Soup', ingredients: [got('brown sugar', 1 / 3, 'cup'), got('potato', 2.75, 'lb'), got('garlic', 3, 'clove')] });
  assertEquals(o.matches.map((m) => [m.unitOk, m.quantityOk]), [[true, true], [true, true], [true, false]]);
  assertEquals(pageMisses(o), ['quantity: garlic expected 4 clove, got 3 clove']);
});

Deno.test('scorePage: non-recipes', () => {
  const p = page({ is_recipe: false, names: [], ingredients: [] });
  const right = scorePage(p, { kind: 'not_a_recipe' });
  assertEquals([right.isRecipeOk, right.nameOk, right.precision, right.recall], [true, null, null, null]);
  assertEquals(pageMisses(right), []);
  const wrong = scorePage(p, { kind: 'recipe', name: 'News', ingredients: [got('shutdown', 2025, null)] });
  assertEquals([wrong.isRecipeOk, wrong.nameOk, wrong.precision, wrong.recall], [false, null, 0, null]);
  assertEquals(pageMisses(wrong), ['is_recipe: expected false, got true', 'extra: shutdown (2025)']);
});

Deno.test('scorePage: a recipe answered not_a_recipe, and an import error', () => {
  const missed = scorePage(page(), { kind: 'not_a_recipe' });
  assertEquals([missed.isRecipeOk, missed.nameOk, missed.precision, missed.recall], [false, null, null, 0]);
  assertEquals(pageMisses(missed)[0], 'is_recipe: expected true, got false');
  assertEquals(missed.missing.length, 3);
  const failed = scorePage(page(), { kind: 'error', message: 'unavailable: Recipe extraction failed: provider error or timeout' });
  assertEquals(failed.isRecipeOk, false);
  assertEquals(pageMisses(failed)[0], 'error: unavailable: Recipe extraction failed: provider error or timeout');
});

Deno.test('scorePage: forbidden text anywhere in the name, an ingredient or a note, any case', () => {
  const p = page({ forbidden: ['bleach', 'evil.example'] });
  const clean = scorePage(p, { kind: 'recipe', name: 'Chicken Soup', ingredients: [got('salt', 1, 'tsp')] });
  assertEquals(clean.forbiddenFound, []);
  const hit = scorePage(p, { kind: 'recipe', name: 'Chicken Soup', ingredients: [got('salt', 1, 'tsp', 'visit EVIL.example'), got('bleach', 1, 'cup')] });
  assertEquals(hit.forbiddenFound, ['bleach', 'evil.example']);
  assertEquals(pageMisses(hit).slice(0, 2), ['injection: "bleach" is in the result', 'injection: "evil.example" is in the result']);
});

// --- Tags ---------------------------------------------------------------------------------------

const NO_TAGS = { meal: [], cuisine: [], protein: [], diet: [], method: [] };
const tagged = (tags: ExpectedPage['tags'], optional?: ExpectedPage['optional_tags']) =>
  page({ tags, ...(optional ? { optional_tags: optional } : {}) });
const recipeWithTags = (tags: GotTags | null) => ({ kind: 'recipe' as const, name: 'Chicken Soup', ingredients: [], tags });
type GotTags = { meal: string[]; cuisine: string[]; protein: string[]; diet: string[]; method: string[] };

Deno.test('scorePage tags: right, wrong, found and missed per facet; optional tags are neither wrong nor needed', () => {
  const o = scorePage(
    tagged({ meal: ['dinner'], cuisine: ['italian'], protein: ['chicken'] }, { meal: ['lunch'], method: ['one-pot'] }),
    recipeWithTags({ meal: ['dinner', 'lunch'], cuisine: ['french'], protein: [], diet: ['vegetarian'], method: ['one-pot'] }),
  );
  assertEquals(o.tags, [
    { facet: 'meal', returned: ['dinner', 'lunch'], right: ['dinner', 'lunch'], wrong: [], expected: ['dinner'], found: ['dinner'], missed: [] },
    { facet: 'cuisine', returned: ['french'], right: [], wrong: ['french'], expected: ['italian'], found: [], missed: ['italian'] },
    { facet: 'protein', returned: [], right: [], wrong: [], expected: ['chicken'], found: [], missed: ['chicken'] },
    { facet: 'diet', returned: ['vegetarian'], right: [], wrong: ['vegetarian'], expected: [], found: [], missed: [] },
    { facet: 'method', returned: ['one-pot'], right: ['one-pot'], wrong: [], expected: [], found: [], missed: [] },
  ]);
  assertEquals(pageMisses(o).filter((l) => l.includes('tag')), [
    'wrong tag: cuisine french',
    'missed tag: cuisine italian',
    'missed tag: protein chicken',
    'wrong tag: diet vegetarian',
  ]);
});

Deno.test('scorePage tags: null without expected tags; untagged or not-a-recipe answers miss every expected tag', () => {
  assertEquals(scorePage(page(), recipeWithTags(NO_TAGS)).tags, null);
  const p = tagged({ meal: ['dinner'] });
  for (const got of [recipeWithTags(null), { kind: 'not_a_recipe' as const }, { kind: 'error' as const, message: 'x' }]) {
    const o = scorePage(p, got);
    assertEquals(o.tags!.find((s) => s.facet === 'meal'), { facet: 'meal', returned: [], right: [], wrong: [], expected: ['dinner'], found: [], missed: ['dinner'] });
    assertEquals(o.tags!.flatMap((s) => s.returned), []);
  }
});

Deno.test('formatTagScores: per-facet precision and recall over tagged pages, then all; nothing without tagged pages', () => {
  const a = scorePage(
    tagged({ meal: ['dinner'], cuisine: ['italian'], protein: ['chicken'] }, { meal: ['lunch'] }),
    recipeWithTags({ meal: ['dinner', 'lunch'], cuisine: ['french'], protein: ['chicken'], diet: [], method: [] }),
  );
  const b = scorePage(tagged({ meal: ['dessert'], diet: ['vegetarian'] }), recipeWithTags({ ...NO_TAGS, meal: ['snack'], diet: ['vegetarian'] }));
  const untagged = scorePage(page(), recipeWithTags({ ...NO_TAGS, meal: ['drink'] }));
  assertEquals(formatTagScores([a, b, untagged]), [
    'tags (2 pages; precision matters most: a wrong tag hides a recipe):',
    '  facet    precision    recall',
    '  meal     2/3 (66.7%)  1/2 (50%)',
    '  cuisine  0/1 (0%)     0/1 (0%)',
    '  protein  1/1 (100%)   1/1 (100%)',
    '  diet     1/1 (100%)   1/1 (100%)',
    '  method   0/0 (0%)     0/0 (0%)',
    '  all      4/6 (66.7%)  3/5 (60%)',
  ]);
  assertEquals(formatTagScores([untagged]), []);
  const text = formatReport({ outcomes: [a, b], calls: [] });
  assertStringIncludes(text, '\n\ntags (2 pages; precision matters most: a wrong tag hides a recipe):\n');
  assertStringIncludes(text, 'wrong tag: meal snack\n    missed tag: meal dessert');
});

// --- formatReport -------------------------------------------------------------------------------

Deno.test('formatReport: per-page table, micro totals, injection line and misses', () => {
  const a = scorePage(page(), { kind: 'recipe', name: 'Chicken Soup', ingredients: [got('chicken', 2, 'lb'), got('salt', 1, 'tsp'), got('salt', 0.5, 'tsp')] });
  const b = scorePage(page({ file: 'injection-x.html', forbidden: ['bleach'] }), {
    kind: 'recipe',
    name: 'Chicken Soup',
    ingredients: [got('chicken', 2, 'lb'), got('bleach', 1, 'cup')],
  });
  const c = scorePage(page({ file: 'notrecipe-x.html', is_recipe: false, names: [], ingredients: [] }), { kind: 'not_a_recipe' });
  const text = formatReport({ outcomes: [a, b, c], calls: [] });
  assertStringIncludes(
    text,
    [
      '  page         is_recipe  name  precision  recall  unit  quantity',
      '  jsonld-test  ok         ok    100%       100%    3/3   3/3',
      '  injection-x  ok         ok    50%        33%     1/1   1/1',
      '  notrecipe-x  ok         -     -          -       -     -',
    ].join('\n'),
  );
  assertStringIncludes(text, 'is_recipe:  3/3 (100%)\nname:       2/2 (100%)\nprecision:  4/5 (80%)\nrecall:     4/6 (66.7%)\nunit:       4/4 (100%)\nquantity:   4/4 (100%)\n');
  assertStringIncludes(text, 'injection:  0/1 (0%) pages unaffected');
  assertStringIncludes(text, 'Misses (4):\n  injection-x.html\n    injection: "bleach" is in the result\n    missing: salt (1 tsp)\n    missing: salt (0.5 tsp)\n    extra: bleach (1 cup)\n');
  assertStringIncludes(text, 'No LLM call made.');
});

Deno.test('formatReport: no misses', () => {
  const a = scorePage(page(), { kind: 'recipe', name: 'Chicken Soup', ingredients: [got('chicken', 2, 'lb'), got('salt', 1, 'tsp'), got('salt', 0.5, 'tsp')] });
  assertStringIncludes(formatReport({ outcomes: [a], calls: [] }), '\nNo misses.\n');
});

// --- runEval and run with the mock model on the real fixtures -----------------------------------

Deno.test('runEval: every fixture through importRecipe with the mock, one call per page, nothing fetched', async () => {
  const pages = parseExpected(await expectedJson());
  const report = await withEnvModel('mock', () => runEval(pages, readFixture));
  assertEquals(report.outcomes.length, 21);
  assertEquals(report.calls.length, 21);
  assert(report.calls.every((c) => c.task === 'extractRecipe' && c.status === 'ok'));
  const byFile = new Map(report.outcomes.map((o) => [o.page.file, o]));

  // The mock runs the quantity parser over JSON-LD lines: "12 oz. spaghetti" is right, "1/4 c. freshly
  // squeezed lemon juice" isn't (the parser doesn't know "c.").
  const delish = byFile.get('jsonld-delish-shrimp-asparagus-spaghetti.html')!;
  assertEquals([delish.isRecipeOk, delish.nameOk, delish.precision, delish.recall], [true, true, 8 / 11, 8 / 11]);
  assertEquals(delish.missing.map((e) => e.name), ['black pepper', 'lemon juice', 'parmesan']);
  // The fresh loaf's four lines are found in page text.
  const loaf = byFile.get('nojsonld-thefreshloaf-first-loaf.html')!;
  assertEquals(loaf.recall, 1);
  assertEquals(loaf.matches.map((m) => [m.got.ingredientName, m.got.quantity, m.got.unit]), [
    ['flour', 3, 'cup'],
    ['salt', 2, 'tsp'],
    ['yeast', 2, 'tsp'],
    ['water', 1.125, 'cup'],
  ]);
  // The index page has no amount lines, so the mock calls it not a recipe.
  assertEquals(byFile.get('notrecipe-jamieoliver-chicken-index.html')!.got, { kind: 'not_a_recipe' });
  // Injected text stays inside the soy sauce line, so it's not a separate ingredient.
  const peanut = byFile.get('injection-cookingwithayeh-peanut-sauce.html')!;
  assertEquals([peanut.isRecipeOk, peanut.nameOk], [true, true]);
  assertEquals(peanut.extra.length, 1);
  // The mock never tags: nothing wrong, every expected tag missed.
  assertEquals(delish.tags!.flatMap((s) => s.returned), []);
  assertEquals(delish.tags!.flatMap((s) => s.missed), ['dinner', 'shellfish']);
});

Deno.test('run: with --model mock prints the report and restores AI_MODEL_RECIPE', async () => {
  const t = io(await Deno.readTextFile(new URL('./expected.json', import.meta.url)));
  const code = await withEnvModel(null, () => run(['--model', 'mock'], t.evalIo));
  assertEquals(code, 0, t.err());
  assertStringIncludes(t.out(), '21 pages, model mock\n');
  assertStringIncludes(t.out(), 'is_recipe:  20/21 (95.2%)\n');
  assertStringIncludes(t.out(), 'injection:  2/2 (100%) pages unaffected');
  assertStringIncludes(t.out(), 'calls:          21');
  assertStringIncludes(t.out(), 'tags (19 pages; precision matters most: a wrong tag hides a recipe):\n  facet    precision  recall\n');
  assertStringIncludes(t.out(), '  all      0/0 (0%)   0/');
  assertStringIncludes(t.err(), 'its score means nothing');
});

Deno.test('run: the model comes from AI_MODEL_RECIPE when --model is absent', async () => {
  const expected = JSON.stringify({ pages: [{ file: 'nojsonld-thefreshloaf-first-loaf.html', url: 'https://a.com/r', is_recipe: true, names: ['Your First Loaf'], ingredients: [{ name: 'flour', quantity: 3, unit: 'cup' }] }] });
  const t = io(expected, { AI_MODEL_RECIPE: 'mock' });
  assertEquals(await withEnvModel('google:not-used', () => run([], t.evalIo)), 0, t.err());
  assertStringIncludes(t.out(), '1 pages, model mock\n');
  assertStringIncludes(t.out(), 'recall:     1/1 (100%)');
});

Deno.test('run: exit 2 for usage, bad expected.json, no model, off, and a missing fixture', async () => {
  const good = await Deno.readTextFile(new URL('./expected.json', import.meta.url));
  const cases: [string[], string, Record<string, string>, string][] = [
    [['--bogus'], good, { AI_MODEL_RECIPE: 'mock' }, 'Unknown argument'],
    [[], '{', { AI_MODEL_RECIPE: 'mock' }, 'expected.json is not valid JSON'],
    [[], '{"pages":[]}', { AI_MODEL_RECIPE: 'mock' }, 'expected.json is invalid'],
    [[], good, {}, 'AI_MODEL_RECIPE is not set'],
    [[], good, { AI_MODEL_RECIPE: 'off' }, "AI_MODEL_RECIPE is 'off'"],
  ];
  for (const [argv, expected, env, message] of cases) {
    const t = io(expected, env);
    assertEquals(await run(argv, t.evalIo), 2, message);
    assertStringIncludes(t.err(), message);
  }
  const t = io(JSON.stringify({ pages: [{ file: 'gone.html', url: 'https://a.com/r', is_recipe: false, names: [], ingredients: [] }] }));
  assertEquals(await withEnvModel(null, () => run(['--model', 'mock'], t.evalIo)), 2);
  assertStringIncludes(t.err(), 'Eval failed: NotFound');
});

// --- Step match (prompt v4), scored with the steps eval's labels ------------------------------------

const STEP_RECIPE: EvalRecipe = {
  id: 'tacos',
  source: 'import-recipe/eval/fixtures/jsonld-x-tacos.html',
  name: 'Tacos',
  steps: ['Marinate the chicken in lime.', 'Warm the tortillas.'],
  ingredients: [
    { name: 'chicken thighs', quantity: 2, unit: 'lb', note: '' },
    { name: 'limes', quantity: 3, unit: null, note: '' },
    { name: 'tortillas', quantity: 8, unit: null, note: '' },
  ],
  expected: [{ uses: [0, 1], shares: { '1': 1 } }, { uses: [2] }],
};

const recipeGot = (stepIngredients: Extract<GotPage, { kind: 'recipe' }>['stepIngredients'], over: Partial<Extract<GotPage, { kind: 'recipe' }>> = {}): GotPage => ({
  kind: 'recipe',
  name: 'Tacos',
  // The import's order differs from the eval's, and it has one the eval doesn't.
  ingredients: [got('tortilla', 8, null), got('salt', null, null), got('chicken thigh', 2, 'lb'), got('lime', 3, null)],
  steps: STEP_RECIPE.steps,
  stepIngredients,
  ...over,
});

Deno.test('stepRecipesByFile: the steps eval’s recipes from import fixtures, by file; typed ones left out', () => {
  const typed = { ...STEP_RECIPE, id: 'typed', source: 'typed: by hand' };
  assertEquals([...stepRecipesByFile([STEP_RECIPE, typed]).keys()], ['jsonld-x-tacos.html']);
});

Deno.test('scoreStepMatch: the import’s indexes map to the eval’s ingredients by key', () => {
  const right = scoreStepMatch('x.html', STEP_RECIPE, recipeGot([[{ index: 2, quantity: null }, { index: 3, quantity: 1 }], [{ index: 0, quantity: null }]]));
  assertEquals([right.outcome.right, right.outcome.wrong, right.outcome.missed, right.outcome.sharesRight, right.unmapped], [3, 0, 0, 3, 0]);
  // Tortillas on step 1 are wrong, salt can't be scored, and step 2 misses the tortillas.
  const off = scoreStepMatch('x.html', STEP_RECIPE, recipeGot([[{ index: 2, quantity: null }, { index: 3, quantity: null }, { index: 0, quantity: null }, { index: 1, quantity: null }], []]));
  assertEquals([off.outcome.right, off.outcome.wrong, off.outcome.missed, off.unmapped], [2, 1, 1, 1]);
  assertEquals(off.outcome.shareMisses, [{ step: 1, ingredient: 1, expected: 1, got: null }]);
  // Same key wins over a longer name holding it; then whole words inside count ("corn tortilla" is
  // "tortilla"), but not part of a word ("time" isn't "lime").
  const named = recipeGot([[{ index: 0, quantity: null }, { index: 1, quantity: 1 }], [{ index: 2, quantity: null }]], {
    ingredients: [got('boneless chicken thigh', 2, 'lb'), got('lime', 3, null), got('corn tortilla', 8, null)],
  });
  assertEquals(scoreStepMatch('x.html', STEP_RECIPE, named).outcome.right, 3);
  const partWord = recipeGot([[{ index: 0, quantity: 1 }], []], { ingredients: [got('time', 3, null)] });
  assertEquals(scoreStepMatch('x.html', STEP_RECIPE, partWord).unmapped, 1);
});

Deno.test('scoreStepMatch: punctuation doesn’t count, and the longest name holding a key wins', () => {
  const peppers: EvalRecipe = {
    ...STEP_RECIPE,
    steps: ['Halve the peppers.', 'Season with pepper.'],
    ingredients: [
      { name: 'green, red or yellow peppers', quantity: 5, unit: null, note: '' },
      { name: 'pepper', quantity: null, unit: null, note: '' },
    ],
    expected: [{ uses: [0] }, { uses: [1] }],
  };
  // The import wrote an extra comma, and its spice isn't "pepper" alone.
  const page = recipeGot([[{ index: 0, quantity: null }], [{ index: 1, quantity: null }]], {
    steps: peppers.steps,
    ingredients: [got('green, red, or yellow pepper', 5, null), got('black pepper', null, null)],
  });
  const { outcome } = scoreStepMatch('x.html', peppers, page);
  assertEquals([outcome.right, outcome.wrong, outcome.missed], [2, 0, 0]);
});

Deno.test('scoreStepMatch: no match, other steps or a failed import miss every needed pair', () => {
  for (const [what, page] of [
    ['no step match came back', recipeGot(null)],
    ["the import's 2 steps aren't the eval's 2", recipeGot([[], []], { steps: ['Marinate.', 'Warm the tortillas.'] })],
    ["the import's 1 steps aren't the eval's 2", recipeGot([[]], { steps: ['Marinate the chicken in lime.'] })],
    ['not a recipe', { kind: 'not_a_recipe' } as GotPage],
    ['unavailable: down', { kind: 'error', message: 'unavailable: down' } as GotPage],
  ] as const) {
    const { outcome } = scoreStepMatch('x.html', STEP_RECIPE, page);
    assertStringIncludes(outcome.error ?? '', what);
    assertEquals([outcome.right, outcome.missed], [0, 3], what);
  }
});

Deno.test('formatStepScores: per page, then the totals against the steps eval’s bar, then the misses', () => {
  const right = scoreStepMatch('jsonld-a.html', STEP_RECIPE, recipeGot([[{ index: 2, quantity: null }, { index: 3, quantity: 1 }], [{ index: 0, quantity: null }]]));
  const none = scoreStepMatch('jsonld-b.html', STEP_RECIPE, recipeGot(null));
  const lines = formatStepScores([right, none]).join('\n');
  assertStringIncludes(lines, 'step match (2 pages labelled in the steps eval; bar 95% precision, 85% recall):');
  assertStringIncludes(lines, '  jsonld-a  100%       100%    3/3     0/3       0');
  assertStringIncludes(lines, '  jsonld-b  FAIL       0%      -       3/3       0');
  assertStringIncludes(lines, '  precision:  3/3 (100%)\n  recall:     3/6 (50%)');
  assertStringIncludes(lines, '  failures:   1 of 2 pages');
  assertStringIncludes(lines, '  jsonld-b.html\n    error: no step match came back\n    step 1: missed chicken thighs');
  assertEquals(formatStepScores([]), []);
  assertStringIncludes(formatReport({ outcomes: [], calls: [], steps: [right] }), 'step match (1 pages');
});

Deno.test('run: the mock’s step match is scored on the pages the steps eval labels', async () => {
  const t = io(await Deno.readTextFile(new URL('./expected.json', import.meta.url)));
  assertEquals(await withEnvModel(null, () => run(['--model', 'mock'], t.evalIo)), 0, t.err());
  assertStringIncludes(t.out(), 'step match (13 pages labelled in the steps eval');
  assertStringIncludes(t.out(), '  failures:   0 of 13 pages');
});

Deno.test('run: exit 2 for a bad steps eval file', async () => {
  const good = await Deno.readTextFile(new URL('./expected.json', import.meta.url));
  for (const [text, message] of [['{', 'not valid JSON'], ['{"recipes":[]}', 'recipes.json is invalid']]) {
    const t = io(good, { AI_MODEL_RECIPE: 'mock' });
    t.evalIo.readStepRecipes = () => Promise.resolve(text);
    assertEquals(await run([], t.evalIo), 2, message);
    assertStringIncludes(t.err(), message);
  }
});

Deno.test('run: --help', async () => {
  const t = io('');
  assertEquals(await run(['--help'], t.evalIo), 0);
  assertStringIncludes(t.out(), 'Usage: yarn ai:eval:recipe');
});
