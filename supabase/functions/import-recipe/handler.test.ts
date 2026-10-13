import { normalizeIngredientName, OTHER_CATEGORY_ID, SYSTEM_CATEGORIES, type ExtractedRecipe, type RecipeImportResponse } from '@shared/index.ts';
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { APICallError, type LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { mockExtractRecipe, pageFromPrompt } from '../_shared/ai/mock-model.ts';
import { EXTRACT_RECIPE_PROMPT_VERSION } from '../_shared/ai/prompts/extract-recipe.v2.ts';
import type { AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { NotEntitledError, type Feature } from '../_shared/entitlements.ts';
import { fetchPage } from '../_shared/fetch-page.ts';
import {
  categorize,
  CategorizeLimitError,
  type CategorizedAnswer,
  type CategorizeStore,
  type IngredientRow,
  type LimitResult,
} from '../categorize-ingredients/handler.ts';
import { CACHE_MAX_AGE_MS, importRecipe, ImportRecipeError, type CachedImport, type ImportDeps, type RecipeImportStore } from './handler.ts';
import { AI_FAILED_RETRY_AFTER, handleRequest, PAUSED_RETRY_AFTER } from './request.ts';

const cat = (slug: string) => SYSTEM_CATEGORIES.find((c) => c.slug === slug)!.id;
const ENDPOINT = 'http://localhost/functions/v1/import-recipe';
const NOW = Date.parse('2026-10-10T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

// --- Pages --------------------------------------------------------------------------------------

const PASTA_URL = 'https://www.example.com/garlic-pasta/?utm_source=pin#jump';
const PASTA_KEY = 'https://example.com/garlic-pasta';
const PASTA_JSON_LD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: 'Garlic Pasta',
  recipeYield: '4 servings',
  recipeIngredient: ['2 cloves garlic, minced', '1 lb spaghetti', '2 tbsp olive oil', 'Salt, to taste'],
});
const PASTA_PAGE = `<html><head><title>Garlic Pasta | Example</title>
<script type="application/ld+json">${PASTA_JSON_LD}</script></head>
<body><article><h1>Garlic Pasta</h1><p>Our favourite weeknight dinner.</p></article></body></html>`;

const BARS_URL = 'https://bakes.example.org/lemon-bars';
const BARS_PAGE = `<html><head><title>Lemon Bars</title></head><body>
<nav>Home</nav><article><h1>Lemon Bars</h1><h2>Ingredients</h2>
<ul><li>1 cup flour</li><li>2 lemons, juiced</li><li>3 eggs</li></ul>
<h2>Method</h2><p>Mix everything and bake for 20 minutes.</p></article></body></html>`;

const NEWS_URL = 'https://news.example.net/story';
const NEWS_PAGE = `<html><head><title>Town council meets</title></head><body><article>
<p>The council met on Tuesday to discuss parking.</p></article></body></html>`;

const EMPTY_URL = 'https://example.com/empty';
const EMPTY_PAGE = '<html><head><title>Nothing</title></head><body></body></html>';

/** Public addresses for every example host; anything else doesn't resolve. */
const DNS: Record<string, string[]> = {
  'www.example.com': ['93.184.216.34'],
  'example.com': ['93.184.216.34'],
  'bakes.example.org': ['93.184.216.35'],
  'news.example.net': ['93.184.216.36'],
  'intranet.example.com': ['10.0.0.5'],
  'redirect.example.com': ['93.184.216.37'],
};

const PAGES: Record<string, string> = {
  [PASTA_URL]: PASTA_PAGE,
  [BARS_URL]: BARS_PAGE,
  [NEWS_URL]: NEWS_PAGE,
  [EMPTY_URL]: EMPTY_PAGE,
};

// --- Fakes --------------------------------------------------------------------------------------

class FakeRecipeStore implements RecipeImportStore {
  constructor(readonly aiCalls: AiCallRecord[]) {}
  limit: LimitResult = 'ok';
  limitChecks = 0;
  cache = new Map<string, CachedImport>();
  saves: { urlKey: string; promptVersion: string; result: ExtractedRecipe }[] = [];
  now = NOW;

  async checkLimit() {
    this.limitChecks++;
    return this.limit;
  }
  async getCached(urlKey: string, promptVersion: string) {
    return this.cache.get(`${urlKey}|${promptVersion}`) ?? null;
  }
  async saveCached(urlKey: string, promptVersion: string, result: ExtractedRecipe) {
    this.saves.push({ urlKey, promptVersion, result });
    this.cache.set(`${urlKey}|${promptVersion}`, { result, is_recipe: result.is_recipe, created_at: new Date(this.now).toISOString() });
  }
  async logAiCall(call: AiCallRecord) {
    this.aiCalls.push(call);
  }
  /** The features the caller's plan has, and every feature checked. */
  features = new Set<Feature>(['categorize', 'recipe_import', 'recipe_import_photo']);
  featureChecks: Feature[] = [];
  async requireFeature(feature: Feature) {
    this.featureChecks.push(feature);
    if (!this.features.has(feature)) throw new NotEntitledError(feature);
  }
}

/** In-memory `ingredients`, enough for categorize(). */
class FakeCategorizeStore implements CategorizeStore {
  constructor(readonly aiCalls: AiCallRecord[]) {}
  rows = new Map<string, IngredientRow>();
  limit: LimitResult = 'ok';

  seed(name: string, categoryId: string) {
    this.rows.set(name, { normalized_name: name, status: 'categorized', default_category_id: categoryId, is_grocery_item: true, default_unit: null, attempts: 0 });
  }
  async getIngredients(names: readonly string[]) {
    return names.flatMap((n) => (this.rows.has(n) ? [{ ...this.rows.get(n)! }] : []));
  }
  async insertPending(rows: readonly { normalized_name: string }[]) {
    for (const r of rows) {
      if (!this.rows.has(r.normalized_name)) {
        this.rows.set(r.normalized_name, { normalized_name: r.normalized_name, status: 'pending', default_category_id: null, is_grocery_item: null, default_unit: null, attempts: 0 });
      }
    }
  }
  async saveCategorized(rows: readonly CategorizedAnswer[]) {
    for (const a of rows) Object.assign(this.rows.get(a.normalized_name)!, { ...a, status: 'categorized' });
  }
  async saveFailed(names: readonly string[]) {
    for (const n of names) Object.assign(this.rows.get(n)!, { status: 'failed', default_category_id: OTHER_CATEGORY_ID });
  }
  async logAiCall(call: AiCallRecord) {
    this.aiCalls.push(call);
  }
  async checkLimit() {
    return this.limit;
  }
  /** Like index.ts: `recipe_import` was checked first and implies `categorize`. */
  async requireFeature() {}
}

/** A model whose every call throws `error`. */
function failingModel(error: Error): { instance: LanguageModel; modelId: string } {
  return {
    instance: new MockLanguageModelV4({
      doGenerate: async () => {
        throw error;
      },
    }),
    modelId: 'test:failing',
  };
}

/** A model answering with the recipe mock, then `edit` applied to its answer. */
function editedModel(edit: (answer: ReturnType<typeof mockExtractRecipe>) => unknown) {
  return {
    instance: new MockLanguageModelV4({
      doGenerate: async (options) => {
        const user = options.prompt.find((m) => m.role === 'user');
        const text = user && Array.isArray(user.content) ? user.content.map((p) => (p.type === 'text' ? p.text : '')).join('') : '';
        return {
          content: [{ type: 'text', text: JSON.stringify(edit(mockExtractRecipe(pageFromPrompt(text)))) }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        };
      },
    }),
    modelId: 'test:edited',
  };
}

/** The real fetchPage over the fake DNS and pages; records every URL fetched. */
function setup(overrides: Partial<ImportDeps> = {}) {
  const aiCalls: AiCallRecord[] = [];
  const store = new FakeRecipeStore(aiCalls);
  const catStore = new FakeCategorizeStore(aiCalls);
  const fetched: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    if (url === 'https://redirect.example.com/r') {
      return new Response(null, { status: 302, headers: { location: 'https://intranet.example.com/admin' } });
    }
    const html = PAGES[url];
    if (html === undefined) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/html' } });
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }) as typeof fetch;
  const deps: ImportDeps = {
    store,
    categorize: (names) => categorize(names, catStore),
    fetchPage: (url) => fetchPage(url, { resolve: async (host) => DNS[host] ?? [], fetch: fakeFetch }),
    now: () => store.now,
    ...overrides,
  };
  const calls = (task: string) => aiCalls.filter((c) => c.task === task).length;
  const post = (body: unknown) =>
    handleRequest(new Request(ENDPOINT, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), {
      importRecipe: (request) => importRecipe(request, deps),
      env: (key) => Deno.env.get(key),
    });
  return { store, catStore, deps, aiCalls, fetched, calls, post };
}

async function withEnv(vars: Record<string, string | null>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, Deno.env.get(k)]));
  const set = (k: string, v: string | null | undefined) => (v == null ? Deno.env.delete(k) : Deno.env.set(k, v));
  for (const [k, v] of Object.entries(vars)) set(k, v);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) set(k, v);
  }
}

/** Both tasks run on their mocks unless a test says otherwise. */
const test = (name: string, fn: () => Promise<void>) =>
  Deno.test(name, () => withEnv({ AI_MODEL_RECIPE: 'mock', AI_MODEL_CATEGORIZE: 'mock', AI_MODEL_RECIPE_FALLBACK: null, AI_MODEL_CATEGORIZE_FALLBACK: null }, fn));

async function expectError(res: Response, status: number, code: string) {
  assertEquals(res.status, status);
  assertEquals((await res.json()).error, code);
}

const PASTA_RESPONSE: RecipeImportResponse = {
  name: 'Garlic Pasta',
  sourceUrl: PASTA_KEY,
  servings: 4,
  ingredients: [
    { ingredientName: 'garlic', displayName: 'garlic', quantity: 2, unit: 'clove', note: 'minced', categoryId: cat('pantry'), status: 'categorized' },
    { ingredientName: 'spaghetti', displayName: 'spaghetti', quantity: 1, unit: 'lb', note: '', categoryId: cat('pasta-grains'), status: 'categorized' },
    { ingredientName: 'olive oil', displayName: 'olive oil', quantity: 2, unit: 'tbsp', note: '', categoryId: cat('pantry'), status: 'categorized' },
    { ingredientName: 'salt', displayName: 'Salt', quantity: null, unit: null, note: 'to taste', categoryId: cat('spices'), status: 'categorized' },
  ],
  // The mock never tags, and the page gives no time.
  tags: { meal: [], cuisine: [], protein: [], diet: [], method: [] },
  totalMinutes: null,
};

// --- JSON-LD and text -----------------------------------------------------------------------------

test('JSON-LD path: 1 extract call on the JSON-LD lines, 1 categorize call, then the full response', async () => {
  const { post, calls, aiCalls, fetched, store } = setup();
  const res = await post({ url: PASTA_URL });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), PASTA_RESPONSE);
  assertEquals(calls('extractRecipe'), 1);
  assertEquals(calls('categorize'), 1);
  assertEquals(fetched, [PASTA_URL], 'the URL as given is fetched, not the canonical key');
  const prompt = aiCalls.find((c) => c.task === 'extractRecipe')!.prompt;
  assertStringIncludes(prompt, '"ingredient_lines":["2 cloves garlic, minced","1 lb spaghetti","2 tbsp olive oil","Salt, to taste"]');
  assertStringIncludes(prompt, '"title":"Garlic Pasta"', 'the JSON-LD name is the title sent');
  assert(!prompt.includes('weeknight'), 'page text is not sent when JSON-LD has the recipe');
  assertEquals(store.limitChecks, 1);
});

test('JSON-LD path makes 0 categorize calls when every name is already known', async () => {
  const { post, calls, catStore } = setup();
  for (const [name, slug] of [['garlic', 'produce'], ['spaghetti', 'pasta-grains'], ['olive oil', 'pantry'], ['salt', 'spices']]) {
    catStore.seed(normalizeIngredientName(name), cat(slug));
  }
  const body: RecipeImportResponse = await (await post({ url: PASTA_URL })).json();
  assertEquals(calls('extractRecipe'), 1);
  assertEquals(calls('categorize'), 0);
  assertEquals(body.ingredients.map((i) => [i.ingredientName, i.categoryId, i.status]), [
    ['garlic', cat('produce'), 'categorized'],
    ['spaghetti', cat('pasta-grains'), 'categorized'],
    ['olive oil', cat('pantry'), 'categorized'],
    ['salt', cat('spices'), 'categorized'],
  ]);
});

test('text fallback: no JSON-LD sends the page text and takes the name from the title', async () => {
  const { post, calls, aiCalls, store } = setup();
  const res = await post({ url: BARS_URL });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    name: 'Lemon Bars',
    sourceUrl: BARS_URL,
    servings: null,
    ingredients: [
      { ingredientName: 'flour', displayName: 'flour', quantity: 1, unit: 'cup', note: '', categoryId: cat('pantry'), status: 'categorized' },
      { ingredientName: 'lemon', displayName: 'lemons', quantity: 2, unit: null, note: 'juiced', categoryId: cat('produce'), status: 'categorized' },
      { ingredientName: 'egg', displayName: 'eggs', quantity: 3, unit: null, note: '', categoryId: cat('dairy-eggs'), status: 'categorized' },
    ],
    tags: { meal: [], cuisine: [], protein: [], diet: [], method: [] },
    totalMinutes: null,
  });
  assertEquals(calls('extractRecipe'), 1);
  assertEquals(calls('categorize'), 1);
  const prompt = aiCalls[0].prompt;
  assertStringIncludes(prompt, '"text":"');
  assertStringIncludes(prompt, 'Mix everything');
  assert(!prompt.includes('ingredient_lines'));
  assert(!prompt.includes('Home'), 'nav is stripped from the text');
  assertEquals(store.saves.length, 1, 'a server-fetched text extraction is cached too');
});

test('a client-supplied page is used as is: no fetch', async () => {
  const { post, fetched, calls } = setup();
  const res = await post({ url: PASTA_URL, page: { title: 'Garlic Pasta', jsonLd: [PASTA_JSON_LD] } });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), PASTA_RESPONSE);
  assertEquals(fetched, []);
  assertEquals(calls('extractRecipe'), 1);
});

test('the model’s name and servings win; JSON-LD fills an empty name and its yield wins', async () => {
  const { deps } = setup({ model: editedModel((a) => ({ ...a, name: '  ', servings: 9 })) });
  const res = await importRecipe({ url: PASTA_URL }, deps);
  assertEquals(res.name, 'Garlic Pasta');
  assertEquals(res.servings, 4);

  const text = setup({ model: editedModel((a) => ({ ...a, name: 'Best Lemon Bars', servings: 16 })) });
  const bars = await importRecipe({ url: BARS_URL }, text.deps);
  assertEquals(bars.name, 'Best Lemon Bars');
  assertEquals(bars.servings, 16, 'with no JSON-LD the model’s servings are used');
});

test('the output caps apply: long names are dropped, unknown units go to the note', async () => {
  const { deps } = setup({
    model: editedModel((a) => ({
      ...a,
      ingredients: [
        { name: 'x'.repeat(65), quantity: 1, unit: null, note: '' },
        { name: 'thyme', quantity: 2, unit: 'sprig', note: 'fresh' },
        ...a.ingredients.slice(0, 1),
      ],
    })),
  });
  const res = await importRecipe({ url: PASTA_URL }, deps);
  assertEquals(res.ingredients.map((i) => [i.ingredientName, i.quantity, i.unit, i.note]), [
    ['thyme', 2, null, 'sprig, fresh'],
    ['garlic', 2, 'clove', 'minced'],
  ]);
});

// --- Tags and time (spec 4.14) ------------------------------------------------------------------------

const TAGS = { meal: ['dinner'], cuisine: ['italian'], protein: [], diet: ['vegetarian'], method: ['one-pot'] };

test('v2: the model’s tags come back in the response and are cached with the extraction', async () => {
  const { post, store } = setup({ model: editedModel((a) => ({ ...a, tags: TAGS })) });
  const body: RecipeImportResponse = await (await post({ url: PASTA_URL })).json();
  assertEquals(body.tags, TAGS);
  assertEquals(store.saves[0].result.tags, TAGS);
});

test('v2: a slug that isn’t in the list drops only its facet, and the import still succeeds', async () => {
  const { post } = setup({
    model: editedModel((a) => ({ ...a, tags: { ...TAGS, cuisine: ['italian', 'tuscan'], diet: ['keto'] } })),
  });
  const res = await post({ url: PASTA_URL });
  assertEquals(res.status, 200);
  const body: RecipeImportResponse = await res.json();
  assertEquals(body.tags, { ...TAGS, cuisine: [], diet: [] });
  assertEquals(body.ingredients.length, 4);
});

test('v2: a facet over its maximum is capped', async () => {
  const { post } = setup({
    model: editedModel((a) => ({ ...a, tags: { ...TAGS, meal: ['lunch', 'dinner', 'side'], protein: ['chicken', 'beef', 'pork', 'lamb'] } })),
  });
  const body: RecipeImportResponse = await (await post({ url: PASTA_URL })).json();
  assertEquals(body.tags?.meal, ['lunch', 'dinner']);
  assertEquals(body.tags?.protein, ['chicken', 'beef', 'pork']);
});

const timedJsonLd = (time: Record<string, string>) => JSON.stringify({ ...JSON.parse(PASTA_JSON_LD), ...time });

test('v2: the JSON-LD time beats the model’s', async () => {
  const { post } = setup({ model: editedModel((a) => ({ ...a, total_minutes: 90 })) });
  const totalTime: RecipeImportResponse = await (await post({ url: PASTA_URL, page: { jsonLd: [timedJsonLd({ totalTime: 'PT40M' })] } })).json();
  assertEquals(totalTime.totalMinutes, 40);
  const prepCook: RecipeImportResponse = await (
    await post({ url: PASTA_URL, page: { jsonLd: [timedJsonLd({ prepTime: 'PT10M', cookTime: 'PT1H' })] } })
  ).json();
  assertEquals(prepCook.totalMinutes, 70);
});

test('v2: with no usable JSON-LD time the model’s is used; the mock gives none', async () => {
  const model = setup({ model: editedModel((a) => ({ ...a, total_minutes: 90 })) });
  // Client pages first: a server import would be cached and served to them.
  const garbage: RecipeImportResponse = await (
    await model.post({ url: PASTA_URL, page: { jsonLd: [timedJsonLd({ totalTime: '40 minutes' })] } })
  ).json();
  assertEquals(garbage.totalMinutes, 90);
  const noTime: RecipeImportResponse = await (await model.post({ url: PASTA_URL })).json();
  assertEquals(noTime.totalMinutes, 90);
  assertEquals(model.calls('extractRecipe'), 2);
  const text: RecipeImportResponse = await (await model.post({ url: BARS_URL })).json();
  assertEquals(text.totalMinutes, 90, 'page text has no JSON-LD time');

  const mock = setup();
  const jsonLdOnly: RecipeImportResponse = await (await mock.post({ url: PASTA_URL, page: { jsonLd: [timedJsonLd({ totalTime: 'PT25M' })] } })).json();
  assertEquals(jsonLdOnly.totalMinutes, 25, 'the mock returns the JSON-LD time');
  assertEquals((await (await mock.post({ url: BARS_URL })).json()).totalMinutes, null);
});

test('v2: a model time out of range is null', async () => {
  for (const minutes of [0, -5, 3000]) {
    const { post } = setup({ model: editedModel((a) => ({ ...a, total_minutes: minutes })) });
    assertEquals(((await (await post({ url: PASTA_URL })).json()) as RecipeImportResponse).totalMinutes, null, String(minutes));
  }
});

test('v2: the cache key is the v2 prompt version; a cached v1 result (no tags) is not served', async () => {
  assertEquals(EXTRACT_RECIPE_PROMPT_VERSION, 'extract-recipe.v2');
  const { post, store, calls } = setup({ model: editedModel((a) => ({ ...a, tags: TAGS })) });
  store.cache.set(`${PASTA_KEY}|extract-recipe.v1`, {
    result: { is_recipe: true, name: 'Old Pasta', servings: 2, ingredients: [{ name: 'garlic', quantity: 1, unit: null, note: '' }] },
    is_recipe: true,
    created_at: new Date(NOW).toISOString(),
  });
  const body: RecipeImportResponse = await (await post({ url: PASTA_URL })).json();
  assertEquals([body.name, body.tags], ['Garlic Pasta', TAGS]);
  assertEquals(calls('extractRecipe'), 1);
  assertEquals(store.saves.map((s) => [s.urlKey, s.promptVersion]), [[PASTA_KEY, 'extract-recipe.v2']]);

  // A cached v2 result is served with its tags and time, with no call.
  const again: RecipeImportResponse = await (await post({ url: PASTA_URL })).json();
  assertEquals(again.tags, TAGS);
  assertEquals(calls('extractRecipe'), 1);
});

// --- Cache ------------------------------------------------------------------------------------------

test('a cache hit makes 0 LLM calls and no fetch, even for another spelling of the URL', async () => {
  const { post, calls, fetched, store, aiCalls } = setup();
  assertEquals((await post({ url: PASTA_URL })).status, 200);
  assertEquals(store.saves.map((s) => [s.urlKey, s.promptVersion]), [[PASTA_KEY, EXTRACT_RECIPE_PROMPT_VERSION]]);
  aiCalls.length = 0;
  fetched.length = 0;

  const res = await post({ url: 'https://EXAMPLE.com/garlic-pasta/?fbclid=abc' });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), PASTA_RESPONSE);
  assertEquals(calls('extractRecipe') + calls('categorize'), 0, 'names were categorized by the first import');
  assertEquals(fetched, []);
  assertEquals(store.limitChecks, 2, 'a cache hit still counts against the limits');
});

test('a cache hit is used even when the client sends a page', async () => {
  const { post, calls, store } = setup();
  await post({ url: BARS_URL });
  const res = await post({ url: BARS_URL, page: { title: 'Something else', text: '5 cups sugar' } });
  assertEquals(((await res.json()) as RecipeImportResponse).name, 'Lemon Bars');
  assertEquals(calls('extractRecipe'), 1);
  assertEquals(store.saves.length, 1);
});

test('a cache row 30 days old or more is a miss and is replaced', async () => {
  const { post, calls, fetched, store } = setup();
  store.now = NOW - 30 * DAY;
  await post({ url: PASTA_URL });
  store.now = NOW;
  fetched.length = 0;
  await post({ url: PASTA_URL });
  assertEquals(calls('extractRecipe'), 2);
  assertEquals(fetched, [PASTA_URL]);
  assertEquals(store.saves.length, 2);
  assertEquals(store.cache.get(`${PASTA_KEY}|${EXTRACT_RECIPE_PROMPT_VERSION}`)!.created_at, new Date(NOW).toISOString());
});

test('a cache row just under 30 days old is a hit', async () => {
  const { post, calls, store } = setup();
  store.now = NOW - CACHE_MAX_AGE_MS + 1000;
  await post({ url: PASTA_URL });
  store.now = NOW;
  assertEquals((await post({ url: PASTA_URL })).status, 200);
  assertEquals(calls('extractRecipe'), 1);
});

test('a cache row that fails the schema is a miss', async () => {
  const { post, calls, store } = setup();
  store.cache.set(`${PASTA_KEY}|${EXTRACT_RECIPE_PROMPT_VERSION}`, {
    result: { is_recipe: true, name: 'Bad', servings: null, ingredients: [{ name: 'x', quantity: 1, unit: 'furlong', note: '' }] },
    is_recipe: true,
    created_at: new Date(NOW).toISOString(),
  });
  assertEquals(await (await post({ url: PASTA_URL })).json(), PASTA_RESPONSE);
  assertEquals(calls('extractRecipe'), 1);
});

test('a client-supplied page isn’t cached; a later server import still fetches and extracts', async () => {
  const { post, calls, fetched, store } = setup();
  const poisoned = { url: PASTA_URL, page: { title: 'Evil', text: '1 cup bleach\n2 cups ammonia' } };
  const first: RecipeImportResponse = await (await post(poisoned)).json();
  assertEquals(first.ingredients.map((i) => i.ingredientName), ['bleach', 'ammonia']);
  assertEquals(store.saves, []);
  assertEquals(store.cache.size, 0);

  assertEquals(await (await post({ url: PASTA_URL })).json(), PASTA_RESPONSE);
  assertEquals(fetched, [PASTA_URL]);
  assertEquals(calls('extractRecipe'), 2);
});

test('a failing cache write still returns the recipe', async () => {
  const { post, store } = setup();
  store.saveCached = () => Promise.reject(new Error('db down'));
  assertEquals((await post({ url: PASTA_URL })).status, 200);
});

// --- Not a recipe ---------------------------------------------------------------------------------

test('not_a_recipe → 422, cached, and a repeat costs nothing', async () => {
  const { post, calls, fetched, store } = setup();
  await expectError(await post({ url: NEWS_URL }), 422, 'not_a_recipe');
  assertEquals(calls('extractRecipe'), 1);
  assertEquals(calls('categorize'), 0);
  assertEquals(store.saves.map((s) => [s.urlKey, s.result.is_recipe]), [[NEWS_URL, false]]);

  fetched.length = 0;
  await expectError(await post({ url: NEWS_URL }), 422, 'not_a_recipe');
  assertEquals(calls('extractRecipe'), 1);
  assertEquals(fetched, []);
});

test('a client-supplied non-recipe is 422 but not cached', async () => {
  const { post, store } = setup();
  await expectError(await post({ url: NEWS_URL, page: { title: 'News', text: 'Just words here.' } }), 422, 'not_a_recipe');
  assertEquals(store.saves, []);
});

test('a page with no JSON-LD recipe and no text is not a recipe, with no LLM call', async () => {
  const { post, calls } = setup();
  await expectError(await post({ url: EMPTY_URL }), 422, 'not_a_recipe');
  await expectError(await post({ url: BARS_URL, page: { jsonLd: ['{"@type":"Article"}'] } }), 422, 'not_a_recipe');
  assertEquals(calls('extractRecipe'), 0);
});

// --- Model failures ---------------------------------------------------------------------------------

test('a provider timeout → 503 with Retry-After, not cached, and the call is logged', async () => {
  const { post, store, aiCalls, calls } = setup({ model: failingModel(new DOMException('The operation timed out', 'TimeoutError')) });
  const res = await post({ url: PASTA_URL });
  await expectError(res, 503, 'unavailable');
  assertEquals(res.headers.get('Retry-After'), String(AI_FAILED_RETRY_AFTER));
  assertEquals(store.saves, []);
  assertEquals(aiCalls.map((c) => c.status), ['timeout']);
  assertEquals(calls('categorize'), 0);
});

test('a provider API error → 503 and not cached', async () => {
  const err = new APICallError({ message: 'overloaded', url: 'https://api.example', requestBodyValues: {}, statusCode: 400, isRetryable: false });
  const { post, store } = setup({ model: failingModel(err) });
  await expectError(await post({ url: PASTA_URL }), 503, 'unavailable');
  assertEquals(store.saves, []);
});

test('schema-invalid model output → 503 and not cached', async () => {
  const { post, store, aiCalls } = setup({ model: editedModel(() => ({ is_recipe: 'yes' })) });
  await expectError(await post({ url: PASTA_URL }), 503, 'unavailable');
  assertEquals(store.saves, []);
  assertEquals(aiCalls.map((c) => c.status), ['invalid_output']);
});

test('an unexpected error is a 500, not a 503', async () => {
  const { post } = setup({ model: failingModel(new TypeError('bug')) });
  await expectError(await post({ url: PASTA_URL }), 500, 'internal_error');
});

// --- Limits and the kill switch ----------------------------------------------------------------------

test('rate limit → 429 before any fetch, cache read or LLM call', async () => {
  const { post, store, fetched, aiCalls } = setup();
  store.limit = 'user_limit';
  store.getCached = () => Promise.reject(new Error('should not be read'));
  await expectError(await post({ url: PASTA_URL }), 429, 'rate_limited');
  assertEquals(fetched, []);
  assertEquals(aiCalls, []);
});

test('the global cap → 503 with Retry-After', async () => {
  const { post, store, fetched, aiCalls } = setup();
  store.limit = 'global_cap';
  const res = await post({ url: PASTA_URL });
  await expectError(res, 503, 'unavailable');
  assertEquals(res.headers.get('Retry-After'), String(PAUSED_RETRY_AFTER));
  assertEquals(fetched, []);
  assertEquals(aiCalls, []);
});

Deno.test('AI_MODEL_RECIPE=off → 503 without counting against the limits', () =>
  withEnv({ AI_MODEL_RECIPE: 'off', AI_MODEL_CATEGORIZE: 'mock' }, async () => {
    const { post, store, fetched } = setup();
    const res = await post({ url: PASTA_URL });
    await expectError(res, 503, 'unavailable');
    assertEquals(res.headers.get('Retry-After'), String(PAUSED_RETRY_AFTER));
    assertEquals(store.limitChecks, 0);
    assertEquals(fetched, []);
  }));

test('categorize’s own limit doesn’t fail the import: the names come back pending', async () => {
  const { post, catStore, calls } = setup();
  catStore.limit = 'user_limit';
  const body: RecipeImportResponse = await (await post({ url: PASTA_URL })).json();
  assertEquals(body.ingredients.map((i) => [i.ingredientName, i.categoryId, i.status]), [
    ['garlic', null, 'pending'],
    ['spaghetti', null, 'pending'],
    ['olive oil', null, 'pending'],
    ['salt', null, 'pending'],
  ]);
  assertEquals(calls('categorize'), 0);
});

test('categorize’s other errors are a 500', async () => {
  const { post } = setup({ categorize: () => Promise.reject(new Error('db down')) });
  await expectError(await post({ url: PASTA_URL }), 500, 'internal_error');
});

test('AI_MODEL_CATEGORIZE=off still imports, with the names pending', async () => {
  await withEnv({ AI_MODEL_CATEGORIZE: 'off' }, async () => {
    const { post, calls } = setup();
    const body: RecipeImportResponse = await (await post({ url: PASTA_URL })).json();
    assertEquals(body.ingredients.map((i) => i.status), ['pending', 'pending', 'pending', 'pending']);
    assertEquals(calls('categorize'), 0);
  });
});

// --- Plans ------------------------------------------------------------------------------------------

for (const features of [[], ['categorize']] as Feature[][]) {
  test(`without recipe_import (plan: ${features.join(', ') || 'none'}): 403 not_entitled before anything else`, async () => {
    const { post, store, fetched, aiCalls } = setup({
      categorize: () => Promise.reject(new Error('should not categorize')),
    });
    store.features = new Set(features);
    store.getCached = () => Promise.reject(new Error('should not be read'));

    const res = await post({ url: PASTA_URL });

    assertEquals(res.status, 403);
    assertEquals(res.headers.get('Retry-After'), null);
    assertEquals(await res.json(), { error: 'not_entitled', message: "Recipe import isn't included in your plan" });
    assertEquals(store.featureChecks, ['recipe_import']);
    assertEquals(store.limitChecks, 0);
    assertEquals(store.saves, []);
    assertEquals(fetched, []);
    assertEquals(aiCalls, []);
  });
}

test('without recipe_import, a client-supplied page is refused too, with nothing extracted', async () => {
  const { deps, store, aiCalls } = setup();
  store.features = new Set(['categorize']);
  const err = await importRecipe({ url: BARS_URL, page: { title: 'Lemon Bars', text: '1 cup flour' } }, deps).then(
    () => null,
    (e: unknown) => e,
  );
  assert(err instanceof ImportRecipeError);
  assertEquals(err.failure, { code: 'not_entitled' });
  assertEquals(store.limitChecks, 0);
  assertEquals(aiCalls, []);
});

test('the plan is checked before the URL and the kill switch', async () => {
  await withEnv({ AI_MODEL_RECIPE: 'off' }, async () => {
    const { post, deps, store } = setup();
    store.features = new Set();
    await expectError(await post({ url: PASTA_URL }), 403, 'not_entitled');
    const err = await importRecipe({ url: 'ftp://example.com/a' }, deps).then(
      () => null,
      (e: unknown) => e,
    );
    assert(err instanceof ImportRecipeError);
    assertEquals(err.failure, { code: 'not_entitled' });
    assertEquals(store.featureChecks, ['recipe_import', 'recipe_import']);
  });
});

test('with recipe_import: checked once, then imported and categorized as usual', async () => {
  const { post, store, calls } = setup();
  store.features = new Set(['categorize', 'recipe_import']);
  const res = await post({ url: PASTA_URL });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), PASTA_RESPONSE);
  assertEquals(store.featureChecks, ['recipe_import']);
  assertEquals(calls('extractRecipe'), 1);
  assertEquals(calls('categorize'), 1);
});

test('an error from the plan check is a 500, with no limit check, fetch or LLM call', async () => {
  const { post, store, fetched, aiCalls } = setup();
  store.requireFeature = () => Promise.reject(new Error('db down'));
  await expectError(await post({ url: PASTA_URL }), 500, 'internal_error');
  assertEquals(store.limitChecks, 0);
  assertEquals(fetched, []);
  assertEquals(aiCalls, []);
});

// --- URLs and fetching ------------------------------------------------------------------------------

test('SSRF URLs → 400 invalid_url, never fetched', async () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:55321/rest/v1/',
    'http://[::1]/',
    'http://localhost/admin',
    'https://intranet.example.com/admin',
  ]) {
    const { post, fetched, aiCalls } = setup();
    await expectError(await post({ url }), 400, 'invalid_url');
    assertEquals(fetched, [], url);
    assertEquals(aiCalls, [], url);
  }
});

test('a redirect to a private address → 400 invalid_url; the private host is never fetched', async () => {
  const { post, fetched } = setup();
  await expectError(await post({ url: 'https://redirect.example.com/r' }), 400, 'invalid_url');
  assertEquals(fetched, ['https://redirect.example.com/r']);
});

test('non-http(s) URLs → 400 invalid_url', async () => {
  for (const url of ['ftp://example.com/recipe', 'javascript:alert(1)', 'not a url', '']) {
    const { post, store } = setup();
    await expectError(await post({ url }), 400, 'invalid_url');
    assertEquals(store.limitChecks, 0, url);
  }
});

test('a page that can’t be fetched → 502 fetch_failed, not cached', async () => {
  const { post, store, aiCalls } = setup();
  await expectError(await post({ url: 'https://example.com/missing' }), 502, 'fetch_failed');
  await expectError(await post({ url: 'https://unknown.example/x' }), 502, 'fetch_failed');
  assertEquals(store.saves, []);
  assertEquals(aiCalls, []);
});

test('importRecipe throws ImportRecipeError with the failure', async () => {
  const { deps, store } = setup();
  store.limit = 'global_cap';
  try {
    await importRecipe({ url: PASTA_URL }, deps);
    throw new Error('expected a throw');
  } catch (err) {
    assert(err instanceof ImportRecipeError);
    assertEquals(err.failure, { code: 'unavailable', reason: 'global_cap' });
  }
  assert(!(new CategorizeLimitError('user_limit') instanceof ImportRecipeError));
});
