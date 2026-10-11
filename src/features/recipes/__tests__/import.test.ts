import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { and, asc, eq, isNull } from 'drizzle-orm';

import {
  db,
  households,
  ingredients,
  ingredientUsage,
  listItemContributions,
  listItems,
  outbox,
  recipeIngredients,
  recipes,
} from '@/db';
import { loadCatalogSeed } from '@/features/categories/categories';
import { addItem, groupItems, listItemsQuery, setItemChecked } from '@/features/lists/items';
import { ensureStarterData, getDefaultListId } from '@/features/lists/lists';
import { normalizeIngredientName, OTHER_CATEGORY_ID, SYSTEM_CATEGORIES } from '@/shared';
import type { RecipeImportResponse } from '@/shared/schemas/recipe-import';
import { resetDb } from '@/test/db';
import { makeSession, resetSupabase, setSupabaseConfigured, supabase } from '@/test/fake-supabase';

import { IMPORT_ID_NAMESPACE, importRecipe, recipeIdForImport, type ImportRecipeSuccess } from '../import';
import { setPageCapturer, type CapturedPage, type CaptureResult, type PageCapturer } from '../page-capture';
import { addRecipeIngredient, createRecipe, updateRecipe } from '../recipes';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));

const USER = 'user-1';
const URL_ = 'https://www.example.com/tikka/?utm_source=pin#recipe';
const CANONICAL = 'https://example.com/tikka';
const invoke = supabase.functions.invoke;
const category = (slug: string) => SYSTEM_CATEGORIES.find((c) => c.slug === slug)!.id;

type Ingredient = RecipeImportResponse['ingredients'][number];
const ingredient = (
  displayName: string,
  quantity: number | null,
  unit: Ingredient['unit'],
  note: string,
  categoryId: string | null,
  status: Ingredient['status'] = 'categorized',
): Ingredient => ({
  ingredientName: normalizeIngredientName(displayName),
  displayName,
  quantity,
  unit,
  note,
  categoryId,
  status,
});

const TIKKA: RecipeImportResponse = {
  name: 'Chicken tikka masala',
  sourceUrl: CANONICAL,
  servings: 4,
  ingredients: [
    ingredient('chicken thighs', 2, 'lb', 'boneless', category('meat-seafood')),
    ingredient('garlic', 4, 'clove', 'minced', category('produce')),
    ingredient('kasuri methi', 1, 'tbsp', '', category('spices')),
    ingredient('zqx tikka paste', null, null, 'to taste', null, 'failed'),
  ],
};

let listId: string;
let warn: ReturnType<typeof jest.spyOn>;

function respond(data: unknown = TIKKA) {
  invoke.mockResolvedValue({ data, error: null });
}

/** What `functions.invoke` gives for a non-2xx answer: a FunctionsHttpError with the Response. */
function respondWithError(status: number, body: unknown) {
  invoke.mockResolvedValue({
    data: null,
    error: {
      name: 'FunctionsHttpError',
      message: 'Edge Function returned a non-2xx status code',
      context: {
        status,
        json: () => (typeof body === 'string' ? Promise.reject(new SyntaxError(body)) : Promise.resolve(body)),
      },
    },
  });
}

const signIn = () => supabase.auth.getSession.mockResolvedValue({ data: { session: makeSession(USER) }, error: null });

async function importOk(input: Partial<Parameters<typeof importRecipe>[0]> = {}): Promise<ImportRecipeSuccess> {
  const result = await importRecipe({ url: URL_, listId, ...input });
  if (!result.ok) throw new Error(`import failed: ${JSON.stringify(result)}`);
  return result;
}

const liveRecipes = () =>
  db
    .select({ id: recipes.id, name: recipes.name, sourceUrl: recipes.sourceUrl, notes: recipes.notes })
    .from(recipes)
    .where(isNull(recipes.deletedAt))
    .orderBy(asc(recipes.name))
    .all();

const ingredientRows = (recipeId: string) =>
  db
    .select({
      ingredientName: recipeIngredients.ingredientName,
      displayName: recipeIngredients.displayName,
      quantity: recipeIngredients.quantity,
      unit: recipeIngredients.unit,
      note: recipeIngredients.note,
    })
    .from(recipeIngredients)
    .where(and(eq(recipeIngredients.recipeId, recipeId), isNull(recipeIngredients.deletedAt)))
    .orderBy(asc(recipeIngredients.position))
    .all();

const rows = () =>
  groupItems(listItemsQuery(listId, USER).all()).unchecked.map((i) =>
    i.amountText ? `${i.amountText} ${i.displayName}` : i.displayName,
  );

const itemFor = (name: string) =>
  db
    .select()
    .from(listItems)
    .where(and(eq(listItems.listId, listId), eq(listItems.ingredientName, name), isNull(listItems.deletedAt)))
    .get();

const contributionsFor = (itemId: string) =>
  db
    .select({
      source: listItemContributions.source,
      recipeId: listItemContributions.recipeId,
      quantity: listItemContributions.quantity,
      unit: listItemContributions.unit,
    })
    .from(listItemContributions)
    .where(and(eq(listItemContributions.listItemId, itemId), isNull(listItemContributions.deletedAt)))
    .orderBy(asc(listItemContributions.createdAt))
    .all();

const useCount = (name: string) =>
  db.select().from(ingredientUsage).where(eq(ingredientUsage.ingredientName, name)).get()?.useCount ?? 0;

/** Every table an import writes, so a failed one can be shown to write nothing. */
const snapshot = () => ({
  recipes: db.select().from(recipes).all(),
  recipeIngredients: db.select().from(recipeIngredients).all(),
  listItems: db.select().from(listItems).all(),
  contributions: db.select().from(listItemContributions).all(),
  usage: db.select().from(ingredientUsage).all(),
  ingredients: db.select().from(ingredients).all(),
  outbox: db.select().from(outbox).all(),
});

beforeEach(() => {
  resetDb();
  resetSupabase();
  loadCatalogSeed();
  ensureStarterData(USER);
  listId = getDefaultListId(USER)!;
  signIn();
  respond();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  setPageCapturer(null);
});

describe('a new recipe', () => {
  test('creates the recipe with its ingredients in page order', async () => {
    const result = await importOk();
    expect(liveRecipes()).toEqual([
      { id: result.recipeId, name: 'Chicken tikka masala', sourceUrl: CANONICAL, notes: 'Serves 4' },
    ]);
    expect(ingredientRows(result.recipeId)).toEqual([
      { ingredientName: 'chicken thigh', displayName: 'chicken thighs', quantity: 2, unit: 'lb', note: 'boneless' },
      { ingredientName: 'garlic', displayName: 'garlic', quantity: 4, unit: 'clove', note: 'minced' },
      { ingredientName: 'kasuri methi', displayName: 'kasuri methi', quantity: 1, unit: 'tbsp', note: null },
      { ingredientName: 'zqx tikka paste', displayName: 'zqx tikka paste', quantity: null, unit: null, note: 'to taste' },
    ]);
  });

  test('puts every ingredient on the list as the recipe’s contribution', async () => {
    const result = await importOk();
    expect(result).toMatchObject({
      ok: true,
      recipeName: 'Chicken tikka masala',
      listId,
      added: 4,
      combined: 0,
    });
    expect(rows()).toEqual(['2 lb chicken thighs', '4 clove garlic', '1 tbsp kasuri methi', 'zqx tikka paste']);
    for (const i of TIKKA.ingredients) {
      expect(contributionsFor(itemFor(i.ingredientName)!.id)).toEqual([
        { source: 'recipe', recipeId: result.recipeId, quantity: i.quantity, unit: i.unit },
      ]);
    }
    expect(itemFor('chicken thigh')).toMatchObject({ addedBy: USER, checkedAt: null });
  });

  test('sends the URL, and the page when there is one', async () => {
    await importOk();
    expect(invoke).toHaveBeenCalledWith('import-recipe', { body: { url: URL_ } });
    const page = { title: 'Tikka', jsonLd: ['{"@type":"Recipe"}'], text: 'Chicken tikka masala' };
    await importOk({ page });
    expect(invoke).toHaveBeenLastCalledWith('import-recipe', { body: { url: URL_, page } });
  });

  test('no servings leaves notes empty; no name uses the host', async () => {
    respond({ ...TIKKA, name: '  ', servings: null });
    const result = await importOk();
    expect(result.recipeName).toBe('example.com');
    expect(liveRecipes()).toEqual([{ id: result.recipeId, name: 'example.com', sourceUrl: CANONICAL, notes: null }]);
  });

  test('saves in one top-level transaction, and undoes in one', async () => {
    // expo-sqlite can't nest `db.transaction` (it would BEGIN twice); the rest must go through `tx`.
    const transaction = jest.spyOn(db, 'transaction');
    const result = await importOk();
    expect(transaction).toHaveBeenCalledTimes(1);
    result.undo();
    expect(transaction).toHaveBeenCalledTimes(2);
    transaction.mockRestore();
  });

  test('counts one household use per ingredient, as a recipe add does', async () => {
    await importOk();
    expect(useCount('chicken thigh')).toBe(1);
    expect(useCount('garlic')).toBe(1);
    expect(useCount('zqx tikka paste')).toBe(1);
  });

  test('the same ingredient twice folds into one item with both amounts', async () => {
    respond({
      ...TIKKA,
      ingredients: [ingredient('butter', 2, 'tbsp', '', category('dairy-eggs')), ingredient('butter', 1, 'tbsp', '', category('dairy-eggs'))],
    });
    const result = await importOk();
    expect(result.added).toBe(2);
    expect(result.combined).toBe(1);
    expect(rows()).toEqual(['3 tbsp butter']);
    expect(ingredientRows(result.recipeId)).toHaveLength(2);
  });
});

describe('an existing recipe with the same URL', () => {
  let existing: string;

  beforeEach(() => {
    existing = createRecipe('Mum’s tikka');
    updateRecipe(existing, { name: 'Mum’s tikka', notes: '', sourceUrl: 'https://example.com/tikka/' });
    addRecipeIngredient(existing, '1 lb chicken thighs');
  });

  test('creates no recipe and leaves it as it is; only the list adds', async () => {
    const result = await importOk();
    expect(result.recipeId).toBe(existing);
    expect(result.recipeName).toBe('Mum’s tikka');
    expect(liveRecipes()).toEqual([
      { id: existing, name: 'Mum’s tikka', sourceUrl: 'https://example.com/tikka/', notes: null },
    ]);
    expect(ingredientRows(existing)).toEqual([
      { ingredientName: 'chicken thigh', displayName: 'chicken thighs', quantity: 1, unit: 'lb', note: null },
    ]);
    expect(rows()).toEqual(['2 lb chicken thighs', '4 clove garlic', '1 tbsp kasuri methi', 'zqx tikka paste']);
    expect(contributionsFor(itemFor('garlic')!.id)).toEqual([
      { source: 'recipe', recipeId: existing, quantity: 4, unit: 'clove' },
    ]);
  });

  test('a recipe in another household doesn’t count', async () => {
    // Move the existing recipe out of the list's household.
    db.insert(households).values({ id: 'household-2', name: 'Other' }).run();
    db.update(recipes).set({ householdId: 'household-2' }).where(eq(recipes.id, existing)).run();
    db.update(recipeIngredients).set({ householdId: 'household-2' }).where(eq(recipeIngredients.recipeId, existing)).run();
    const result = await importOk();
    expect(result.recipeId).not.toBe(existing);
    expect(liveRecipes().map((r) => r.name)).toEqual(['Chicken tikka masala', 'Mum’s tikka']);
  });

  test('a deleted recipe with the same URL doesn’t count', async () => {
    db.update(recipes).set({ deletedAt: new Date() }).where(eq(recipes.id, existing)).run();
    const result = await importOk();
    expect(result.recipeId).not.toBe(existing);
    expect(liveRecipes().map((r) => r.name)).toEqual(['Chicken tikka masala']);
  });
});

describe('duplicates on the list (spec 4.4)', () => {
  test('an unchecked item Combines', async () => {
    addItem(listId, '1 lb chicken thighs', USER);
    const before = itemFor('chicken thigh')!;
    const result = await importOk();
    expect(result.added).toBe(4);
    expect(result.combined).toBe(1);
    expect(itemFor('chicken thigh')!.id).toBe(before.id);
    expect(rows()).toEqual(['3 lb chicken thighs', '4 clove garlic', '1 tbsp kasuri methi', 'zqx tikka paste']);
    expect(contributionsFor(before.id)).toEqual([
      { source: 'manual', recipeId: null, quantity: 1, unit: 'lb' },
      { source: 'recipe', recipeId: result.recipeId, quantity: 2, unit: 'lb' },
    ]);
  });

  test('a checked item is unchecked and its amounts replaced', async () => {
    addItem(listId, '10 cloves garlic', USER);
    const garlic = itemFor('garlic')!;
    setItemChecked(garlic.id, true, USER);
    const result = await importOk();
    expect(result.combined).toBe(0);
    expect(itemFor('garlic')).toMatchObject({ id: garlic.id, checkedAt: null, checkedBy: null });
    expect(contributionsFor(garlic.id)).toEqual([{ source: 'recipe', recipeId: result.recipeId, quantity: 4, unit: 'clove' }]);
    expect(groupItems(listItemsQuery(listId, USER).all()).checked).toEqual([]);
  });
});

describe('categories', () => {
  const catalog = (name: string) =>
    db
      .select({ status: ingredients.status, categoryId: ingredients.defaultCategoryId })
      .from(ingredients)
      .where(eq(ingredients.normalizedName, name))
      .get();

  test('land locally, so nothing is pending', async () => {
    expect(catalog('kasuri methi')).toBeUndefined();
    expect(catalog('zqx tikka paste')).toBeUndefined();
    await importOk();
    expect(catalog('kasuri methi')).toEqual({ status: 'categorized', categoryId: category('spices') });
    // A name categorizing failed for goes to Other, for catch-up to retry.
    expect(catalog('zqx tikka paste')).toEqual({ status: 'failed', categoryId: OTHER_CATEGORY_ID });
    expect(db.select().from(ingredients).where(eq(ingredients.status, 'pending')).all()).toEqual([]);
    // Only the import call: no separate categorize request.
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test('a known ingredient keeps its catalog category', async () => {
    const garlicBefore = catalog('garlic');
    expect(garlicBefore?.status).toBe('categorized');
    respond({ ...TIKKA, ingredients: [{ ...TIKKA.ingredients[1], categoryId: category('spices') }] });
    await importOk();
    expect(catalog('garlic')).toEqual(garlicBefore);
  });

  test('a name the server left pending stays pending', async () => {
    respond({ ...TIKKA, ingredients: [ingredient('zqx saffron dust', 1, 'pinch', '', null, 'pending')] });
    await importOk();
    expect(catalog('zqx saffron dust')).toEqual({ status: 'pending', categoryId: null });
  });
});

describe('import ids', () => {
  test('the recipe id is the UUIDv5 of the import id', async () => {
    const result = await importOk({ importId: 'envelope-1' });
    expect(result.recipeId).toBe(recipeIdForImport('envelope-1'));
    expect(recipeIdForImport('envelope-1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(recipeIdForImport('envelope-1')).toBe(recipeIdForImport('envelope-1'));
    expect(recipeIdForImport('envelope-2')).not.toBe(recipeIdForImport('envelope-1'));
    expect(IMPORT_ID_NAMESPACE).toBe('6f3b2a91-4c7e-4d1a-9b8e-2a5c7d0e4f13');
  });

  test('the same import id twice → one recipe', async () => {
    await importOk({ importId: 'envelope-1' });
    // Even if the server's canonical URL changed in between, the id finds the first run's recipe.
    respond({ ...TIKKA, sourceUrl: 'https://example.com/tikka-v2' });
    const second = await importOk({ importId: 'envelope-1' });
    expect(second.recipeId).toBe(recipeIdForImport('envelope-1'));
    expect(liveRecipes()).toHaveLength(1);
    expect(ingredientRows(second.recipeId)).toHaveLength(4);
    expect(second.combined).toBe(4);
  });

  test('a deleted recipe from the same import id gets a new id', async () => {
    const first = await importOk({ importId: 'envelope-1' });
    first.undo();
    const second = await importOk({ importId: 'envelope-1' });
    expect(second.recipeId).not.toBe(first.recipeId);
    expect(liveRecipes()).toEqual([
      { id: second.recipeId, name: 'Chicken tikka masala', sourceUrl: CANONICAL, notes: 'Serves 4' },
    ]);
  });
});

describe('undo', () => {
  test('restores the list and removes a new recipe', async () => {
    addItem(listId, '1 lb chicken thighs', USER);
    addItem(listId, '10 cloves garlic', USER);
    setItemChecked(itemFor('garlic')!.id, true, USER);
    const rowsBefore = rows();
    const usageBefore = [useCount('chicken thigh'), useCount('garlic'), useCount('kasuri methi')];

    const result = await importOk();
    result.undo();

    expect(rows()).toEqual(rowsBefore);
    expect(rowsBefore).toEqual(['1 lb chicken thighs']);
    const garlic = itemFor('garlic')!;
    expect(garlic.checkedAt).not.toBeNull();
    expect(contributionsFor(garlic.id)).toEqual([{ source: 'manual', recipeId: null, quantity: 10, unit: 'clove' }]);
    expect(itemFor('kasuri methi')).toBeUndefined();
    expect(liveRecipes()).toEqual([]);
    expect(db.select().from(recipes).where(eq(recipes.id, result.recipeId)).get()?.deletedAt).not.toBeNull();
    expect([useCount('chicken thigh'), useCount('garlic'), useCount('kasuri methi')]).toEqual(usageBefore);
  });

  test('keeps an existing recipe', async () => {
    const existing = createRecipe('Tikka');
    updateRecipe(existing, { name: 'Tikka', notes: 'Family favourite', sourceUrl: CANONICAL });
    const result = await importOk();
    result.undo();
    expect(rows()).toEqual([]);
    expect(liveRecipes()).toEqual([{ id: existing, name: 'Tikka', sourceUrl: CANONICAL, notes: 'Family favourite' }]);
  });
});

describe('errors write nothing', () => {
  let before: ReturnType<typeof snapshot>;
  beforeEach(() => {
    before = snapshot();
  });
  afterEach(() => {
    expect(snapshot()).toEqual(before);
  });

  const run = () => importRecipe({ url: URL_, listId });

  test('not a recipe', async () => {
    respondWithError(422, { error: 'not_a_recipe', message: 'Not a recipe' });
    expect(await run()).toEqual({ ok: false, error: 'not_a_recipe' });
  });

  test('rate limited', async () => {
    respondWithError(429, { error: 'rate_limited', message: 'Slow down' });
    expect(await run()).toEqual({ ok: false, error: 'rate_limited' });
  });

  test('service unavailable reads as rate limited ("Try again in a minute")', async () => {
    respondWithError(503, { error: 'unavailable', message: 'Off' });
    expect(await run()).toEqual({ ok: false, error: 'rate_limited' });
  });

  test('the page couldn’t be fetched', async () => {
    respondWithError(502, { error: 'fetch_failed', message: 'Blocked' });
    expect(await run()).toEqual({ ok: false, error: 'failed', reason: 'fetch_failed' });
  });

  test('the server says the URL is invalid', async () => {
    respondWithError(400, { error: 'invalid_url', message: 'Private address' });
    expect(await run()).toEqual({ ok: false, error: 'failed', reason: 'invalid_url' });
  });

  test('a status with no JSON body falls back to the status', async () => {
    respondWithError(422, 'not json');
    expect(await run()).toEqual({ ok: false, error: 'not_a_recipe' });
    respondWithError(429, 'not json');
    expect(await run()).toEqual({ ok: false, error: 'rate_limited' });
    respondWithError(500, 'Internal Server Error');
    expect(await run()).toEqual({ ok: false, error: 'failed' });
  });

  test('a network failure is offline', async () => {
    invoke.mockResolvedValue({ data: null, error: { name: 'FunctionsFetchError', message: 'Failed to send a request' } });
    expect(await run()).toEqual({ ok: false, error: 'offline' });
  });

  test('invoke throwing is offline', async () => {
    invoke.mockRejectedValue(new TypeError('Network request failed'));
    expect(await run()).toEqual({ ok: false, error: 'offline' });
  });

  test('a response that doesn’t match the schema fails', async () => {
    respond({ name: 'Tikka', ingredients: 'lots' });
    expect(await run()).toEqual({ ok: false, error: 'failed' });
  });

  test('a list that doesn’t exist fails', async () => {
    expect(await importRecipe({ url: URL_, listId: 'no-such-list' })).toEqual({ ok: false, error: 'failed' });
  });

  test('a URL that isn’t http(s) fails without a call', async () => {
    expect(await importRecipe({ url: 'not a link', listId })).toEqual({ ok: false, error: 'failed', reason: 'invalid_url' });
    expect(await importRecipe({ url: 'ftp://example.com/tikka', listId })).toEqual({
      ok: false,
      error: 'failed',
      reason: 'invalid_url',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  test('no session → offline, with no call', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    expect(await run()).toEqual({ ok: false, error: 'offline' });
    expect(invoke).not.toHaveBeenCalled();
  });

  test('no config → offline, with no call', async () => {
    setSupabaseConfigured(false);
    expect(await run()).toEqual({ ok: false, error: 'offline' });
    expect(invoke).not.toHaveBeenCalled();
    expect(supabase.auth.getSession).not.toHaveBeenCalled();
  });
});

describe('device fallback for blocked sites', () => {
  const PAGE: CapturedPage = {
    title: 'Chicken Tikka Masala',
    jsonLd: ['{"@type":"Recipe","name":"Chicken Tikka Masala"}'],
    text: 'Chicken Tikka Masala\n2 lb chicken thighs',
  };
  const httpError = (status: number, error: string) => ({
    data: null,
    error: {
      name: 'FunctionsHttpError',
      message: 'Edge Function returned a non-2xx status code',
      context: { status, json: () => Promise.resolve({ error, message: error }) },
    },
  });
  const blocked = () => httpError(502, 'fetch_failed');
  let capture: jest.Mock<PageCapturer>;
  const captureWith = (result: CaptureResult) => {
    capture = jest.fn<PageCapturer>().mockResolvedValue(result);
    setPageCapturer(capture);
  };
  const bodies = () => invoke.mock.calls.map((c) => (c[1] as { body: unknown }).body);

  test('fetch_failed → capture → a second call with the page succeeds', async () => {
    captureWith({ ok: true, page: PAGE });
    invoke.mockResolvedValueOnce(blocked()).mockResolvedValueOnce({ data: TIKKA, error: null });

    const result = await importOk();

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(URL_);
    expect(bodies()).toEqual([{ url: URL_ }, { url: URL_, page: PAGE }]);
    expect(result.recipeName).toBe('Chicken tikka masala');
    expect(result.added).toBe(4);
    expect(liveRecipes()).toEqual([
      { id: result.recipeId, name: 'Chicken tikka masala', sourceUrl: CANONICAL, notes: 'Serves 4' },
    ]);
  });

  test('empty parts of the capture are left out of the page', async () => {
    captureWith({ ok: true, page: { title: '  ', jsonLd: [], text: 'Tikka: 2 lb chicken' } });
    invoke.mockResolvedValueOnce(blocked()).mockResolvedValueOnce({ data: TIKKA, error: null });
    await importOk();
    expect(bodies()[1]).toEqual({ url: URL_, page: { text: 'Tikka: 2 lb chicken' } });
  });

  test('the second call’s own error comes back, with nothing written', async () => {
    captureWith({ ok: true, page: PAGE });
    invoke.mockResolvedValueOnce(blocked()).mockResolvedValueOnce(httpError(422, 'not_a_recipe'));
    const before = snapshot();
    expect(await importRecipe({ url: URL_, listId })).toEqual({ ok: false, error: 'not_a_recipe' });
    expect(snapshot()).toEqual(before);
  });

  test('a capture timeout is blocked, writes nothing and makes no second call', async () => {
    captureWith({ ok: false, reason: 'timeout' });
    invoke.mockResolvedValue(blocked());
    const before = snapshot();
    expect(await importRecipe({ url: URL_, listId })).toEqual({ ok: false, error: 'blocked' });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(snapshot()).toEqual(before);
  });

  test('a page the device can’t load either keeps "couldn’t reach that site"', async () => {
    captureWith({ ok: false, reason: 'unreachable' });
    invoke.mockResolvedValue(blocked());
    expect(await importRecipe({ url: URL_, listId })).toEqual({ ok: false, error: 'failed', reason: 'fetch_failed' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test('a capturer that throws reads as unreachable', async () => {
    setPageCapturer(() => Promise.reject(new Error('WebView gone')));
    invoke.mockResolvedValue(blocked());
    expect(await importRecipe({ url: URL_, listId })).toEqual({ ok: false, error: 'failed', reason: 'fetch_failed' });
  });

  test('fetch_failed even with the captured page is blocked', async () => {
    captureWith({ ok: true, page: PAGE });
    invoke.mockResolvedValue(blocked());
    expect(await importRecipe({ url: URL_, listId })).toEqual({ ok: false, error: 'blocked' });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['not_a_recipe', 422, { ok: false, error: 'not_a_recipe' }],
    ['rate_limited', 429, { ok: false, error: 'rate_limited' }],
    ['unavailable', 503, { ok: false, error: 'rate_limited' }],
    ['invalid_url', 400, { ok: false, error: 'failed', reason: 'invalid_url' }],
  ])('%s never captures', async (code, status, expected) => {
    captureWith({ ok: true, page: PAGE });
    invoke.mockResolvedValue(httpError(status, code));
    expect(await importRecipe({ url: URL_, listId })).toEqual(expected);
    expect(capture).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test('an import that brought its own page doesn’t capture', async () => {
    captureWith({ ok: true, page: PAGE });
    invoke.mockResolvedValue(blocked());
    const page = { title: 'Tikka', text: 'From Safari' };
    expect(await importRecipe({ url: URL_, listId, page })).toEqual({ ok: false, error: 'failed', reason: 'fetch_failed' });
    expect(capture).not.toHaveBeenCalled();
  });
});
