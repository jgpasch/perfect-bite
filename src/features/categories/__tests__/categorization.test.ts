import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { eq } from 'drizzle-orm';

import { db, householdCategoryOverrides, households, ingredients } from '@/db';
import { OTHER_CATEGORY_ID, SYSTEM_CATEGORIES } from '@/shared';
import { resetDb } from '@/test/db';
import { seedCatalog } from '@/test/seed';
import { makeSession, resetSupabase, setSupabaseConfigured, supabase } from '@/test/fake-supabase';

import { getIngredientCategory, setCategoryOverride } from '../categories';
import { CATEGORIZED_BY_SERVER, categorizePending, catchUpNames, MAX_NAMES_PER_REQUEST } from '../categorization';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));

const id = (slug: string) => SYSTEM_CATEGORIES.find((c) => c.slug === slug)!.id;
const SPICES = id('spices');
const invoke = supabase.functions.invoke;

let warn: ReturnType<typeof jest.spyOn>;

function addLocal(name: string, status: 'pending' | 'failed' | 'categorized' = 'pending', categoryId: string | null = null) {
  db.insert(ingredients)
    .values({ normalizedName: name, displayName: name, status, defaultCategoryId: categoryId })
    .run();
}

const row = (name: string) => db.select().from(ingredients).where(eq(ingredients.normalizedName, name)).get();
const sentNames = (call = 0) => (invoke.mock.calls[call][1] as { body: { names: string[] } }).body.names;

function respond(
  results: Record<string, { status: string; category_id: string | null; is_grocery_item: boolean | null; default_unit?: string | null }>,
) {
  invoke.mockResolvedValue({ data: { results }, error: null });
}

beforeEach(() => {
  resetDb();
  resetSupabase();
  seedCatalog();
  supabase.auth.getSession.mockResolvedValue({ data: { session: makeSession('u1') }, error: null });
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => warn.mockRestore());

describe('explicit names', () => {
  test('sends exactly those names in one request', async () => {
    addLocal("za'atar");
    addLocal('mahleb');
    addLocal('ras el hanout');
    await categorizePending(["za'atar", 'mahleb']);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('categorize-ingredients', { body: { names: ["za'atar", 'mahleb'] } });
  });

  test('an empty list makes no request', async () => {
    addLocal("za'atar");
    await categorizePending([]);
    expect(invoke).not.toHaveBeenCalled();
    expect(supabase.auth.getSession).not.toHaveBeenCalled();
  });

  test('per-add calls are not coalesced', async () => {
    addLocal('a');
    addLocal('b');
    await Promise.all([categorizePending(['a']), categorizePending(['b'])]);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect([sentNames(0), sentNames(1)]).toEqual([['a'], ['b']]);
  });
});

describe('results', () => {
  test('writes category, status, is_grocery_item, categorized_by and default unit', async () => {
    addLocal("za'atar");
    addLocal('call mom');
    respond({
      "za'atar": { status: 'categorized', category_id: SPICES, is_grocery_item: true, default_unit: 'jar' },
      'call mom': { status: 'categorized', category_id: OTHER_CATEGORY_ID, is_grocery_item: false, default_unit: 'count' },
    });
    await categorizePending(["za'atar", 'call mom']);
    expect(row("za'atar")).toEqual({
      normalizedName: "za'atar",
      displayName: "za'atar",
      defaultCategoryId: SPICES,
      status: 'categorized',
      isGroceryItem: true,
      categorizedBy: CATEGORIZED_BY_SERVER,
      defaultUnit: 'jar',
      lang: null,
      sameAs: null,
      linkedBy: null,
    });
    expect(row('call mom')).toMatchObject({ status: 'categorized', defaultCategoryId: OTHER_CATEGORY_ID, isGroceryItem: false });
    expect(warn).not.toHaveBeenCalled();
  });

  test("leaves the household's overrides alone", async () => {
    addLocal("za'atar");
    db.insert(households).values({ id: 'h1', name: 'Home' }).run();
    setCategoryOverride('h1', "za'atar", id('produce'));
    respond({ "za'atar": { status: 'categorized', category_id: SPICES, is_grocery_item: true } });
    await categorizePending(["za'atar"]);
    expect(row("za'atar")!.defaultCategoryId).toBe(SPICES);
    expect(db.select().from(householdCategoryOverrides).all()).toMatchObject([
      { householdId: 'h1', ingredientName: "za'atar", categoryId: id('produce') },
    ]);
    // So the item still shows in the household's aisle, not the new default.
    expect(getIngredientCategory('h1', "za'atar")).toEqual({
      defaultCategoryId: SPICES,
      overrideCategoryId: id('produce'),
      status: 'categorized',
    });
  });

  test('a failed result goes to Other', async () => {
    addLocal('xyzzy');
    respond({ xyzzy: { status: 'failed', category_id: null, is_grocery_item: null } });
    await categorizePending(['xyzzy']);
    expect(row('xyzzy')).toMatchObject({ status: 'failed', defaultCategoryId: OTHER_CATEGORY_ID, categorizedBy: null });
  });

  test('a categorized result with no category goes to Other', async () => {
    addLocal('xyzzy');
    respond({ xyzzy: { status: 'categorized', category_id: null, is_grocery_item: true } });
    await categorizePending(['xyzzy']);
    expect(row('xyzzy')).toMatchObject({ status: 'categorized', defaultCategoryId: OTHER_CATEGORY_ID });
  });

  test('a pending result leaves the row pending', async () => {
    addLocal("za'atar");
    respond({ "za'atar": { status: 'pending', category_id: null, is_grocery_item: null } });
    await categorizePending(["za'atar"]);
    expect(row("za'atar")).toMatchObject({ status: 'pending', defaultCategoryId: null, isGroceryItem: null, categorizedBy: null });
  });

  test("a failed answer doesn't undo a row already categorized locally", async () => {
    respond({ milk: { status: 'failed', category_id: OTHER_CATEGORY_ID, is_grocery_item: null } });
    await categorizePending(['milk']);
    expect(row('milk')).toMatchObject({ status: 'categorized', defaultCategoryId: id('dairy-eggs'), categorizedBy: 'seed' });
  });

  test('answers for names with no local row are ignored', async () => {
    addLocal('mahleb');
    respond({
      mahleb: { status: 'categorized', category_id: SPICES, is_grocery_item: true },
      'not local': { status: 'categorized', category_id: SPICES, is_grocery_item: true },
    });
    await categorizePending(['mahleb']);
    expect(row('not local')).toBeUndefined();
    expect(row('mahleb')!.status).toBe('categorized');
  });

  test('a bad answer rolls back the whole batch', async () => {
    addLocal('a');
    addLocal('b');
    respond({
      a: { status: 'categorized', category_id: SPICES, is_grocery_item: true },
      b: { status: 'categorized', category_id: 'no-such-category', is_grocery_item: true },
    });
    await categorizePending(['a', 'b']);
    expect(row('a')!.status).toBe('pending');
    expect(row('b')!.status).toBe('pending');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('failures', () => {
  test('no session means no request', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    addLocal("za'atar");
    await categorizePending(["za'atar"]);
    await categorizePending();
    expect(invoke).not.toHaveBeenCalled();
    expect(row("za'atar")!.status).toBe('pending');
  });

  test('no Supabase config means no request', async () => {
    setSupabaseConfigured(false);
    addLocal("za'atar");
    await categorizePending(["za'atar"]);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('a network error leaves the rows pending and does not throw', async () => {
    addLocal("za'atar");
    invoke.mockRejectedValue(new TypeError('Network request failed'));
    await expect(categorizePending(["za'atar"])).resolves.toBeUndefined();
    expect(row("za'atar")).toMatchObject({ status: 'pending', defaultCategoryId: null });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('an error response (429, 503) leaves the rows pending', async () => {
    addLocal("za'atar");
    invoke.mockResolvedValue({ data: null, error: new Error('Edge Function returned a non-2xx status code') });
    await categorizePending(["za'atar"]);
    expect(row("za'atar")!.status).toBe('pending');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('a response without results leaves the rows pending', async () => {
    addLocal("za'atar");
    invoke.mockResolvedValue({ data: { nope: true }, error: null });
    await categorizePending(["za'atar"]);
    expect(row("za'atar")!.status).toBe('pending');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('catch-up', () => {
  test('sends pending and failed names but not categorized ones', async () => {
    addLocal('b pending');
    addLocal('a failed', 'failed', OTHER_CATEGORY_ID);
    addLocal('c done', 'categorized', SPICES);
    await categorizePending();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(sentNames()).toEqual(['a failed', 'b pending']);
  });

  test('nothing pending means no request', async () => {
    await categorizePending();
    expect(invoke).not.toHaveBeenCalled();
  });

  test('sends at most 100 names', async () => {
    for (let i = 0; i < 105; i++) addLocal(`zz item ${String(i).padStart(3, '0')}`);
    expect(catchUpNames()).toHaveLength(MAX_NAMES_PER_REQUEST);
    await categorizePending();
    expect(sentNames()).toHaveLength(100);
    expect(sentNames()[0]).toBe('zz item 000');
    expect(sentNames()[99]).toBe('zz item 099');
  });

  test('two concurrent catch-up calls make one request and share the promise', async () => {
    addLocal("za'atar");
    respond({ "za'atar": { status: 'categorized', category_id: SPICES, is_grocery_item: true } });
    const first = categorizePending();
    const second = categorizePending();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(row("za'atar")!.status).toBe('categorized');
  });

  test('a new catch-up run can start once the previous one is done', async () => {
    addLocal("za'atar");
    invoke.mockRejectedValueOnce(new TypeError('Network request failed'));
    await categorizePending();
    respond({ "za'atar": { status: 'categorized', category_id: SPICES, is_grocery_item: true } });
    await categorizePending();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(row("za'atar")!.status).toBe('categorized');
  });

  test('per-add calls run alongside a catch-up run', async () => {
    addLocal('a');
    const run = categorizePending();
    const add = categorizePending(['b']);
    expect(add).not.toBe(run);
    await Promise.all([run, add]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
