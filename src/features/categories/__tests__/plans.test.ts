// Categorizing on every plan (spec 4.12): categorize isn't a plan feature, so a user whose
// households are all on free still sends new names, which show as Sorting... until answered.
// A refused request leaves the names pending for the catch-up and the plan store alone.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, ingredients, lists } from '@/db';
import { groupByCategory, SORTING_CATEGORY_ID } from '@/domain/category-resolver';
import { usualUnitsByKey } from '@/domain/usual-unit';
import { addItem, groupItems, listItemsQuery, usualUnitsQuery } from '@/features/lists/items';
import { ensureStarterData, getDefaultListId } from '@/features/lists/lists';
import { getHouseholdFeatures } from '@/features/plans/features';
import { clearFeatures, startFeatures } from '@/features/plans/load';
import { SYSTEM_CATEGORIES } from '@/shared';
import { resetDb } from '@/test/db';
import { seedCatalog } from '@/test/seed';
import { makeSession, respondToRpc, resetSupabase, rpcCallsFor, supabase } from '@/test/fake-supabase';

import { ensureMissingIngredients, getOrderedCategories } from '../categories';
import { categorizePending } from '../categorization';

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

const household = () => db.select({ id: lists.householdId }).from(lists).where(eq(lists.id, listId)).get()!.id;

/** Signs the store in with every household on free: no plan features at all. */
async function onFree() {
  respondToRpc('my_household_features', { data: { households: { [household()]: [] } } });
  stopFeatures = startFeatures(USER);
  await flush();
  expect(getHouseholdFeatures()).toEqual({ [household()]: [] });
}

/** A function error, as `functions.invoke` reports it. */
function answered(status: number, body: object) {
  return { data: null, error: { name: 'FunctionsHttpError', context: { status, json: () => Promise.resolve(body) } } };
}

const row = (name: string) => db.select().from(ingredients).where(eq(ingredients.normalizedName, name)).get();
const view = () => groupItems(listItemsQuery(listId).all(), usualUnitsByKey(usualUnitsQuery(listId).all()));
const sections = () =>
  groupByCategory(getOrderedCategories(USER, household()), view().unchecked).map((s) => [
    s.category.name,
    s.items.map((i) => i.displayName),
  ]);

beforeEach(async () => {
  resetDb();
  resetSupabase();
  clearFeatures();
  seedCatalog();
  ensureStarterData(USER);
  listId = getDefaultListId(USER)!;
  supabase.auth.getSession.mockResolvedValue({ data: { session: makeSession(USER) }, error: null });
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await onFree();
});

afterEach(() => {
  stopFeatures?.();
  stopFeatures = null;
  warn.mockRestore();
});

describe('a user on free (no plan features)', () => {
  test('a new name shows as Sorting... with no default unit, and is sent', async () => {
    const added = addItem(listId, 'kashk', USER)!;
    expect(row('kashk')).toMatchObject({ status: 'pending', defaultUnit: null });
    expect(view().unchecked[0].categoryId).toBe(SORTING_CATEGORY_ID);
    expect(sections()).toEqual([['Sorting...', ['kashk']]]);
    await categorizePending(added.pendingNames);
    expect(invoke).toHaveBeenCalledWith('categorize-ingredients', { body: { names: ['kashk'] } });
  });

  test('the catch-up sends the pending names and applies the answer', async () => {
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
    await categorizePending();
    expect(invoke).toHaveBeenCalledWith('categorize-ingredients', { body: { names: ['kashk', 'mahleb'] } });
    expect(row('kashk')).toMatchObject({ status: 'categorized', defaultCategoryId: SPICES, defaultUnit: 'jar' });
  });

  test('a name pulled in from a household-mate is recorded pending with no default unit', () => {
    // An item whose name the device has no ingredient row for, as a pull leaves it.
    addItem(listId, 'yuzu kosho', USER);
    db.delete(ingredients).where(eq(ingredients.normalizedName, 'yuzu kosho')).run();
    ensureMissingIngredients();
    expect(row('yuzu kosho')).toMatchObject({ status: 'pending', defaultUnit: null });
    expect(view().unchecked[0].categoryId).toBe(SORTING_CATEGORY_ID);
  });

  test("an older server's not_entitled leaves the names pending and the plan store alone", async () => {
    addItem(listId, 'kashk', USER);
    invoke.mockResolvedValue(answered(403, { error: 'not_entitled', message: "Your plan doesn't include categorize" }));
    await categorizePending(['kashk']);
    expect(row('kashk')).toMatchObject({ status: 'pending', defaultCategoryId: null });
    expect(rpcCallsFor('my_household_features')).toHaveLength(1);
    // The next catch-up still sends.
    await categorizePending();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  test.each(['rate_limited', 'daily_limit', 'limit_reached'])(
    '%s leaves the names pending for a later catch-up, and the plan store alone',
    async (code) => {
      addItem(listId, 'kashk', USER);
      invoke.mockResolvedValue(answered(429, { error: code, message: 'Limit', resets_at: '2026-10-22T00:00:00.000Z' }));
      await categorizePending(['kashk']);
      expect(row('kashk')).toMatchObject({ status: 'pending', defaultCategoryId: null });
      expect(rpcCallsFor('my_household_features')).toHaveLength(1);
      await categorizePending();
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(invoke).toHaveBeenLastCalledWith('categorize-ingredients', { body: { names: ['kashk'] } });
    },
  );
});
