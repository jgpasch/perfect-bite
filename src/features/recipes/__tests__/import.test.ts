import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { and, asc, eq, isNull } from 'drizzle-orm';

import {
  db,
  households,
  ingredients,
  ingredientUsage,
  listItemContributions,
  listItems,
  lists,
  outbox,
  recipeIngredients,
  recipes,
} from '@/db';
import { addItem, groupItems, listItemsQuery, setItemChecked } from '@/features/lists/items';
import { ensureStarterData, getDefaultListId, getList } from '@/features/lists/lists';
import { getFeatures, hasFeature, setFeatures } from '@/features/plans/features';
import { clearFeatures, startFeatures } from '@/features/plans/load';
import { normalizeIngredientName, OTHER_CATEGORY_ID, stepIngredientsBasis, SYSTEM_CATEGORIES } from '@/shared';
import type { RecipeImportResponse } from '@/shared/schemas/recipe-import';
import { resetDb } from '@/test/db';
import { seedCatalog } from '@/test/seed';
import {
  makeSession,
  resetSupabase,
  respondToRpc,
  rpcCallsFor,
  setSupabaseConfigured,
  storageRemovals,
  storageUploadMock,
  storageUploads,
  supabase,
} from '@/test/fake-supabase';

import {
  IMPORT_ID_NAMESPACE,
  importRecipe,
  importRecipeFromPhotos,
  recipeIdForImport,
  type ImportRecipeInput,
  type ImportRecipeSuccess,
} from '../import';
import { setPageCapturer, type CapturedPage, type CaptureResult, type PageCapturer } from '../page-capture';
import { addRecipeIngredient, createRecipe, updateRecipe } from '../recipes';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/features/categories/catch-up', () => ({ startCatchUpTriggers: () => () => {} }));
// A photo's bytes as base64: its file name, so a test can see which page went where.
const mockBase64 = jest.fn(async (uri: string) => Buffer.from(uri).toString('base64'));
// The page files deleted from the cache, and what each upload's bytes came from.
const mockDeleted: string[] = [];
jest.mock('expo-file-system', () => ({
  File: class {
    mockUri: string;
    constructor(mockUri: string) {
      this.mockUri = mockUri;
    }
    base64() {
      return mockBase64(this.mockUri);
    }
    async arrayBuffer() {
      return new TextEncoder().encode(this.mockUri).buffer;
    }
    delete() {
      mockDeleted.push(this.mockUri);
    }
  },
}));

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
  tags: { meal: ['dinner'], cuisine: ['indian'], protein: ['chicken'], diet: [], method: [] },
  totalMinutes: 50,
  steps: ['Marinate the chicken.', 'Grill it.', 'Simmer in the sauce.'],
  stepIngredients: null,
  imageUrl: 'https://example.com/tikka.jpg',
};

/** TIKKA's steps matched: chicken and garlic to marinate, chicken to grill, methi and paste to simmer. */
const TIKKA_MATCH: NonNullable<RecipeImportResponse['stepIngredients']> = [
  [
    { index: 0, quantity: null },
    { index: 1, quantity: 2 },
  ],
  [{ index: 0, quantity: null }],
  [
    { index: 2, quantity: null },
    { index: 3, quantity: null },
  ],
];

let listId: string;
let warn: ReturnType<typeof jest.spyOn>;

/** The household of the default list, which an import onto it sends (spec 4.12). */
const listHousehold = () => getList(listId)!.householdId;

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

async function importOk(
  input: Partial<Omit<ImportRecipeInput, 'householdId'> & { listId: string }> = {},
): Promise<ImportRecipeSuccess> {
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

const recipeTags = (id: string) =>
  db
    .select({ tags: recipes.tags, tagsEdited: recipes.tagsEdited, totalMinutes: recipes.totalMinutes })
    .from(recipes)
    .where(eq(recipes.id, id))
    .get();

const recipeExtras = (id: string) =>
  db
    .select({ steps: recipes.steps, servings: recipes.servings, imageUrl: recipes.imageUrl, notes: recipes.notes })
    .from(recipes)
    .where(eq(recipes.id, id))
    .get();

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
  groupItems(listItemsQuery(listId).all()).unchecked.map((i) =>
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
  seedCatalog();
  ensureStarterData(USER);
  listId = getDefaultListId(USER)!;
  signIn();
  respond();
  // A plan without step_ingredients, so an import makes no match-recipe-steps call of its own.
  setFeatures(['categorize']);
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
      { id: result.recipeId, name: 'Chicken tikka masala', sourceUrl: CANONICAL, notes: null },
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

  test("sends the URL and the list's household, and the page when there is one", async () => {
    await importOk();
    expect(invoke).toHaveBeenCalledWith('import-recipe', { body: { url: URL_, householdId: listHousehold() } });
    const page = { title: 'Tikka', jsonLd: ['{"@type":"Recipe"}'], text: 'Chicken tikka masala' };
    await importOk({ page });
    expect(invoke).toHaveBeenLastCalledWith('import-recipe', { body: { url: URL_, page, householdId: listHousehold() } });
  });

  test("a list in another household sends that household, not the current one", async () => {
    const CABIN = '019a4c10-0000-7000-8000-00000000cab1';
    db.insert(households).values({ id: CABIN, name: 'Lake cabin' }).run();
    db.update(lists).set({ householdId: CABIN }).where(eq(lists.id, listId)).run();
    await importOk();
    expect((invoke.mock.calls[0][1] as { body: { householdId: string } }).body.householdId).toBe(CABIN);
  });

  test('a list not on the device sends no household, and the import fails with nothing written', async () => {
    expect(await importRecipe({ url: URL_, listId: 'list-gone' })).toEqual({ ok: false, error: 'failed' });
    expect(invoke).toHaveBeenCalledWith('import-recipe', { body: { url: URL_ } });
    expect(liveRecipes()).toEqual([]);
  });

  test('no name uses the host', async () => {
    respond({ ...TIKKA, name: '  ', servings: null });
    const result = await importOk();
    expect(result.recipeName).toBe('example.com');
    expect(liveRecipes()).toEqual([{ id: result.recipeId, name: 'example.com', sourceUrl: CANONICAL, notes: null }]);
  });

  test('a response with no source URL (a photo import, spec 6.10) makes a new recipe without one', async () => {
    const linked = createRecipe('Mum’s tikka');
    updateRecipe(linked, { name: 'Mum’s tikka', notes: '', sourceUrl: CANONICAL });
    const unlinked = createRecipe('Chicken tikka masala');
    respond({ ...TIKKA, sourceUrl: null, imageUrl: null });
    const result = await importOk();
    expect(result.created).toBe(true);
    expect([linked, unlinked]).not.toContain(result.recipeId);
    expect(liveRecipes().find((r) => r.id === result.recipeId)).toEqual({
      id: result.recipeId,
      name: 'Chicken tikka masala',
      sourceUrl: null,
      notes: null,
    });
    expect(ingredientRows(result.recipeId)).toHaveLength(4);
  });

  test('no name and no source URL is “Recipe”', async () => {
    respond({ ...TIKKA, name: ' ', sourceUrl: null });
    const result = await importOk();
    expect(result.recipeName).toBe('Recipe');
  });

  test('saves the tags and time on the recipe it creates, and sends them', async () => {
    const result = await importOk();
    const stored = { saved: [], ...TIKKA.tags };
    expect(recipeTags(result.recipeId)).toEqual({ tags: stored, tagsEdited: false, totalMinutes: 50 });
    const insert = db
      .select()
      .from(outbox)
      .all()
      .map((r) => r.mutation)
      .find((m) => m.table === 'recipes' && m.id === result.recipeId)!;
    expect(insert.fields).toMatchObject({ tags: stored, tags_edited: false, total_minutes: 50 });
  });

  test('never saves saved from the response', async () => {
    respond({ ...TIKKA, tags: { ...TIKKA.tags, saved: ['favorite', 'want-to-try'] } });
    const result = await importOk();
    expect(recipeTags(result.recipeId)?.tags).toEqual({ saved: [], ...TIKKA.tags });
  });

  test('a response with no tags or time (an older server) creates an untagged recipe', async () => {
    const { tags: _tags, totalMinutes: _minutes, ...older } = TIKKA;
    respond(older);
    const result = await importOk();
    expect(recipeTags(result.recipeId)).toEqual({ tags: null, tagsEdited: false, totalMinutes: null });
  });

  test('empty facets are saved as tagged (the model found nothing), not as untagged', async () => {
    const none = { meal: [], cuisine: [], protein: [], diet: [], method: [] };
    respond({ ...TIKKA, tags: none, totalMinutes: null });
    const result = await importOk();
    expect(recipeTags(result.recipeId)).toEqual({ tags: { saved: [], ...none }, tagsEdited: false, totalMinutes: null });
  });

  test('saves the steps, servings and photo on the recipe it creates, with no "Serves N" note, and sends them', async () => {
    const result = await importOk();
    expect(recipeExtras(result.recipeId)).toEqual({
      steps: ['Marinate the chicken.', 'Grill it.', 'Simmer in the sauce.'],
      servings: 4,
      imageUrl: 'https://example.com/tikka.jpg',
      notes: null,
    });
    const insert = db
      .select()
      .from(outbox)
      .all()
      .map((r) => r.mutation)
      .find((m) => m.table === 'recipes' && m.id === result.recipeId)!;
    expect(insert.fields).toMatchObject({
      steps: ['Marinate the chicken.', 'Grill it.', 'Simmer in the sauce.'],
      servings: 4,
      image_url: 'https://example.com/tikka.jpg',
      notes: null,
    });
  });

  test('no steps saves null, not an empty array', async () => {
    respond({ ...TIKKA, steps: [] });
    const result = await importOk();
    expect(recipeExtras(result.recipeId)?.steps).toBeNull();
  });

  test('a response with no steps or photo (an older server) saves null for both', async () => {
    const { steps: _steps, imageUrl: _image, ...older } = TIKKA;
    respond(older);
    const result = await importOk();
    expect(recipeExtras(result.recipeId)).toEqual({ steps: null, servings: 4, imageUrl: null, notes: null });
  });

  test.each([
    [null, null],
    [1, 1],
    [100, 100],
    [0, null],
    [-2, null],
    [101, null],
    [2.5, null],
  ])('servings %p saves %p', async (servings, saved) => {
    respond({ ...TIKKA, servings });
    const result = await importOk();
    expect(recipeExtras(result.recipeId)).toMatchObject({ servings: saved, notes: null });
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

describe('the step match (spec 4.5, 4.10)', () => {
  const stepIngredientsOf = (id: string) => db.select().from(recipes).where(eq(recipes.id, id)).get()!.stepIngredients;
  const idsOf = (id: string) =>
    db
      .select({ id: recipeIngredients.id })
      .from(recipeIngredients)
      .where(eq(recipeIngredients.recipeId, id))
      .orderBy(asc(recipeIngredients.position))
      .all()
      .map((i) => i.id);

  test('a new recipe saves it by its new ingredient ids, with a basis that makes it fresh', async () => {
    respond({ ...TIKKA, stepIngredients: TIKKA_MATCH });
    const { recipeId } = await importOk();
    const [chicken, garlic, methi, paste] = idsOf(recipeId);
    expect(stepIngredientsOf(recipeId)).toEqual({
      v: 1,
      basis: stepIngredientsBasis(TIKKA.steps, [chicken, garlic, methi, paste]),
      steps: [
        [
          { id: chicken, quantity: null },
          { id: garlic, quantity: 2 },
        ],
        [{ id: chicken, quantity: null }],
        [
          { id: methi, quantity: null },
          { id: paste, quantity: null },
        ],
      ],
    });
  });

  test('null, or an older server that sends none, leaves the recipe unmatched', async () => {
    const { recipeId } = await importOk();
    expect(stepIngredientsOf(recipeId)).toBeNull();
    respond({ ...TIKKA, sourceUrl: 'https://example.com/other', stepIngredients: undefined });
    const other = await importOk({ url: 'https://example.com/other' });
    expect(stepIngredientsOf(other.recipeId)).toBeNull();
  });

  test('a match that doesn’t line up with the steps or ingredients isn’t saved', async () => {
    respond({ ...TIKKA, stepIngredients: TIKKA_MATCH.slice(0, 2) });
    expect(stepIngredientsOf((await importOk()).recipeId)).toBeNull();
    respond({ ...TIKKA, sourceUrl: 'https://example.com/b', stepIngredients: [[{ index: 4, quantity: null }], [], []] });
    expect(stepIngredientsOf((await importOk({ url: 'https://example.com/b' })).recipeId)).toBeNull();
  });

  test('a reused recipe keeps its own match (or none)', async () => {
    const existing = createRecipe('Mum’s tikka');
    updateRecipe(existing, { name: 'Mum’s tikka', notes: '', sourceUrl: 'https://example.com/tikka/' });
    respond({ ...TIKKA, stepIngredients: TIKKA_MATCH });
    const { recipeId } = await importOk();
    expect(recipeId).toBe(existing);
    expect(stepIngredientsOf(existing)).toBeNull();
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

  test('keeps its own tags and time; the import’s aren’t written', async () => {
    const own = { saved: ['favorite'], meal: ['lunch'], cuisine: [], protein: ['chicken'], diet: [], method: ['grill'] };
    db.update(recipes).set({ tags: own, tagsEdited: true, totalMinutes: 25 }).where(eq(recipes.id, existing)).run();
    const before = db.select().from(outbox).all().length;
    const result = await importOk();
    expect(result.recipeId).toBe(existing);
    expect(recipeTags(existing)).toEqual({ tags: own, tagsEdited: true, totalMinutes: 25 });
    const recipeMutations = db
      .select()
      .from(outbox)
      .all()
      .slice(before)
      .filter((r) => r.mutation.table === 'recipes');
    expect(recipeMutations).toEqual([]);
  });

  test('keeps its own steps, servings, photo and "Serves N" note; nothing is backfilled', async () => {
    db.update(recipes)
      .set({ steps: ['Ask Mum.'], servings: 2, imageUrl: 'https://example.com/mum.jpg', notes: 'Serves 6' })
      .where(eq(recipes.id, existing))
      .run();
    const result = await importOk();
    expect(result.recipeId).toBe(existing);
    expect(recipeExtras(existing)).toEqual({
      steps: ['Ask Mum.'],
      servings: 2,
      imageUrl: 'https://example.com/mum.jpg',
      notes: 'Serves 6',
    });
  });

  test('one with none of them stays without them', async () => {
    const result = await importOk();
    expect(result.recipeId).toBe(existing);
    expect(recipeExtras(existing)).toEqual({ steps: null, servings: null, imageUrl: null, notes: null });
  });

  test('an untagged existing recipe stays untagged', async () => {
    const result = await importOk();
    expect(result.recipeId).toBe(existing);
    expect(recipeTags(existing)).toEqual({ tags: null, tagsEdited: false, totalMinutes: null });
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
    expect(groupItems(listItemsQuery(listId).all()).checked).toEqual([]);
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
      { id: second.recipeId, name: 'Chicken tikka masala', sourceUrl: CANONICAL, notes: null },
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

describe('recipe-only (a household, no list)', () => {
  const OTHER = 'household-2';
  let home: string;
  const recipeHousehold = (id: string) => db.select().from(recipes).where(eq(recipes.id, id)).get()?.householdId;
  const recipeOnly = async (input: { importId?: string; url?: string } = {}) => {
    const result = await importRecipe({ url: URL_, householdId: OTHER, ...input });
    if (!result.ok) throw new Error(`import failed: ${JSON.stringify(result)}`);
    return result;
  };

  beforeEach(() => {
    home = db.select().from(households).get()!.id;
    db.insert(households).values({ id: OTHER, name: 'Lake cabin' }).run();
  });

  test('creates the recipe in that household and adds nothing to any list', async () => {
    addItem(listId, '1 lb chicken thighs', USER);
    const listBefore = db.select().from(listItems).all();
    const contributionsBefore = db.select().from(listItemContributions).all();
    const usageBefore = db.select().from(ingredientUsage).all();

    const result = await recipeOnly();
    expect(result).toEqual({
      ok: true,
      recipeId: expect.any(String),
      recipeName: 'Chicken tikka masala',
      listId: null,
      created: true,
      added: 0,
      combined: 0,
      undo: expect.any(Function),
    });
    expect(recipeHousehold(result.recipeId)).toBe(OTHER);
    // The household it's saved to goes with the request, for the plan check (spec 4.12).
    expect(invoke).toHaveBeenCalledWith('import-recipe', { body: { url: URL_, householdId: OTHER } });
    expect(liveRecipes()).toEqual([
      { id: result.recipeId, name: 'Chicken tikka masala', sourceUrl: CANONICAL, notes: null },
    ]);
    expect(ingredientRows(result.recipeId).map((i) => i.displayName)).toEqual([
      'chicken thighs',
      'garlic',
      'kasuri methi',
      'zqx tikka paste',
    ]);
    expect(db.select().from(listItems).all()).toEqual(listBefore);
    expect(db.select().from(listItemContributions).all()).toEqual(contributionsBefore);
    expect(db.select().from(ingredientUsage).all()).toEqual(usageBefore);
    expect(rows()).toEqual(['1 lb chicken thighs']);
  });

  test('categories still land locally, so nothing is pending', async () => {
    await recipeOnly();
    const catalog = (name: string) =>
      db
        .select({ status: ingredients.status, categoryId: ingredients.defaultCategoryId })
        .from(ingredients)
        .where(eq(ingredients.normalizedName, name))
        .get();
    expect(catalog('kasuri methi')).toEqual({ status: 'categorized', categoryId: category('spices') });
    expect(catalog('zqx tikka paste')).toEqual({ status: 'failed', categoryId: OTHER_CATEGORY_ID });
    expect(db.select().from(ingredients).where(eq(ingredients.status, 'pending')).all()).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test('reuses the household’s recipe with the same canonical URL and leaves it as it is', async () => {
    const existing = createRecipe('Mum’s tikka');
    updateRecipe(existing, { name: 'Mum’s tikka', notes: '', sourceUrl: 'https://example.com/tikka/' });
    db.update(recipes).set({ householdId: OTHER }).where(eq(recipes.id, existing)).run();
    const result = await recipeOnly();
    expect(result).toMatchObject({ recipeId: existing, recipeName: 'Mum’s tikka', created: false, listId: null, added: 0 });
    expect(liveRecipes()).toEqual([
      { id: existing, name: 'Mum’s tikka', sourceUrl: 'https://example.com/tikka/', notes: null },
    ]);
  });

  test('a recipe with the same URL in another household doesn’t count', async () => {
    const elsewhere = createRecipe('Tikka at home');
    updateRecipe(elsewhere, { name: 'Tikka at home', notes: '', sourceUrl: CANONICAL });
    expect(recipeHousehold(elsewhere)).toBe(home);
    const result = await recipeOnly();
    expect(result.created).toBe(true);
    expect(result.recipeId).not.toBe(elsewhere);
    expect(recipeHousehold(result.recipeId)).toBe(OTHER);
  });

  test('is idempotent by import id', async () => {
    const first = await recipeOnly({ importId: 'envelope-1' });
    expect(first.recipeId).toBe(recipeIdForImport('envelope-1'));
    respond({ ...TIKKA, sourceUrl: 'https://example.com/tikka-v2' });
    const second = await recipeOnly({ importId: 'envelope-1' });
    expect(second).toMatchObject({ recipeId: first.recipeId, created: false, added: 0 });
    expect(liveRecipes()).toHaveLength(1);
    expect(ingredientRows(first.recipeId)).toHaveLength(4);
  });

  test('undo deletes the recipe this import created', async () => {
    const result = await recipeOnly();
    result.undo();
    expect(liveRecipes()).toEqual([]);
    expect(db.select().from(recipes).where(eq(recipes.id, result.recipeId)).get()?.deletedAt).not.toBeNull();
  });

  test('undo keeps a reused recipe', async () => {
    const existing = createRecipe('Tikka');
    updateRecipe(existing, { name: 'Tikka', notes: 'Family favourite', sourceUrl: CANONICAL });
    db.update(recipes).set({ householdId: OTHER }).where(eq(recipes.id, existing)).run();
    const result = await recipeOnly();
    result.undo();
    expect(liveRecipes()).toEqual([{ id: existing, name: 'Tikka', sourceUrl: CANONICAL, notes: 'Family favourite' }]);
  });

  test('a household that doesn’t exist fails and writes nothing', async () => {
    const before = snapshot();
    expect(await importRecipe({ url: URL_, householdId: 'household-gone' })).toEqual({ ok: false, error: 'failed' });
    expect(snapshot()).toEqual(before);
  });

  test('errors come back as for a list import, writing nothing', async () => {
    const before = snapshot();
    respondWithError(422, { error: 'not_a_recipe' });
    expect(await importRecipe({ url: URL_, householdId: OTHER })).toEqual({ ok: false, error: 'not_a_recipe' });
    expect(snapshot()).toEqual(before);
  });
});

describe('created', () => {
  test('is true for a new recipe and false for a reused one, on a list too', async () => {
    const first = await importOk();
    expect(first.created).toBe(true);
    const second = await importOk();
    expect(second).toMatchObject({ recipeId: first.recipeId, created: false, listId });
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

  test('the monthly limit is limit_reached with its resets_at, never rate_limited', async () => {
    respondWithError(429, { error: 'limit_reached', message: 'Used up', resets_at: '2026-11-01T00:00:00.000Z' });
    expect(await run()).toEqual({ ok: false, error: 'limit_reached', resetsAt: '2026-11-01T00:00:00.000Z' });
  });

  test("the user's daily safety limit is daily_limit, never rate_limited", async () => {
    respondWithError(429, { error: 'daily_limit', message: 'Daily limit', resets_at: '2026-10-22T00:00:00.000Z' });
    expect(await run()).toEqual({ ok: false, error: 'daily_limit' });
  });

  test('limit_reached without a readable resets_at falls back to the start of next month (UTC)', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-12-14T10:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      respondWithError(429, { error: 'limit_reached', message: 'Used up' });
      expect(await run()).toEqual({ ok: false, error: 'limit_reached', resetsAt: '2027-01-01T00:00:00.000Z' });
      respondWithError(429, { error: 'limit_reached', message: 'Used up', resets_at: 'soon' });
      expect(await run()).toEqual({ ok: false, error: 'limit_reached', resetsAt: '2027-01-01T00:00:00.000Z' });
    } finally {
      jest.useRealTimers();
    }
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

  test('not entitled: the plan has no recipe import', async () => {
    respondWithError(403, { error: 'not_entitled', message: "Your plan doesn't include recipe_import" });
    expect(await run()).toEqual({ ok: false, error: 'not_entitled' });
  });

  test('a bare 403 with no JSON body is not entitled; a 403 with another code isn’t', async () => {
    respondWithError(403, 'Forbidden');
    expect(await run()).toEqual({ ok: false, error: 'not_entitled' });
    respondWithError(403, { error: 'rate_limited', message: 'Slow down' });
    expect(await run()).toEqual({ ok: false, error: 'rate_limited' });
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
    expect(bodies()).toEqual([
      { url: URL_, householdId: listHousehold() },
      { url: URL_, page: PAGE, householdId: listHousehold() },
    ]);
    expect(result.recipeName).toBe('Chicken tikka masala');
    expect(result.added).toBe(4);
    expect(liveRecipes()).toEqual([
      { id: result.recipeId, name: 'Chicken tikka masala', sourceUrl: CANONICAL, notes: null },
    ]);
  });

  test('empty parts of the capture are left out of the page', async () => {
    captureWith({ ok: true, page: { title: '  ', jsonLd: [], text: 'Tikka: 2 lb chicken' } });
    invoke.mockResolvedValueOnce(blocked()).mockResolvedValueOnce({ data: TIKKA, error: null });
    await importOk();
    expect(bodies()[1]).toEqual({ url: URL_, page: { text: 'Tikka: 2 lb chicken' }, householdId: listHousehold() });
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
    ['not_entitled', 403, { ok: false, error: 'not_entitled' }],
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

describe('plans (spec 4.12)', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  let stopFeatures: (() => void) | null = null;

  beforeEach(async () => {
    respondToRpc('my_features', { data: ['categorize', 'recipe_import', 'recipe_import_photo'] });
    stopFeatures = startFeatures(USER);
    await flush();
    expect(hasFeature('recipe_import')).toBe(true);
  });

  afterEach(() => {
    stopFeatures?.();
    stopFeatures = null;
    clearFeatures();
  });

  test('not_entitled reloads the plan', async () => {
    respondWithError(403, { error: 'not_entitled', message: 'No' });
    respondToRpc('my_features', { data: ['categorize'] });
    expect(await importRecipe({ url: URL_, listId })).toEqual({ ok: false, error: 'not_entitled' });
    await flush();
    expect(rpcCallsFor('my_features')).toHaveLength(2);
    expect(getFeatures()).toEqual(['categorize']);
  });

  test('not_entitled drops recipe_import even when the reload fails, and keeps the rest', async () => {
    respondWithError(403, { error: 'not_entitled', message: 'No' });
    respondToRpc('my_features', { data: null, error: { message: 'boom' } });
    expect(await importRecipe({ url: URL_, listId })).toEqual({ ok: false, error: 'not_entitled' });
    await flush();
    expect(rpcCallsFor('my_features')).toHaveLength(2);
    expect(getFeatures()).toEqual(['categorize', 'recipe_import_photo']);
  });

  test('other errors leave the plan alone', async () => {
    respondWithError(422, { error: 'not_a_recipe', message: 'No' });
    expect(await importRecipe({ url: URL_, listId })).toEqual({ ok: false, error: 'not_a_recipe' });
    await flush();
    expect(hasFeature('recipe_import')).toBe(true);
    expect(rpcCallsFor('my_features')).toHaveLength(1);
  });

  test("a photo import's not_entitled drops recipe_import_photo, not recipe_import", async () => {
    respondWithError(403, { error: 'not_entitled', message: 'No' });
    respondToRpc('my_features', { data: null, error: { message: 'boom' } });
    expect(await importRecipeFromPhotos({ listId, photoUris: ['file:///p1.jpg'] })).toEqual({ ok: false, error: 'not_entitled' });
    await flush();
    expect(getFeatures()).toEqual(['categorize', 'recipe_import']);
  });
});

describe('from photos (spec 4.10, 6.10)', () => {
  const PAGES = ['file:///cache/page-1.jpg', 'file:///cache/page-2.jpg', 'file:///cache/page-3.jpg'];
  const b64 = (uri: string) => Buffer.from(uri).toString('base64');
  /** What the photo function answers: no link or photo of its own (TIKKA's are a link import's). */
  const PHOTO_RECIPE: RecipeImportResponse = { ...TIKKA, sourceUrl: null, imageUrl: null };

  beforeEach(() => {
    mockBase64.mockClear();
    respond(PHOTO_RECIPE);
  });

  test('sends each page as a base64 JPEG, in order, to import-recipe-photo', async () => {
    await importRecipeFromPhotos({ listId, photoUris: PAGES });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('import-recipe-photo', {
      body: { images: PAGES.map((uri) => ({ mediaType: 'image/jpeg', data: b64(uri) })), householdId: listHousehold() },
    });
    expect(mockBase64.mock.calls.map(([uri]) => uri)).toEqual(PAGES);
  });

  test('a photo import into a household sends that household', async () => {
    const householdId = db.select().from(households).get()!.id;
    await importRecipeFromPhotos({ householdId, photoUris: PAGES.slice(0, 1) });
    expect((invoke.mock.calls[0][1] as { body: { householdId: string } }).body.householdId).toBe(householdId);
  });

  test('creates a recipe with no link and no photo, and adds every ingredient to the list', async () => {
    const result = await importRecipeFromPhotos({ listId, photoUris: PAGES.slice(0, 1) });
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result).toMatchObject({ recipeName: 'Chicken tikka masala', listId, created: true, added: 4 });
    expect(liveRecipes()).toEqual([{ id: result.recipeId, name: 'Chicken tikka masala', sourceUrl: null, notes: null }]);
    expect(recipeExtras(result.recipeId)).toEqual({
      steps: ['Marinate the chicken.', 'Grill it.', 'Simmer in the sauce.'],
      servings: 4,
      imageUrl: null,
      notes: null,
    });
    expect(recipeTags(result.recipeId)).toMatchObject({
      tags: { saved: [], meal: ['dinner'], cuisine: ['indian'], protein: ['chicken'], diet: [], method: [] },
      totalMinutes: 50,
    });
    expect(ingredientRows(result.recipeId).map((i) => i.displayName)).toEqual([
      'chicken thighs',
      'garlic',
      'kasuri methi',
      'zqx tikka paste',
    ]);
    expect(rows()).toEqual(['2 lb chicken thighs', '4 clove garlic', '1 tbsp kasuri methi', 'zqx tikka paste']);
    expect(contributionsFor(itemFor('garlic')!.id)).toEqual([{ source: 'recipe', recipeId: result.recipeId, quantity: 4, unit: 'clove' }]);
  });

  test("never keeps a link or photo the response carries, so it shows no credit", async () => {
    respond(TIKKA);
    const result = await importRecipeFromPhotos({ listId, photoUris: PAGES.slice(0, 1) });
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(liveRecipes()[0].sourceUrl).toBeNull();
    expect(recipeExtras(result.recipeId)!.imageUrl).toBeNull();
  });

  test('never reuses a recipe: the same photos twice make two', async () => {
    const first = await importRecipeFromPhotos({ listId, photoUris: PAGES.slice(0, 1) });
    const second = await importRecipeFromPhotos({ listId, photoUris: PAGES.slice(0, 1) });
    if (!first.ok || !second.ok) throw new Error('import failed');
    expect(second.created).toBe(true);
    expect(second.recipeId).not.toBe(first.recipeId);
    expect(liveRecipes()).toHaveLength(2);
  });

  test("saves the response's step match", async () => {
    respond({ ...PHOTO_RECIPE, stepIngredients: TIKKA_MATCH });
    const result = await importRecipeFromPhotos({ listId, photoUris: PAGES.slice(0, 1) });
    if (!result.ok) throw new Error(JSON.stringify(result));
    const saved = db.select({ stepIngredients: recipes.stepIngredients }).from(recipes).where(eq(recipes.id, result.recipeId)).get()!;
    expect(saved.stepIngredients?.steps.map((s) => s.length)).toEqual([2, 1, 2]);
  });

  test('an unnamed recipe is called "Recipe"', async () => {
    respond({ ...PHOTO_RECIPE, name: '  ' });
    const result = await importRecipeFromPhotos({ listId, photoUris: PAGES.slice(0, 1) });
    expect(result).toMatchObject({ ok: true, recipeName: 'Recipe' });
  });

  test('recipe-only: saves into the household and adds nothing to a list', async () => {
    const householdId = db.select().from(households).get()!.id;
    const result = await importRecipeFromPhotos({ householdId, photoUris: PAGES.slice(0, 2) });
    expect(result).toMatchObject({ ok: true, listId: null, added: 0, created: true });
    expect(rows()).toEqual([]);
    expect(liveRecipes().map((r) => r.name)).toEqual(['Chicken tikka masala']);
  });

  test('Undo deletes the recipe and takes the list adds back', async () => {
    const result = await importRecipeFromPhotos({ listId, photoUris: PAGES.slice(0, 1) });
    if (!result.ok) throw new Error(JSON.stringify(result));
    result.undo();
    expect(liveRecipes()).toEqual([]);
    expect(rows()).toEqual([]);
  });

  test.each([
    ['not_a_recipe', 422, { ok: false, error: 'not_a_recipe' }],
    ['rate_limited', 429, { ok: false, error: 'rate_limited' }],
    ['daily_limit', 429, { ok: false, error: 'daily_limit' }],
    ['limit_reached', 429, { ok: false, error: 'limit_reached', resetsAt: '2026-11-01T00:00:00.000Z' }],
    ['unavailable', 503, { ok: false, error: 'rate_limited' }],
    ['invalid_request', 400, { ok: false, error: 'failed' }],
  ])('%s (%i) comes back as %o and writes nothing', async (code, status, expected) => {
    respondWithError(status, { error: code, message: 'No', resets_at: '2026-11-01T00:00:00.000Z' });
    const before = snapshot();
    expect(await importRecipeFromPhotos({ listId, photoUris: PAGES })).toEqual(expected);
    expect(snapshot()).toEqual(before);
  });

  test('offline (a network failure, no session, or no config) writes nothing', async () => {
    const before = snapshot();
    invoke.mockResolvedValue({ data: null, error: { name: 'FunctionsFetchError', message: 'Network request failed' } });
    expect(await importRecipeFromPhotos({ listId, photoUris: PAGES })).toEqual({ ok: false, error: 'offline' });
    supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    expect(await importRecipeFromPhotos({ listId, photoUris: PAGES })).toEqual({ ok: false, error: 'offline' });
    setSupabaseConfigured(false);
    expect(await importRecipeFromPhotos({ listId, photoUris: PAGES })).toEqual({ ok: false, error: 'offline' });
    expect(snapshot()).toEqual(before);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("a page that can't be read is offline-like and sends nothing", async () => {
    mockBase64.mockRejectedValueOnce(new Error('gone'));
    expect(await importRecipeFromPhotos({ listId, photoUris: PAGES })).toEqual({ ok: false, error: 'offline' });
    expect(invoke).not.toHaveBeenCalled();
  });

  test('no photos sends nothing', async () => {
    expect(await importRecipeFromPhotos({ listId, photoUris: [] })).toEqual({ ok: false, error: 'failed' });
    expect(invoke).not.toHaveBeenCalled();
  });

  describe('keeps the pages (spec 4.10)', () => {
    const sourcePages = (id: string) => db.select({ sourcePages: recipes.sourcePages }).from(recipes).where(eq(recipes.id, id)).get()?.sourcePages;
    const bytesOf = (body: unknown) => new TextDecoder().decode(body as ArrayBuffer);

    beforeEach(() => {
      mockDeleted.length = 0;
    });

    test('uploads every page in order to recipe-pages and sets source_pages to their paths', async () => {
      const result = await importRecipeFromPhotos({ listId, photoUris: PAGES });
      if (!result.ok) throw new Error(JSON.stringify(result));
      const householdId = db.select().from(households).get()!.id;
      const uploads = storageUploads();
      expect(uploads).toHaveLength(3);
      expect(uploads.map(([bucket]) => bucket)).toEqual(['recipe-pages', 'recipe-pages', 'recipe-pages']);
      expect(uploads.map(([, , body]) => bytesOf(body))).toEqual(PAGES);
      expect(uploads.map(([, , , options]) => options)).toEqual(Array(3).fill({ contentType: 'image/jpeg', upsert: false }));
      const paths = uploads.map(([, path]) => path as string);
      for (const path of paths) {
        expect(path).toMatch(new RegExp(`^${householdId}/${result.recipeId}/[0-9a-f-]{36}\\.jpg$`));
      }
      expect(new Set(paths).size).toBe(3);
      expect(sourcePages(result.recipeId)).toEqual(paths);
      // Written through the usual recipe update, so it's pushed with the recipe.
      const pushed = db
        .select()
        .from(outbox)
        .all()
        .map((r) => r.mutation)
        .filter((m) => m.table === 'recipes' && m.id === result.recipeId);
      expect(pushed.at(-1)?.fields).toMatchObject({ source_pages: paths });
      expect(storageRemovals()).toEqual([]);
      expect(mockDeleted).toEqual(PAGES);
    });

    test('a failed page upload removes the ones that went up, leaves source_pages null, and the recipe is still saved', async () => {
      storageUploadMock
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: null, error: { message: 'Network', statusCode: '500' } });
      const result = await importRecipeFromPhotos({ listId, photoUris: PAGES });
      expect(result).toMatchObject({ ok: true, recipeName: 'Chicken tikka masala', created: true, added: 4 });
      if (!result.ok) return;
      const uploads = storageUploads();
      // The third page is never tried.
      expect(uploads).toHaveLength(2);
      expect(storageRemovals()).toEqual([['recipe-pages', [uploads[0][1]]]]);
      expect(sourcePages(result.recipeId)).toBeNull();
      expect(liveRecipes().map((r) => r.id)).toEqual([result.recipeId]);
      expect(warn).toHaveBeenCalledWith('[pages] upload failed', expect.anything());
      expect(mockDeleted).toEqual(PAGES);
    });

    test('a failed first page removes nothing', async () => {
      storageUploadMock.mockResolvedValueOnce({ data: null, error: { message: 'Payload too large', statusCode: '413' } });
      const result = await importRecipeFromPhotos({ listId, photoUris: PAGES });
      if (!result.ok) throw new Error(JSON.stringify(result));
      expect(storageUploads()).toHaveLength(1);
      expect(storageRemovals()).toEqual([]);
      expect(sourcePages(result.recipeId)).toBeNull();
    });

    test('a failed import uploads nothing and keeps the page files', async () => {
      respondWithError(422, { error: 'not_a_recipe', message: 'No' });
      expect(await importRecipeFromPhotos({ listId, photoUris: PAGES })).toEqual({ ok: false, error: 'not_a_recipe' });
      expect(storageUploads()).toEqual([]);
      expect(mockDeleted).toEqual([]);
    });

    test('a link import uploads nothing', async () => {
      respond(TIKKA);
      const result = await importRecipe({ listId, url: URL_ });
      if (!result.ok) throw new Error(JSON.stringify(result));
      expect(storageUploads()).toEqual([]);
      expect(sourcePages(result.recipeId)).toBeNull();
    });
  });
});
