// Categorizing by plan (spec 4.12): without `categorize` nothing is sent and new names show in
// Other with the default unit `count`; a `not_entitled` answer counts as no `categorize`; gaining
// it runs the catch-up.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, ingredients, lists } from '@/db';
import { groupByCategory, SORTING_CATEGORY_ID } from '@/domain/category-resolver';
import { usualUnitsByKey } from '@/domain/usual-unit';
import { addItem, groupItems, listItemsQuery, usualUnitsQuery } from '@/features/lists/items';
import { ensureStarterData, getDefaultListId } from '@/features/lists/lists';
import { getFeatures, hasFeature } from '@/features/plans/features';
import { clearFeatures, refreshFeatures, startFeatures } from '@/features/plans/load';
import { OTHER_CATEGORY_ID, SYSTEM_CATEGORIES } from '@/shared';
import { resetDb } from '@/test/db';
import { seedCatalog } from '@/test/seed';
import { makeSession, respondToRpc, resetSupabase, rpcCallsFor, supabase } from '@/test/fake-supabase';

import { ensureMissingIngredients, getOrderedCategories } from '../categories';
import { categorizePending, isNotEntitled, startCategorizeOnGain } from '../categorization';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/features/categories/catch-up', () => ({ startCatchUpTriggers: () => () => {} }));

const USER = 'user-1';
const SPICES = SYSTEM_CATEGORIES.find((c) => c.slug === 'spices')!.id;
const invoke = supabase.functions.invoke;
const flush = () => new Promise((resolve) => setImmediate(resolve));

let listId: string;
let warn: ReturnType<typeof jest.spyOn>;
let stopFeatures: (() => void) | null = null;

/** Signs the store in with `features` as the plan's answer. */
async function onPlan(features: string[]) {
  respondToRpc('my_features', { data: features });
  stopFeatures = startFeatures(USER);
  await flush();
  expect(getFeatures()).toEqual([...features].sort());
}

/** The function's 403 answer, as `functions.invoke` reports it. */
function notEntitled() {
  return {
    data: null,
    error: {
      name: 'FunctionsHttpError',
      context: {
        status: 403,
        json: () => Promise.resolve({ error: 'not_entitled', message: "Your plan doesn't include categorize" }),
      },
    },
  };
}

const row = (name: string) => db.select().from(ingredients).where(eq(ingredients.normalizedName, name)).get();
const view = (sorts: boolean) =>
  groupItems(listItemsQuery(listId).all(), usualUnitsByKey(usualUnitsQuery(listId).all()), sorts);
const household = () => db.select({ id: lists.householdId }).from(lists).where(eq(lists.id, listId)).get()!.id;
const sections = (sorts: boolean) =>
  groupByCategory(getOrderedCategories(USER, household()), view(sorts).unchecked).map((s) => [
    s.category.name,
    s.items.map((i) => i.displayName),
  ]);

beforeEach(() => {
  resetDb();
  resetSupabase();
  clearFeatures();
  seedCatalog();
  ensureStarterData(USER);
  listId = getDefaultListId(USER)!;
  supabase.auth.getSession.mockResolvedValue({ data: { session: makeSession(USER) }, error: null });
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  stopFeatures?.();
  stopFeatures = null;
  warn.mockRestore();
});

describe('without categorize (base)', () => {
  beforeEach(() => onPlan([]));

  test('an add sends nothing', async () => {
    const added = addItem(listId, 'kashk', USER)!;
    expect(added.pendingNames).toEqual(['kashk']);
    await categorizePending(added.pendingNames);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('the catch-up sends nothing, and the names stay pending for later', async () => {
    addItem(listId, 'kashk', USER);
    addItem(listId, 'mahleb', USER);
    await categorizePending();
    expect(invoke).not.toHaveBeenCalled();
    expect(supabase.auth.getSession).not.toHaveBeenCalled();
    expect(row('kashk')).toMatchObject({ status: 'pending', defaultCategoryId: null });
  });

  test('a new name is recorded uncategorized with the default unit count, and shows in Other', () => {
    addItem(listId, 'milk', USER);
    addItem(listId, 'kashk', USER);
    expect(row('kashk')).toMatchObject({ status: 'pending', defaultCategoryId: null, defaultUnit: 'count', categorizedBy: null });
    const [, kashk] = view(false).unchecked;
    expect(kashk.categoryId).toBe(OTHER_CATEGORY_ID);
    expect(kashk.usualUnit).toBeNull();
    expect(sections(false)).toEqual([
      ['Dairy & Eggs', ['milk']],
      ['Other', ['kashk']],
    ]);
  });

  test('known names keep their aisle and default unit from the catalog', () => {
    addItem(listId, 'milk', USER);
    expect(row('milk')).toMatchObject({ status: 'categorized', categorizedBy: 'seed' });
    expect(row('milk')!.defaultUnit).not.toBe(null);
    expect(view(false).unchecked[0].categoryId).toBe(SYSTEM_CATEGORIES.find((c) => c.slug === 'dairy-eggs')!.id);
  });

  test('a name pulled in from a household-mate is recorded with count too', () => {
    // An item whose name the device has no ingredient row for, as a pull leaves it.
    addItem(listId, 'yuzu kosho', USER);
    db.delete(ingredients).where(eq(ingredients.normalizedName, 'yuzu kosho')).run();
    expect(view(false).unchecked[0].categoryId).toBe(OTHER_CATEGORY_ID);
    ensureMissingIngredients();
    expect(row('yuzu kosho')).toMatchObject({ status: 'pending', defaultUnit: 'count' });
    expect(view(false).unchecked[0].categoryId).toBe(OTHER_CATEGORY_ID);
  });

  test('gaining categorize (a plan change) runs the catch-up for the leftover names at once', async () => {
    const stop = startCategorizeOnGain();
    addItem(listId, 'kashk', USER);
    addItem(listId, 'mahleb', USER);
    invoke.mockResolvedValue({
      data: {
        results: {
          kashk: { status: 'categorized', category_id: SPICES, is_grocery_item: true, default_unit: 'jar' },
          mahleb: { status: 'categorized', category_id: SPICES, is_grocery_item: true, default_unit: 'oz' },
        },
      },
      error: null,
    });
    respondToRpc('my_features', { data: ['categorize'] });
    await refreshFeatures();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('categorize-ingredients', { body: { names: ['kashk', 'mahleb'] } });
    // The answer replaces the stand-in unit.
    expect(row('kashk')).toMatchObject({ status: 'categorized', defaultCategoryId: SPICES, defaultUnit: 'jar' });
    stop();
  });

  test('other plan changes, and keeping categorize, run no catch-up', async () => {
    const stop = startCategorizeOnGain();
    addItem(listId, 'kashk', USER);
    respondToRpc('my_features', { data: ['recipe_import_photo'] });
    await refreshFeatures();
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    respondToRpc('my_features', { data: ['categorize'] }, { data: ['categorize', 'recipe_import'] });
    await refreshFeatures();
    await refreshFeatures();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('with categorize (standard)', () => {
  beforeEach(() => onPlan(['categorize']));

  test('a new name shows as Sorting... with no default unit, and is sent', async () => {
    const added = addItem(listId, 'kashk', USER)!;
    expect(row('kashk')).toMatchObject({ status: 'pending', defaultUnit: null });
    expect(view(true).unchecked[0].categoryId).toBe(SORTING_CATEGORY_ID);
    expect(sections(true)).toEqual([['Sorting...', ['kashk']]]);
    await categorizePending(added.pendingNames);
    expect(invoke).toHaveBeenCalledWith('categorize-ingredients', { body: { names: ['kashk'] } });
  });

  test('a not_entitled answer counts as no categorize and refreshes the store', async () => {
    addItem(listId, 'kashk', USER);
    invoke.mockResolvedValue(notEntitled());
    respondToRpc('my_features', { data: [] });
    await categorizePending(['kashk']);
    expect(rpcCallsFor('my_features')).toHaveLength(2);
    expect(hasFeature('categorize')).toBe(false);
    expect(row('kashk')).toMatchObject({ status: 'pending', defaultCategoryId: null });
    // Nothing more is sent until the plan has categorize again.
    await categorizePending();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("a not_entitled answer drops categorize even when the reload can't run", async () => {
    addItem(listId, 'kashk', USER);
    invoke.mockResolvedValue(notEntitled());
    respondToRpc('my_features', { data: null, error: { message: 'Network request failed' } });
    await categorizePending(['kashk']);
    expect(hasFeature('categorize')).toBe(false);
  });

  test('other errors leave the plan alone', async () => {
    addItem(listId, 'kashk', USER);
    invoke.mockResolvedValue({
      data: null,
      error: { context: { status: 429, json: () => Promise.resolve({ error: 'rate_limited', message: 'Slow down' }) } },
    });
    await categorizePending(['kashk']);
    expect(hasFeature('categorize')).toBe(true);
    expect(rpcCallsFor('my_features')).toHaveLength(1);
  });
});

describe('isNotEntitled', () => {
  const error = (status: number, json?: () => Promise<unknown>) => ({ context: { status, json } });

  test('the not_entitled body, or a bare 403', async () => {
    expect(await isNotEntitled(notEntitled().error)).toBe(true);
    expect(await isNotEntitled(error(403, () => Promise.reject(new SyntaxError('not JSON'))))).toBe(true);
    expect(await isNotEntitled(error(403))).toBe(true);
  });

  test('any other code or status is not', async () => {
    expect(await isNotEntitled(error(429, () => Promise.resolve({ error: 'rate_limited' })))).toBe(false);
    expect(await isNotEntitled(error(403, () => Promise.resolve({ error: 'forbidden' })))).toBe(false);
    expect(await isNotEntitled(error(500, () => Promise.reject(new SyntaxError('not JSON'))))).toBe(false);
    expect(await isNotEntitled(new TypeError('Network request failed'))).toBe(false);
    expect(await isNotEntitled(null)).toBe(false);
  });
});
