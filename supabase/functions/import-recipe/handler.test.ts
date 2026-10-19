import { normalizeIngredientName, OTHER_CATEGORY_ID, SYSTEM_CATEGORIES, type ExtractedRecipe, type RecipeImportResponse } from '@shared/index.ts';
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { APICallError, type LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { mockExtractRecipe, pageFromPrompt } from '../_shared/ai/mock-model.ts';
import { EXTRACT_RECIPE_PROMPT_VERSION } from '../_shared/ai/prompts/extract-recipe.v5.ts';
import type { AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { NotEntitledError, type Feature } from '../_shared/entitlements.ts';
import { fetchPage, readPage } from '../_shared/fetch-page.ts';
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

// JSON-LD with steps and a relative image, and an og:image that loses to it.
const STEW_URL = 'https://www.example.com/beef-stew';
const STEW_KEY = 'https://example.com/beef-stew';
const STEW_JSON_LD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: 'Beef Stew',
  image: { '@type': 'ImageObject', url: '/img/stew-jsonld.jpg' },
  recipeIngredient: ['2 lb beef chuck', '3 carrots'],
  recipeInstructions: [
    { '@type': 'HowToStep', text: '1. Brown the beef.' },
    { '@type': 'HowToSection', name: 'Simmer', itemListElement: [{ '@type': 'HowToStep', text: 'Add the carrots &amp; simmer for 2 hours.' }] },
  ],
});
const STEW_PAGE = `<html><head><title>Beef Stew</title><meta property="og:image" content="https://cdn.example.com/stew-og.jpg">
<script type="application/ld+json">${STEW_JSON_LD}</script></head><body><article><p>Cozy.</p></article></body></html>`;
// v5: the named section is a heading before its step.
const STEW_STEPS = ['Brown the beef.', { section: 'Simmer' }, 'Add the carrots & simmer for 2 hours.'];

// JSON-LD without steps or an image: the page's og:image (relative) is the photo.
const TART_URL = 'https://example.com/tart';
const TART_PAGE = `<html><head><title>Tart</title><meta property="og:image" content="/img/tart.jpg">
<script type="application/ld+json">${JSON.stringify({ '@type': 'Recipe', name: 'Tart', recipeIngredient: ['1 cup flour'] })}</script></head><body></body></html>`;

// No JSON-LD: the model reads the steps; twitter:image stands in for a missing og:image.
const SOUP_URL = 'https://bakes.example.org/soup';
const SOUP_PAGE = `<html><head><title>Leek Soup</title><meta name="twitter:image" content="https://cdn.example.org/soup.jpg"></head><body>
<article><h1>Leek Soup</h1><ul><li>2 leeks</li><li>1 cup stock</li></ul><ol><li>Slice the leeks.</li><li>Simmer in the stock.</li></ol>
<p>Tip: freezes well.</p></article></body></html>`;

// An og:image that isn't https is no photo.
const BAD_IMAGE_URL = 'https://example.com/bad-image';
const BAD_IMAGE_PAGE = `<html><head><title>Toast</title><meta property="og:image" content="http://cdn.example.com/toast.jpg"></head>
<body><p>2 slices bread</p></body></html>`;

const EMPTY_URL = 'https://example.com/empty';
const EMPTY_PAGE = '<html><head><title>Nothing</title></head><body></body></html>';

// A Yoast page whose @graph has no Recipe (spec 6.6 step 5's photo chain); see eval/fixtures/SOURCES.md.
const COTTAGE_URL = 'https://snacks.webxo.xyz/high-protein-cottage-cheese-blueberry-bread/';
const COTTAGE_PHOTO = 'https://snacks.webxo.xyz/wp-content/uploads/2026/05/Screenshot-2026-03-23-112812.png';
const COTTAGE_PAGE = await Deno.readTextFile(new URL('./eval/fixtures/nojsonld-webxo-cottage-cheese-blueberry-bread.html', import.meta.url));

// No JSON-LD or meta image: the photo is the lazy-loaded one in the article, not the logo or avatar.
const SCONES_URL = 'https://bakes.example.org/scones';
const SCONES_PAGE = `<html><head><title>Scones</title></head><body>
<header><img src="/logo.png" class="site-logo"></header><article><img src="/a.png" class="avatar" width="48">
<img src="data:image/gif;base64,R0lGOD" data-src="/img/scones.jpg" width="1200"><h1>Scones</h1>
<ul><li>2 cups flour</li><li>1/2 cup butter</li></ul></article></body></html>`;

/** Public addresses for every example host; anything else doesn't resolve. */
const DNS: Record<string, string[]> = {
  'www.example.com': ['93.184.216.34'],
  'example.com': ['93.184.216.34'],
  'bakes.example.org': ['93.184.216.35'],
  'news.example.net': ['93.184.216.36'],
  'intranet.example.com': ['10.0.0.5'],
  'redirect.example.com': ['93.184.216.37'],
  'snacks.webxo.xyz': ['93.184.216.38'],
};

const PAGES: Record<string, string> = {
  [PASTA_URL]: PASTA_PAGE,
  [BARS_URL]: BARS_PAGE,
  [NEWS_URL]: NEWS_PAGE,
  [EMPTY_URL]: EMPTY_PAGE,
  [STEW_URL]: STEW_PAGE,
  [TART_URL]: TART_PAGE,
  [SOUP_URL]: SOUP_PAGE,
  [BAD_IMAGE_URL]: BAD_IMAGE_PAGE,
  [COTTAGE_URL]: COTTAGE_PAGE,
  [SCONES_URL]: SCONES_PAGE,
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
    this.rows.set(name, {
      normalized_name: name, display_name: name, status: 'categorized', default_category_id: categoryId, is_grocery_item: true, default_unit: null, attempts: 0,
      lang: null, same_as: null, linked_by: null,
    });
  }
  async getIngredients(names: readonly string[]) {
    return names.flatMap((n) => (this.rows.has(n) ? [{ ...this.rows.get(n)! }] : []));
  }
  async insertPending(rows: readonly { normalized_name: string; display_name: string }[]) {
    for (const r of rows) {
      if (!this.rows.has(r.normalized_name)) {
        this.rows.set(r.normalized_name, {
          normalized_name: r.normalized_name, display_name: r.display_name, status: 'pending', default_category_id: null, is_grocery_item: null, default_unit: null, attempts: 0,
          lang: null, same_as: null, linked_by: null,
        });
      }
    }
  }
  /** The recipe mock's names have no translations, so no twins or links are made. */
  async insertTwins() {}
  async getLinkTargets() {
    return [];
  }
  async link() {
    return false;
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
  // The mock never tags, and the page gives no time, steps or photo.
  tags: { meal: [], cuisine: [], protein: [], diet: [], method: [] },
  totalMinutes: null,
  steps: [],
  stepIngredients: null,
  imageUrl: null,
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
    steps: [],
    stepIngredients: null,
    imageUrl: null,
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

test('saved never comes from the model: a saved facet in its answer is neither returned nor cached', async () => {
  const { post, store } = setup({ model: editedModel((a) => ({ ...a, tags: { ...TAGS, saved: ['favorite', 'want-to-try'] } })) });
  const res = await post({ url: PASTA_URL });
  assertEquals(res.status, 200);
  const body: RecipeImportResponse = await res.json();
  assertEquals(body.tags, TAGS);
  assertEquals('saved' in body.tags!, false);
  assertEquals('saved' in store.saves[0].result.tags, false);
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

test('v5: the cache key is the v5 prompt version; cached v1 to v4 results are not served', async () => {
  assertEquals(EXTRACT_RECIPE_PROMPT_VERSION, 'extract-recipe.v5');
  const { post, store, calls } = setup({ model: editedModel((a) => ({ ...a, tags: TAGS })) });
  const old = { is_recipe: true, name: 'Old Pasta', servings: 2, ingredients: [{ name: 'garlic', quantity: 1, unit: null, note: '' }] };
  store.cache.set(`${PASTA_KEY}|extract-recipe.v1`, { result: old, is_recipe: true, created_at: new Date(NOW).toISOString() });
  store.cache.set(`${PASTA_KEY}|extract-recipe.v2`, {
    result: { ...old, tags: TAGS, total_minutes: 20 },
    is_recipe: true,
    created_at: new Date(NOW).toISOString(),
  });
  store.cache.set(`${PASTA_KEY}|extract-recipe.v3`, {
    result: { ...old, tags: TAGS, total_minutes: 20, steps: ['Boil.'], image_url: null },
    is_recipe: true,
    created_at: new Date(NOW).toISOString(),
  });
  store.cache.set(`${PASTA_KEY}|extract-recipe.v4`, {
    result: { ...old, tags: TAGS, total_minutes: 20, steps: ['Boil.'], step_ingredients: null, image_url: null },
    is_recipe: true,
    created_at: new Date(NOW).toISOString(),
  });
  const body: RecipeImportResponse = await (await post({ url: PASTA_URL })).json();
  assertEquals([body.name, body.tags], ['Garlic Pasta', TAGS]);
  assertEquals(calls('extractRecipe'), 1);
  assertEquals(store.saves.map((s) => [s.urlKey, s.promptVersion]), [[PASTA_KEY, 'extract-recipe.v5']]);

  // A cached v5 result is served with its tags and time, with no call.
  const again: RecipeImportResponse = await (await post({ url: PASTA_URL })).json();
  assertEquals(again.tags, TAGS);
  assertEquals(calls('extractRecipe'), 1);
});

test('v4: a v3-shaped row under the v4 key (no step_ingredients) fails the schema and is a miss', async () => {
  const { post, store, calls } = setup();
  const v3Shaped = {
    is_recipe: true,
    name: 'Old Pasta',
    servings: 2,
    ingredients: [{ name: 'garlic', quantity: 1, unit: null, note: '' }],
    tags: TAGS,
    total_minutes: 20,
    steps: [],
    image_url: null,
  };
  store.cache.set(`${PASTA_KEY}|${EXTRACT_RECIPE_PROMPT_VERSION}`, { result: v3Shaped, is_recipe: true, created_at: new Date(NOW).toISOString() });
  assertEquals(await (await post({ url: PASTA_URL })).json(), PASTA_RESPONSE);
  assertEquals(calls('extractRecipe'), 1);
});

// --- Steps and photo (prompt v3) ----------------------------------------------------------------------

test('v3: JSON-LD’s steps and image win over the model’s steps and the og:image', async () => {
  const { post, aiCalls, store } = setup({ model: editedModel((a) => ({ ...a, steps: ['Model step one.', 'Model step two.'] })) });
  const body: RecipeImportResponse = await (await post({ url: STEW_URL })).json();
  assertEquals(body.steps, STEW_STEPS);
  assertEquals(body.imageUrl, 'https://www.example.com/img/stew-jsonld.jpg', 'resolved against the page it came from');
  const prompt = aiCalls.find((c) => c.task === 'extractRecipe')!.prompt;
  // v4: the JSON-LD steps go to the model too, numbered, to match.
  assertStringIncludes(prompt, '"ingredient_lines":["2 lb beef chuck","3 carrots"],"steps":[{"step":1,"text":"Brown the beef."}');
  // The cached result carries both, and a cache hit serves them.
  assertEquals([store.saves[0].result.steps, store.saves[0].result.image_url], [STEW_STEPS, 'https://www.example.com/img/stew-jsonld.jpg']);
  const again: RecipeImportResponse = await (await post({ url: 'https://example.com/beef-stew' })).json();
  assertEquals([again.steps, again.imageUrl], [STEW_STEPS, 'https://www.example.com/img/stew-jsonld.jpg']);
  assertEquals(store.saves.map((s) => s.urlKey), [STEW_KEY]);
});

test('v3: JSON-LD without steps gives none, even if the model answers some', async () => {
  const { post } = setup({ model: editedModel((a) => ({ ...a, steps: ['Made up.'] })) });
  const body: RecipeImportResponse = await (await post({ url: PASTA_URL })).json();
  assertEquals([body.steps, body.imageUrl], [[], null]);
});

test('v3: without JSON-LD the model’s steps are used, cleaned and in order', async () => {
  const { post, aiCalls, store } = setup({
    model: editedModel((a) => ({ ...a, steps: ['1. Slice the leeks.', ' ', 'Step 2: Simmer in the  stock.'] })),
  });
  const body: RecipeImportResponse = await (await post({ url: SOUP_URL })).json();
  assertEquals(body.steps, ['Slice the leeks.', 'Simmer in the stock.']);
  assertStringIncludes(aiCalls[0].prompt, 'Slice the leeks.', 'the page text with the method goes to the model');
  assertEquals(store.saves[0].result.steps, ['Slice the leeks.', 'Simmer in the stock.']);
  // The mock gives none.
  assertEquals(((await (await setup().post({ url: SOUP_URL })).json()) as RecipeImportResponse).steps, []);
});

test('v3: the page’s og:image (else twitter:image) is the photo when JSON-LD has none', async () => {
  const { post } = setup();
  const tart: RecipeImportResponse = await (await post({ url: TART_URL })).json();
  assertEquals(tart.imageUrl, 'https://example.com/img/tart.jpg', 'a relative og:image resolves against the page');
  const soup: RecipeImportResponse = await (await post({ url: SOUP_URL })).json();
  assertEquals(soup.imageUrl, 'https://cdn.example.org/soup.jpg');
});

test('v3: an image URL that isn’t usable https is null', async () => {
  const { post } = setup();
  assertEquals(((await (await post({ url: BAD_IMAGE_URL })).json()) as RecipeImportResponse).imageUrl, null);
  // A bad JSON-LD image falls back to a good og:image, and to null without one.
  const httpJsonLd = JSON.stringify({ ...JSON.parse(STEW_JSON_LD), image: 'http://cdn.example.com/stew.jpg' });
  const withOg: RecipeImportResponse = await (
    await post({ url: STEW_URL, page: { jsonLd: [httpJsonLd], imageUrl: 'https://cdn.example.com/stew-og.jpg' } })
  ).json();
  assertEquals(withOg.imageUrl, 'https://cdn.example.com/stew-og.jpg');
  const without: RecipeImportResponse = await (await post({ url: STEW_URL, page: { jsonLd: [httpJsonLd] } })).json();
  assertEquals(without.imageUrl, null);
});

test('v3: a client-supplied page’s imageUrl is cleaned like a fetched one', async () => {
  const { post, fetched } = setup();
  const page = (imageUrl: unknown) => ({ title: 'Leek Soup', text: '2 leeks\n1 cup stock', imageUrl });
  const image = async (imageUrl: unknown) => ((await (await post({ url: SOUP_URL, page: page(imageUrl) })).json()) as RecipeImportResponse).imageUrl;
  assertEquals(await image(' /img/soup.jpg?w=1&amp;h=2 '), 'https://bakes.example.org/img/soup.jpg?w=1&h=2');
  assertEquals(await image('https://cdn.example.org/soup.jpg'), 'https://cdn.example.org/soup.jpg');
  assertEquals(await image('http://cdn.example.org/soup.jpg'), null);
  assertEquals(await image('javascript:alert(1)'), null);
  assertEquals(await image(''), null);
  // Not a string, or too long: left out by the request schema, and the import still succeeds.
  assertEquals(await image(42), null);
  assertEquals(await image(`https://cdn.example.org/${'a'.repeat(2048)}`), null);
  assertEquals(fetched, []);
});

// --- The photo chain (spec 6.6 step 5) -------------------------------------------------------------

test('photo chain: the cottage cheese blueberry bread page gets its photo when the server fetches it', async () => {
  const { post, store } = setup();
  const body: RecipeImportResponse = await (await post({ url: COTTAGE_URL })).json();
  assertEquals(body.imageUrl, COTTAGE_PHOTO);
  assertEquals(store.saves[0].result.image_url, COTTAGE_PHOTO, 'cached with the extraction');
});

test('photo chain: a Safari-shared page with no imageUrl gets its photo from the JSON-LD @graph (the lost photo)', async () => {
  // Before: Preprocess.js sent no imageUrl, and with no Recipe in the @graph the photo was null.
  const { post, fetched } = setup();
  const shared = readPage(COTTAGE_PAGE, COTTAGE_URL);
  const page = { title: shared.title!, jsonLd: shared.jsonLd, text: shared.text };
  const body: RecipeImportResponse = await (await post({ url: COTTAGE_URL, page })).json();
  assertEquals(body.imageUrl, COTTAGE_PHOTO);
  assertEquals(fetched, [], 'the shared page is used, not fetched');
});

test('photo chain: a client page’s JSON-LD photos come before its imageUrl, which fills in when they have none', async () => {
  const { post } = setup();
  const graph = JSON.stringify({
    '@graph': [
      { '@type': 'WebPage', primaryImageOfPage: { '@id': '#primary' } },
      { '@type': 'ImageObject', '@id': '#primary', url: '/uploads/primary.jpg' },
    ],
  });
  const image = async (page: Record<string, unknown>) =>
    ((await (await post({ url: SOUP_URL, page: { title: 'Leek Soup', text: '2 leeks\n1 cup stock', ...page } })).json()) as RecipeImportResponse).imageUrl;
  assertEquals(await image({ jsonLd: [graph], imageUrl: 'https://cdn.example.org/og.jpg' }), 'https://bakes.example.org/uploads/primary.jpg');
  assertEquals(await image({ jsonLd: ['{"@type":"WebSite"}'], imageUrl: 'https://cdn.example.org/og.jpg' }), 'https://cdn.example.org/og.jpg');
  assertEquals(await image({ jsonLd: ['{"@type":"WebSite"}'] }), null);
});

test('photo chain: a fetched page with only a lazy-loaded content image gets that, not the logo or avatar', async () => {
  const { post } = setup();
  const body: RecipeImportResponse = await (await post({ url: SCONES_URL })).json();
  assertEquals(body.imageUrl, 'https://bakes.example.org/img/scones.jpg');
});

test('photo chain: the JSON-LD Recipe’s @id image wins over the og:image', async () => {
  const { post } = setup();
  const graph = JSON.stringify({
    '@graph': [
      { '@type': 'ImageObject', '@id': '#hero', url: 'https://cdn.example.com/stew-hero.jpg' },
      { ...JSON.parse(STEW_JSON_LD), image: { '@id': '#hero' } },
    ],
  });
  const body: RecipeImportResponse = await (
    await post({ url: STEW_URL, page: { jsonLd: [graph], imageUrl: 'https://cdn.example.com/stew-og.jpg' } })
  ).json();
  assertEquals(body.imageUrl, 'https://cdn.example.com/stew-hero.jpg');
});

test('v3: not a recipe has no steps or photo', async () => {
  const { post, store } = setup({ model: editedModel((a) => ({ ...a, steps: ['Read the news.'] })) });
  await expectError(await post({ url: NEWS_URL }), 422, 'not_a_recipe');
  assertEquals(store.saves.map((s) => [s.result.is_recipe, s.result.steps, s.result.image_url]), [[false, [], null]]);
});

// --- Step match (prompt v4) ----------------------------------------------------------------------------

const uses = (n: number, ...pairs: [number, number | null][]) => ({ step: n, uses: pairs.map(([ingredient, quantity]) => ({ ingredient, quantity })) });

test('v4: JSON-LD steps go to the model and are kept; its match maps to the response’s ingredients', async () => {
  const { post, aiCalls, store, calls } = setup({
    model: editedModel((a) => ({ ...a, steps: ['Rewritten by the model.'], step_ingredients: [uses(1, [1, null]), uses(2, [2, 1], [1, null])] })),
  });
  const body: RecipeImportResponse = await (await post({ url: STEW_URL })).json();
  assertEquals(body.steps, STEW_STEPS, 'the JSON-LD steps, not the model’s');
  assertEquals(body.ingredients.map((i) => i.displayName), ['beef chuck', 'carrots']);
  assertEquals(body.stepIngredients, [[{ index: 0, quantity: null }], [{ index: 0, quantity: null }, { index: 1, quantity: 1 }]]);
  const page = JSON.parse(aiCalls[0].prompt.slice(aiCalls[0].prompt.indexOf('\n') + 1));
  // v5: the heading goes between them, unnumbered.
  assertEquals(page.steps, [
    { step: 1, text: 'Brown the beef.' },
    '## Simmer',
    { step: 2, text: 'Add the carrots & simmer for 2 hours.' },
  ]);
  // Cached with the extraction, and served from the cache.
  assertEquals(store.saves[0].result.step_ingredients, [[{ ingredient: 0, quantity: null }], [{ ingredient: 0, quantity: null }, { ingredient: 1, quantity: 1 }]]);
  const again: RecipeImportResponse = await (await post({ url: STEW_KEY })).json();
  assertEquals(again.stepIngredients, body.stepIngredients);
  assertEquals(calls('extractRecipe'), 1);
});

test('v4: the mock returns a match for the JSON-LD steps', async () => {
  const body: RecipeImportResponse = await (await setup().post({ url: STEW_URL })).json();
  // "carrots" is named in step 2; the mock matches "beef chuck" by "chuck", which no step says.
  assertEquals(body.stepIngredients, [[], [{ index: 1, quantity: null }]]);
});

test('v4: from page text the model’s own steps are matched', async () => {
  const { post } = setup({
    model: editedModel((a) => ({ ...a, steps: ['Slice the leeks.', 'Simmer in the stock.'], step_ingredients: [uses(1, [1, null]), uses(2, [2, null])] })),
  });
  const body: RecipeImportResponse = await (await post({ url: SOUP_URL })).json();
  assertEquals(body.steps, ['Slice the leeks.', 'Simmer in the stock.']);
  assertEquals(body.stepIngredients, [[{ index: 0, quantity: null }], [{ index: 1, quantity: null }]]);
});

test('v4: a bad match is dropped and the import still succeeds', async () => {
  for (const [what, bad] of [
    ['one step short', [uses(1, [1, null])]],
    ['a step numbered twice', [uses(1), uses(1)]],
    ['a step out of range', [uses(1), uses(5)]],
    ['not a list', 'garbage'],
    ['a step that isn’t an object', [7, 8]],
  ] as const) {
    const { post, store } = setup({ model: editedModel((a) => ({ ...a, step_ingredients: bad })) });
    const res = await post({ url: STEW_URL });
    assertEquals(res.status, 200, what);
    const body: RecipeImportResponse = await res.json();
    assertEquals([body.stepIngredients, body.steps, body.ingredients.length], [null, STEW_STEPS, 2], what);
    assertEquals(store.saves[0].result.step_ingredients, null, what);
  }
});

test('v4: no steps, no match', async () => {
  const body: RecipeImportResponse = await (await setup({ model: editedModel((a) => ({ ...a, step_ingredients: [uses(1, [1, null])] })) }).post({ url: PASTA_URL })).json();
  assertEquals([body.steps, body.stepIngredients], [[], null]);
});

test('v4: a cached match that no longer lines up with its steps or ingredients is sent as none', async () => {
  const { post, store, calls } = setup();
  const cached = {
    is_recipe: true,
    name: 'Stew',
    servings: null,
    ingredients: [{ name: 'beef', quantity: 2, unit: 'lb', note: '' }],
    tags: TAGS,
    total_minutes: null,
    steps: ['Brown.', 'Simmer.'],
    image_url: null,
  };
  store.cache.set(`${STEW_KEY}|${EXTRACT_RECIPE_PROMPT_VERSION}`, { result: { ...cached, step_ingredients: [[{ ingredient: 3, quantity: null }], []] }, is_recipe: true, created_at: new Date(NOW).toISOString() });
  assertEquals(((await (await post({ url: STEW_URL })).json()) as RecipeImportResponse).stepIngredients, null);
  store.cache.set(`${STEW_KEY}|${EXTRACT_RECIPE_PROMPT_VERSION}`, { result: { ...cached, step_ingredients: [[]] }, is_recipe: true, created_at: new Date(NOW).toISOString() });
  assertEquals(((await (await post({ url: STEW_URL })).json()) as RecipeImportResponse).stepIngredients, null);
  assertEquals(calls('extractRecipe'), 0, 'both served from the cache');
});

// --- Sections (prompt v5) ----------------------------------------------------------------------------

const MARINADE_URL = 'https://familystylefood.com/chicken-thigh-marinade/';

/** The saved familystylefood.com page, as a client-sent page (never cached, nothing fetched). */
async function marinadePage() {
  const html = await Deno.readTextFile(new URL('./eval/fixtures/jsonld-familystylefood-chicken-thigh-marinade.html', import.meta.url));
  const read = readPage(html, MARINADE_URL);
  return { url: MARINADE_URL, page: { jsonLd: read.jsonLd } };
}

/** The response's headings, `*` before a choice. */
const headings = (steps: RecipeImportResponse['steps']) =>
  steps.flatMap((e) => (typeof e === 'string' ? [] : [`${e.choice ? '*' : ''}${e.section}`]));

test('v5: the marinade’s JSON-LD sections go to the model as ## lines, and choice_sections [2,3,4,5] marks those four only', async () => {
  const { post, aiCalls } = setup({ model: editedModel((a) => ({ ...a, choice_sections: [2, 3, 4, 5] })) });
  const body: RecipeImportResponse = await (await post(await marinadePage())).json();
  assertEquals(headings(body.steps), ['Marinate the chicken', '*Grilling', '*Baking', '*Pan-Frying', '*Broiling']);
  assertEquals(body.steps.length, 15, '10 steps and 5 headings');
  assertEquals(body.steps[0], { section: 'Marinate the chicken' }, 'no choice key on a plain heading');
  // The model saw the headings unnumbered between the steps, numbered over the steps only.
  const page = JSON.parse(aiCalls[0].prompt.slice(aiCalls[0].prompt.indexOf('\n') + 1));
  assertEquals(page.steps.filter((s: unknown) => typeof s === 'string'), ['## Marinate the chicken', '## Grilling', '## Baking', '## Pan-Frying', '## Broiling']);
  assertEquals(page.steps.filter((s: unknown) => typeof s !== 'string').map((s: { step: number }) => s.step), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // The step match lines up with the 10 steps, headings left out.
  assertEquals(body.stepIngredients?.length, 10);
});

test('v5: choice_sections that name one heading, or none that exist, mark nothing', async () => {
  for (const choices of [[1], [9], [1, 9], [0, 6], [2, 2], [2.5, 3], []]) {
    const { post } = setup({ model: editedModel((a) => ({ ...a, choice_sections: choices })) });
    const body: RecipeImportResponse = await (await post(await marinadePage())).json();
    assertEquals(headings(body.steps), ['Marinate the chicken', 'Grilling', 'Baking', 'Pan-Frying', 'Broiling'], JSON.stringify(choices));
  }
});

test('v5: a malformed or missing choice_sections costs only the choice', async () => {
  for (const edit of [(a: object) => ({ ...a, choice_sections: 'all' }), (a: object) => ({ ...a, choice_sections: undefined })]) {
    const { post } = setup({ model: editedModel(edit) });
    const res = await post(await marinadePage());
    assertEquals(res.status, 200);
    const body: RecipeImportResponse = await res.json();
    assertEquals(headings(body.steps), ['Marinate the chicken', 'Grilling', 'Baking', 'Pan-Frying', 'Broiling']);
    assertEquals(body.ingredients.length > 0, true);
  }
});

test('v5: from page text, ## lines in the model’s steps become headings, and its match counts the steps only', async () => {
  const { post } = setup({
    model: editedModel((a) => ({
      ...a,
      steps: ['## Prep', 'Slice the leeks.', '## On the stove', 'Simmer in the stock.', '## In the oven', 'Bake in the stock.'],
      step_ingredients: [uses(1, [1, null]), uses(2, [2, null]), uses(3, [2, null])],
      choice_sections: [2, 3],
    })),
  });
  const body: RecipeImportResponse = await (await post({ url: SOUP_URL })).json();
  assertEquals(body.steps, [
    { section: 'Prep' },
    'Slice the leeks.',
    { section: 'On the stove', choice: true },
    'Simmer in the stock.',
    { section: 'In the oven', choice: true },
    'Bake in the stock.',
  ]);
  assertEquals(body.stepIngredients, [[{ index: 0, quantity: null }], [{ index: 1, quantity: null }], [{ index: 1, quantity: null }]]);
});

test('v5: an empty ## line or a heading with no steps after it is dropped, and the match still lines up', async () => {
  const { post } = setup({
    model: editedModel((a) => ({ ...a, steps: ['## ', 'Slice the leeks.', 'Simmer in the stock.', '## Serving'], step_ingredients: [uses(1, [1, null]), uses(2, [2, null])] })),
  });
  const body: RecipeImportResponse = await (await post({ url: SOUP_URL })).json();
  assertEquals(body.steps, ['Slice the leeks.', 'Simmer in the stock.']);
  assertEquals(body.stepIngredients?.length, 2);
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
