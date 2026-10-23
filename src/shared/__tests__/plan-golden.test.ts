// Golden results of the device's list adds and import saves (share-server-import plan §1): what
// `addItemsBulk` and the import's `save()` return and the outbox writes they make, for the cases
// the shared planner has to reproduce. Recorded before the domain rules moved to
// `src/shared/domain/`, so the move (and later the planner) is checked against today's behavior.
//
// Ids come from a counter and the clock is fixed, so a run is deterministic. To record the
// fixtures again after an intended change: `UPDATE_PLAN_FIXTURES=1 yarn jest plan-golden` (or
// delete the file: a missing one is recorded).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';

import { db, households, ingredients, lists, outbox } from '@/db';
import { addItem, addItemsBulk, setItemChecked, type BulkAdd } from '@/features/lists/items';
import { ensureStarterData, getDefaultListId } from '@/features/lists/lists';
import { importRecipe, type ImportRecipeInput } from '@/features/recipes/import';
import { createRecipe } from '@/features/recipes/recipes';
import { normalizeIngredientName, SYSTEM_CATEGORIES } from '@/shared';
import type { RecipeImportResponse } from '@/shared/schemas/recipe-import';
import { resetDb } from '@/test/db';
import { makeSession, resetSupabase, supabase } from '@/test/fake-supabase';
import { seedCatalog } from '@/test/seed';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/features/categories/catch-up', () => ({ startCatchUpTriggers: () => () => {} }));
jest.mock('@/features/recipes/ensure-step-match', () => ({ ensureStepMatch: () => Promise.resolve() }));
// Ids in creation order: 00000000-0000-7000-8000-000000000001, ...
let mockIdCount = 0;
jest.mock('@/lib/id', () => ({
  newId: () => `00000000-0000-7000-8000-${String(++mockIdCount).padStart(12, '0')}`,
}));

const FIXTURES = path.join(__dirname, 'fixtures', 'plan');
const UPDATE = process.env.UPDATE_PLAN_FIXTURES === '1';
const START = new Date('2026-03-02T12:00:00.000Z');
const USER = '00000000-0000-4000-8000-0000000000aa';

let listId: string;
let warn: ReturnType<typeof jest.spyOn>;

beforeAll(() => {
  // Only the clock: promises and timers run as usual.
  jest.useFakeTimers({
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
});

afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  jest.setSystemTime(START);
  mockIdCount = 0;
  resetDb();
  resetSupabase();
  seedCatalog();
  ensureStarterData(USER);
  listId = getDefaultListId(USER)!;
  supabase.auth.getSession.mockResolvedValue({ data: { session: makeSession(USER) }, error: null });
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

const householdId = () => db.select({ id: lists.householdId }).from(lists).where(eq(lists.id, listId)).get()!.id;

/** Later than the setup, so the recorded writes are only the case's own and their times stand apart. */
function startCase() {
  db.delete(outbox).run();
  jest.setSystemTime(new Date(START.getTime() + 60_000));
}

/** The outbox writes since `startCase`, in order, without their HLCs (the device id in them is per run). */
function writes() {
  return db
    .select({ mutation: outbox.mutation })
    .from(outbox)
    .orderBy(outbox.id)
    .all()
    .map(({ mutation: { hlc: _hlc, ...rest } }) => rest);
}

/** Plain JSON: dates as ISO strings, functions (an import's `undo`) left out. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

function matchesFixture(name: string, description: string, value: { results: unknown; writes: unknown }) {
  const file = path.join(FIXTURES, `${name}.json`);
  const actual = plain({ description, ...value });
  // A missing fixture is recorded, as a new Jest snapshot would be (but never on CI).
  if (UPDATE || (!fs.existsSync(file) && !process.env.CI)) {
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
  }
  expect(actual).toEqual(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function bulk(name: string, description: string, adds: readonly BulkAdd[]) {
  startCase();
  const results = addItemsBulk(listId, adds, USER);
  matchesFixture(name, description, { results, writes: writes() });
}

// `pepino` is linked to `cucumber` (spec 4.15), whatever the catalog seed says.
const insertTwins = () =>
  db
    .update(ingredients)
    .set({ sameAs: 'cucumber', linkedBy: 'seed' })
    .where(eq(ingredients.normalizedName, 'pepino'))
    .run();
const setCombine = (on: boolean) =>
  db.update(households).set({ combineLanguages: on }).where(eq(households.id, householdId())).run();

describe('addItemsBulk', () => {
  test('new items', () => {
    bulk('new-item', 'Adds to an empty list: each a new item with its amount.', [
      { text: '2 lbs chicken thighs' },
      { text: 'milk' },
    ]);
  });

  test('Combine', () => {
    addItem(listId, '2 eggs', USER);
    bulk('combine', 'An open item for the ingredient: the amount is added to it.', [{ text: '3 eggs' }]);
  });

  test('reopen', () => {
    const added = addItem(listId, '1 gal milk', USER)!;
    setItemChecked(added.itemId, true, USER);
    bulk('reopen', 'Only a checked item: it is unchecked and its amounts replaced.', [{ text: '2 gal milk' }]);
  });

  test('the same ingredient twice in one batch', () => {
    const recipeId = createRecipe('Pancakes', householdId());
    bulk('same-twice-in-batch', 'The second add folds into the item the first one made.', [
      { text: '1 cup flour', source: 'recipe', recipeId },
      { text: '2 cups flour', source: 'recipe', recipeId },
    ]);
  });

  test('a family twin with combine-languages on', () => {
    insertTwins();
    setCombine(true);
    addItem(listId, '1 cucumber', USER);
    bulk('family-twin-combine-on', 'pepino Combines into the open cucumber.', [{ text: '2 pepino' }]);
  });

  test('a family twin with combine-languages off', () => {
    insertTwins();
    setCombine(false);
    addItem(listId, '1 cucumber', USER);
    bulk('family-twin-combine-off', 'pepino is a new item beside the open cucumber.', [{ text: '2 pepino' }]);
  });

  test('the counted-one rule', () => {
    addItem(listId, '1 red onion', USER);
    const recipeId = createRecipe('Salsa', householdId());
    bulk(
      'counted-one',
      'A recipe line with no amount of something counted is one of it; a manual add with none stays without.',
      [
        { text: 'red onion', source: 'recipe', recipeId },
        { text: 'eggs', source: 'recipe', recipeId },
        { text: 'bananas' },
      ],
    );
  });
});

type Ingredient = RecipeImportResponse['ingredients'][number];
const category = (slug: string) => SYSTEM_CATEGORIES.find((c) => c.slug === slug)!.id;
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

const URL_ = 'https://www.example.com/tikka/?utm_source=pin#recipe';
const TIKKA: RecipeImportResponse = {
  name: '  Chicken   tikka masala ',
  sourceUrl: 'https://example.com/tikka',
  servings: 4,
  ingredients: [
    ingredient('chicken thighs', 2, 'lb', 'boneless', category('meat-seafood')),
    ingredient('garlic', 4, 'clove', ' minced ', category('produce')),
    ingredient('red onion', null, null, '', category('produce')),
    ingredient('zqx tikka paste', null, null, 'to taste', null, 'failed'),
  ],
  tags: { meal: ['dinner'], cuisine: ['indian'], protein: ['chicken'], diet: [], method: [] },
  totalMinutes: 50,
  steps: ['Marinate the chicken.', 'Grill it.', 'Simmer in the sauce.'],
  stepIngredients: [
    [
      { index: 0, quantity: null },
      { index: 1, quantity: 2 },
    ],
    [{ index: 0, quantity: null }],
    [
      { index: 2, quantity: null },
      { index: 3, quantity: null },
    ],
  ],
  imageUrl: 'https://example.com/tikka.jpg',
};

async function importCase(name: string, description: string, input: ImportRecipeInput, response = TIKKA) {
  startCase();
  supabase.functions.invoke.mockResolvedValue({ data: response, error: null });
  const results = await importRecipe(input);
  matchesFixture(name, description, { results, writes: writes() });
}

describe("the import's save()", () => {
  test('a new recipe onto a list', async () => {
    addItem(listId, '1 lb chicken thighs', USER);
    await importCase(
      'import-new',
      'Creates the recipe, its ingredients and its step match, and adds every ingredient to the list.',
      { url: URL_, listId },
    );
  });

  test('recipe-only', async () => {
    await importCase('import-recipe-only', 'Saves the recipe to the household and adds nothing to a list.', {
      url: URL_,
      householdId: householdId(),
    });
  });

  test('reusing the recipe an earlier run of the same import created', async () => {
    const importId = '11111111-2222-4333-8444-555555555555';
    supabase.functions.invoke.mockResolvedValue({ data: TIKKA, error: null });
    await importRecipe({ url: URL_, householdId: householdId(), importId });
    // Another link, so only the import id can find it.
    await importCase(
      'import-reuse-by-import-id',
      'The recipe the import id maps to is reused, not created again; its ingredients go on the list.',
      { url: 'https://example.org/other', listId, importId },
      { ...TIKKA, name: 'Renamed by the site', sourceUrl: 'https://example.org/other' },
    );
  });

  test('reusing a live recipe with the same canonical link', async () => {
    supabase.functions.invoke.mockResolvedValue({ data: TIKKA, error: null });
    await importRecipe({ url: URL_, householdId: householdId() });
    await importCase(
      'import-reuse-by-url',
      'A live recipe whose link canonicalizes to the same URL is reused; its ingredients go on the list.',
      { url: 'https://example.com/tikka?ref=feed', listId },
    );
  });

  test("a step match that doesn't line up", async () => {
    await importCase(
      'import-step-mismatch',
      'A step match with fewer entries than steps is dropped: the recipe is saved with no step_ingredients.',
      { url: URL_, listId },
      { ...TIKKA, stepIngredients: TIKKA.stepIngredients!.slice(0, 2) },
    );
  });
});
