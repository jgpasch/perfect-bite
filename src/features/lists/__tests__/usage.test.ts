import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import {
  db,
  deviceSettings,
  households,
  ingredientUnitUsage,
  ingredientUsage,
  listItemContributions,
  listItems,
  lists,
  recipeIngredients,
  recipes,
} from '@/db';
import { addRecipeToList, buildRecipeAdds } from '@/features/recipes/add-to-list';
import { addParsedRecipeIngredients, addRecipeIngredient, recipeIngredientsQuery } from '@/features/recipes/recipes';
import { resetDb } from '@/test/db';

import { addItem, addItemsBulk, undoAdd } from '../items';
import { backfillUnitUsage, backfillUsage, hideFromSuggestions, recordUsage, unrecordUsage } from '../usage';

jest.mock('@/db/client', () => require('@/test/db'));

const T1 = new Date('2026-10-01T12:00:00Z');
const T2 = new Date('2026-10-05T08:30:00Z');

beforeEach(() => {
  resetDb();
  db.insert(households).values([
    { id: 'h1', name: 'Home' },
    { id: 'h2', name: 'Cabin' },
  ]).run();
});

const record = (householdId: string, key: string, display: string, at: Date) =>
  db.transaction((tx) => recordUsage(tx, householdId, key, display, at));
const unrecord = (householdId: string, key: string) =>
  db.transaction((tx) => unrecordUsage(tx, householdId, key));
const usage = (householdId = 'h1') =>
  db
    .select({
      ingredientName: ingredientUsage.ingredientName,
      displayName: ingredientUsage.displayName,
      useCount: ingredientUsage.useCount,
      lastUsedAt: ingredientUsage.lastUsedAt,
      hiddenAt: ingredientUsage.hiddenAt,
    })
    .from(ingredientUsage)
    .where(eq(ingredientUsage.householdId, householdId))
    .all();

test('first use creates a row with count 1', () => {
  record('h1', 'chicken thigh', 'chicken thighs', T1);
  expect(usage()).toEqual([
    { ingredientName: 'chicken thigh', displayName: 'chicken thighs', useCount: 1, lastUsedAt: T1, hiddenAt: null },
  ]);
});

test('second use increments the count and updates display name and time', () => {
  record('h1', 'chicken thigh', 'chicken thighs', T1);
  record('h1', 'chicken thigh', 'Chicken Thigh', T2);
  expect(usage()).toEqual([
    { ingredientName: 'chicken thigh', displayName: 'Chicken Thigh', useCount: 2, lastUsedAt: T2, hiddenAt: null },
  ]);
});

test('uses are counted per household', () => {
  record('h1', 'milk', 'milk', T1);
  record('h1', 'milk', 'milk', T1);
  record('h2', 'milk', 'oat milk', T2);
  expect(usage('h1')).toEqual([expect.objectContaining({ displayName: 'milk', useCount: 2 })]);
  expect(usage('h2')).toEqual([expect.objectContaining({ displayName: 'oat milk', useCount: 1 })]);
});

test('unrecord decrements the count', () => {
  record('h1', 'milk', 'milk', T1);
  record('h1', 'milk', 'milk', T1);
  record('h1', 'milk', 'milk', T2);
  unrecord('h1', 'milk');
  expect(usage()).toEqual([expect.objectContaining({ ingredientName: 'milk', useCount: 2 })]);
});

test('unrecord at count 1 deletes the row', () => {
  record('h1', 'milk', 'milk', T1);
  record('h1', 'egg', 'eggs', T1);
  unrecord('h1', 'milk');
  expect(usage().map((r) => r.ingredientName)).toEqual(['egg']);
});

test('unrecord on a missing row is a no-op', () => {
  record('h1', 'egg', 'eggs', T1);
  expect(() => unrecord('h1', 'milk')).not.toThrow();
  expect(() => unrecord('h2', 'egg')).not.toThrow();
  expect(usage()).toEqual([expect.objectContaining({ ingredientName: 'egg', useCount: 1 })]);
  expect(usage('h2')).toEqual([]);
});

test('a count already at 0 never goes negative; the row is removed', () => {
  db.insert(ingredientUsage)
    .values({ householdId: 'h1', ingredientName: 'milk', displayName: 'milk', useCount: 0, lastUsedAt: T1 })
    .run();
  unrecord('h1', 'milk');
  expect(usage()).toEqual([]);
});

test('a hidden row is unhidden by a new use', () => {
  record('h1', 'milk', 'milk', T1);
  db.update(ingredientUsage).set({ hiddenAt: T1 }).where(eq(ingredientUsage.ingredientName, 'milk')).run();
  expect(usage()[0].hiddenAt).toEqual(T1);

  record('h1', 'milk', 'whole milk', T2);
  expect(usage()).toEqual([
    { ingredientName: 'milk', displayName: 'whole milk', useCount: 2, lastUsedAt: T2, hiddenAt: null },
  ]);
});

test('writes roll back with the surrounding transaction', () => {
  expect(() =>
    db.transaction((tx) => {
      recordUsage(tx, 'h1', 'milk', 'milk', T1);
      throw new Error('add failed');
    }),
  ).toThrow('add failed');
  expect(usage()).toEqual([]);
});

describe('unit usage', () => {
  const T3 = new Date('2026-10-07T18:00:00Z');
  const LB = { quantity: 2, unit: 'lb' } as const;

  const units = (householdId = 'h1') =>
    db
      .select({
        ingredientName: ingredientUnitUsage.ingredientName,
        unitKey: ingredientUnitUsage.unitKey,
        useCount: ingredientUnitUsage.useCount,
        lastUsedAt: ingredientUnitUsage.lastUsedAt,
      })
      .from(ingredientUnitUsage)
      .where(eq(ingredientUnitUsage.householdId, householdId))
      .all()
      .sort((a, b) => a.ingredientName.localeCompare(b.ingredientName) || a.unitKey.localeCompare(b.unitKey));

  beforeEach(() => {
    db.insert(lists).values([
      { id: 'l1', householdId: 'h1', name: 'Groceries', position: 1 },
      { id: 'l2', householdId: 'h2', name: 'Cabin', position: 1 },
    ]).run();
    db.insert(recipes).values({ id: 'r1', householdId: 'h1', name: 'Curry' }).run();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('recordUsage with a quantity counts its unit; a bare number counts as count', () => {
    db.transaction((tx) => {
      recordUsage(tx, 'h1', 'chicken thigh', 'chicken thighs', T1, LB);
      recordUsage(tx, 'h1', 'egg', 'eggs', T2, { quantity: 6, unit: null });
    });
    expect(units()).toEqual([
      { ingredientName: 'chicken thigh', unitKey: 'lb', useCount: 1, lastUsedAt: T1 },
      { ingredientName: 'egg', unitKey: 'count', useCount: 1, lastUsedAt: T2 },
    ]);
  });

  test('recordUsage with no amount, or no quantity, writes no unit row', () => {
    db.transaction((tx) => {
      recordUsage(tx, 'h1', 'milk', 'milk', T1);
      recordUsage(tx, 'h1', 'milk', 'milk', T1, { quantity: null, unit: null });
      recordUsage(tx, 'h1', 'milk', 'milk', T1, { quantity: null, unit: 'gal' });
    });
    expect(units()).toEqual([]);
    expect(usage()).toEqual([expect.objectContaining({ ingredientName: 'milk', useCount: 3 })]);
  });

  test('2 lb, then 1 lb, then 3 gives lb ×2 and count ×1, each with its last use', () => {
    jest.useFakeTimers({ now: T1 });
    addItem('l1', '2 lbs chicken thighs', null);
    jest.setSystemTime(T2);
    addItem('l1', '1 lb chicken thighs', null);
    jest.setSystemTime(T3);
    addItem('l1', '3 chicken thighs', null);
    expect(units()).toEqual([
      { ingredientName: 'chicken thigh', unitKey: 'count', useCount: 1, lastUsedAt: T3 },
      { ingredientName: 'chicken thigh', unitKey: 'lb', useCount: 2, lastUsedAt: T2 },
    ]);
  });

  test('milk with no amount writes no unit row', () => {
    addItem('l1', 'milk', null);
    addItem('l1', 'milk', null);
    expect(units()).toEqual([]);
    expect(usage()).toEqual([expect.objectContaining({ ingredientName: 'milk', useCount: 2 })]);
  });

  test('undo decrements the unit, and deletes its row at 0', () => {
    jest.useFakeTimers({ now: T1 });
    addItem('l1', '2 lb chicken thighs', null);
    const second = addItem('l1', '1 lb chicken thighs', null)!;
    const count = addItem('l1', '3 chicken thighs', null)!;
    undoAdd(second);
    expect(units()).toEqual([
      { ingredientName: 'chicken thigh', unitKey: 'count', useCount: 1, lastUsedAt: T1 },
      { ingredientName: 'chicken thigh', unitKey: 'lb', useCount: 1, lastUsedAt: T1 },
    ]);
    undoAdd(count);
    expect(units()).toEqual([{ ingredientName: 'chicken thigh', unitKey: 'lb', useCount: 1, lastUsedAt: T1 }]);
  });

  test('undoing an add with no amount leaves the unit rows alone', () => {
    addItem('l1', '1 gal milk', null);
    undoAdd(addItem('l1', 'milk', null)!);
    expect(units()).toEqual([expect.objectContaining({ ingredientName: 'milk', unitKey: 'gal', useCount: 1 })]);
    expect(usage()).toEqual([expect.objectContaining({ ingredientName: 'milk', useCount: 1 })]);
  });

  test('undoing a new item and a reopen take their units back too', () => {
    undoAdd(addItem('l1', '2 lb beef', null)!);
    expect(units()).toEqual([]);

    const first = addItem('l1', '2 lb beef', null)!;
    db.update(listItems).set({ checkedAt: T1 }).where(eq(listItems.id, first.itemId)).run();
    const reopen = addItem('l1', '500 g beef', null)!;
    expect(reopen.kind).toBe('reopen');
    expect(units().map((u) => [u.unitKey, u.useCount])).toEqual([['g', 1], ['lb', 1]]);
    undoAdd(reopen);
    expect(units().map((u) => [u.unitKey, u.useCount])).toEqual([['lb', 1]]);
  });

  test('unrecord on a missing unit row is a no-op, and a count at 0 is removed', () => {
    expect(() => db.transaction((tx) => unrecordUsage(tx, 'h1', 'milk', { quantity: 1, unit: 'gal' }))).not.toThrow();
    db.insert(ingredientUnitUsage)
      .values({ householdId: 'h1', ingredientName: 'milk', unitKey: 'gal', useCount: 0, lastUsedAt: T1 })
      .run();
    db.transaction((tx) => unrecordUsage(tx, 'h1', 'milk', { quantity: 1, unit: 'gal' }));
    expect(units()).toEqual([]);
  });

  test('a recipe link with no amount records a use but no unit', () => {
    addItem('l1', '2 lb ground beef', null);
    addItemsBulk('l1', [{ text: 'ground beef', source: 'recipe', recipeId: 'r1' }], null);
    expect(usage()).toEqual([expect.objectContaining({ ingredientName: 'ground beef', useCount: 2 })]);
    expect(units()).toEqual([expect.objectContaining({ ingredientName: 'ground beef', unitKey: 'lb', useCount: 1 })]);
  });

  test('a recipe ingredient records its unit, and adding the recipe to a list counts it again', () => {
    jest.useFakeTimers({ now: T1 });
    addRecipeIngredient('r1', '400 g chickpeas');
    expect(units()).toEqual([{ ingredientName: 'chickpea', unitKey: 'g', useCount: 1, lastUsedAt: T1 }]);

    jest.setSystemTime(T2);
    const ingredients = recipeIngredientsQuery('r1').all();
    const adds = buildRecipeAdds('r1', ingredients, new Set(ingredients.map((i) => i.id)), 1);
    addRecipeToList('l1', adds, null);
    expect(units()).toEqual([{ ingredientName: 'chickpea', unitKey: 'g', useCount: 2, lastUsedAt: T2 }]);
  });

  test('a recipe ingredient with no amount records no unit', () => {
    addRecipeIngredient('r1', 'salt');
    expect(units()).toEqual([]);
  });

  test('parsed recipe ingredients record their units, and none for no quantity', () => {
    jest.useFakeTimers({ now: T2 });
    addParsedRecipeIngredients('r1', [
      { ingredientName: 'flour', displayName: 'flour', quantity: 2, unit: 'cup' },
      { ingredientName: 'egg', displayName: 'eggs', quantity: 3, unit: null },
      { ingredientName: 'salt', displayName: 'salt', quantity: null, unit: null },
    ]);
    expect(units()).toEqual([
      { ingredientName: 'egg', unitKey: 'count', useCount: 1, lastUsedAt: T2 },
      { ingredientName: 'flour', unitKey: 'cup', useCount: 1, lastUsedAt: T2 },
    ]);
  });

  test("another household's rows are untouched", () => {
    db.insert(ingredientUnitUsage)
      .values({ householdId: 'h2', ingredientName: 'milk', unitKey: 'gal', useCount: 4, lastUsedAt: T1 })
      .run();
    addItem('l1', '1 gal milk', null);
    undoAdd(addItem('l1', '2 gal milk', null)!);
    addRecipeIngredient('r1', '1 cup milk');
    expect(units('h2')).toEqual([{ ingredientName: 'milk', unitKey: 'gal', useCount: 4, lastUsedAt: T1 }]);
    expect(units('h1').map((u) => [u.unitKey, u.useCount])).toEqual([['cup', 1], ['gal', 1]]);

    addItem('l2', '2 gal milk', null);
    expect(units('h2')).toEqual([expect.objectContaining({ unitKey: 'gal', useCount: 5 })]);
    expect(units('h1').map((u) => [u.unitKey, u.useCount])).toEqual([['cup', 1], ['gal', 1]]);
  });
});

describe('hideFromSuggestions (spec 4.2)', () => {
  test('sets hidden_at and keeps the count, name and time', () => {
    record('h1', 'milk', 'milk', T1);
    record('h1', 'milk', 'whole milk', T1);
    hideFromSuggestions('h1', 'milk', T2);
    expect(usage()).toEqual([
      { ingredientName: 'milk', displayName: 'whole milk', useCount: 2, lastUsedAt: T1, hiddenAt: T2 },
    ]);
  });

  test('only hides that household and key', () => {
    record('h1', 'milk', 'milk', T1);
    record('h1', 'egg', 'eggs', T1);
    record('h2', 'milk', 'milk', T1);
    hideFromSuggestions('h1', 'milk', T2);
    expect(usage().find((r) => r.ingredientName === 'egg')!.hiddenAt).toBeNull();
    expect(usage().find((r) => r.ingredientName === 'milk')!.hiddenAt).toEqual(T2);
    expect(usage('h2')[0].hiddenAt).toBeNull();
  });

  test('a missing row is a no-op and creates nothing', () => {
    expect(() => hideFromSuggestions('h1', 'milk', T2)).not.toThrow();
    expect(usage()).toEqual([]);
  });

  test('a new use unhides it', () => {
    record('h1', 'milk', 'milk', T1);
    hideFromSuggestions('h1', 'milk', T1);
    record('h1', 'milk', 'milk', T2);
    expect(usage()).toEqual([
      { ingredientName: 'milk', displayName: 'milk', useCount: 2, lastUsedAt: T2, hiddenAt: null },
    ]);
  });

  test('defaults hidden_at to now', () => {
    record('h1', 'milk', 'milk', T1);
    const before = Date.now();
    hideFromSuggestions('h1', 'milk');
    const hiddenAt = usage()[0].hiddenAt!.getTime();
    expect(hiddenAt).toBeGreaterThanOrEqual(before);
    expect(hiddenAt).toBeLessThanOrEqual(Date.now());
  });
});

describe('backfillUsage', () => {
  const T3 = new Date('2026-10-07T18:00:00Z');

  // Data written before ingredient_usage existed: rows inserted directly, so nothing is counted yet.
  beforeEach(() => {
    db.insert(lists).values([
      { id: 'l1', householdId: 'h1', name: 'Groceries', position: 1 },
      { id: 'l2', householdId: 'h2', name: 'Cabin', position: 1 },
    ]).run();
    db.insert(listItems).values([
      // Checked off and re-added: two contributions on one item.
      { id: 'i1', listId: 'l1', householdId: 'h1', ingredientName: 'chicken thigh', displayName: 'chicken thighs', createdAt: T1 },
      // Deleted later: still history.
      { id: 'i2', listId: 'l1', householdId: 'h1', ingredientName: 'milk', displayName: 'milk', createdAt: T1, deletedAt: T2 },
      // An undone add: item and contribution both deleted.
      { id: 'i3', listId: 'l1', householdId: 'h1', ingredientName: 'chickn', displayName: 'chickn', createdAt: T2, deletedAt: T2 },
      { id: 'i4', listId: 'l2', householdId: 'h2', ingredientName: 'milk', displayName: 'oat milk', createdAt: T3 },
    ]).run();
    db.insert(listItemContributions).values([
      { id: 'c1', listItemId: 'i1', householdId: 'h1', createdAt: T1 },
      { id: 'c2', listItemId: 'i1', householdId: 'h1', createdAt: T2 },
      { id: 'c3', listItemId: 'i2', householdId: 'h1', createdAt: T1 },
      { id: 'c4', listItemId: 'i3', householdId: 'h1', createdAt: T2, deletedAt: T2 },
      { id: 'c5', listItemId: 'i4', householdId: 'h2', createdAt: T3 },
    ]).run();
    db.insert(recipes).values({ id: 'r1', householdId: 'h1', name: 'Curry' }).run();
    db.insert(recipeIngredients).values([
      // Latest use of chicken thigh: its text wins.
      { id: 'ri1', recipeId: 'r1', householdId: 'h1', ingredientName: 'chicken thigh', displayName: 'Chicken Thighs', position: 1, createdAt: T3 },
      { id: 'ri2', recipeId: 'r1', householdId: 'h1', ingredientName: 'coconut milk', displayName: 'coconut milk', position: 2, createdAt: T2 },
      // Deleted recipe ingredient: not counted.
      { id: 'ri3', recipeId: 'r1', householdId: 'h1', ingredientName: 'lime', displayName: 'lime', position: 3, createdAt: T2, deletedAt: T3 },
    ]).run();
  });

  const EXPECTED_H1 = [
    { ingredientName: 'chicken thigh', displayName: 'Chicken Thighs', useCount: 3, lastUsedAt: T3, hiddenAt: null },
    { ingredientName: 'coconut milk', displayName: 'coconut milk', useCount: 1, lastUsedAt: T2, hiddenAt: null },
    { ingredientName: 'milk', displayName: 'milk', useCount: 1, lastUsedAt: T1, hiddenAt: null },
  ];
  const sorted = (householdId?: string) =>
    usage(householdId).sort((a, b) => a.ingredientName.localeCompare(b.ingredientName));

  test('builds history from contributions and recipe ingredients, per household', () => {
    backfillUsage();
    expect(sorted('h1')).toEqual(EXPECTED_H1);
    expect(sorted('h2')).toEqual([
      { ingredientName: 'milk', displayName: 'oat milk', useCount: 1, lastUsedAt: T3, hiddenAt: null },
    ]);
  });

  test('running it twice changes nothing', () => {
    backfillUsage();
    backfillUsage();
    expect(sorted('h1')).toEqual(EXPECTED_H1);
    expect(sorted('h2')).toEqual([expect.objectContaining({ ingredientName: 'milk', useCount: 1 })]);
  });

  test('runs once per device: uses recorded after it are not counted again', () => {
    backfillUsage();
    record('h1', 'milk', 'milk', T3);
    backfillUsage();
    expect(sorted('h1').find((r) => r.ingredientName === 'milk')).toEqual(
      expect.objectContaining({ useCount: 2, lastUsedAt: T3 }),
    );
  });

  test('never overwrites a row that already exists, even without the device setting', () => {
    record('h1', 'chicken thigh', 'thighs', T1);
    db.update(ingredientUsage).set({ hiddenAt: T2 }).where(eq(ingredientUsage.ingredientName, 'chicken thigh')).run();
    backfillUsage();
    db.delete(deviceSettings).run();
    backfillUsage();
    expect(sorted('h1')).toEqual([
      { ingredientName: 'chicken thigh', displayName: 'thighs', useCount: 1, lastUsedAt: T1, hiddenAt: T2 },
      EXPECTED_H1[1],
      EXPECTED_H1[2],
    ]);
  });

  test('an add undone through the app is not counted', () => {
    resetDb();
    db.insert(households).values({ id: 'h1', name: 'Home' }).run();
    db.insert(lists).values({ id: 'l1', householdId: 'h1', name: 'Groceries', position: 1 }).run();
    addItem('l1', 'eggs', null);
    undoAdd(addItem('l1', 'chickn', null)!);
    db.delete(ingredientUsage).run(); // as on an install from before history existed
    backfillUsage();
    expect(usage().map((r) => [r.ingredientName, r.useCount])).toEqual([['egg', 1]]);
  });

  test('does nothing when there is no data', () => {
    resetDb();
    backfillUsage();
    expect(db.select().from(ingredientUsage).all()).toEqual([]);
  });
});

describe('backfillUnitUsage', () => {
  const T3 = new Date('2026-10-07T18:00:00Z');

  const units = (householdId = 'h1') =>
    db
      .select({
        ingredientName: ingredientUnitUsage.ingredientName,
        unitKey: ingredientUnitUsage.unitKey,
        useCount: ingredientUnitUsage.useCount,
        lastUsedAt: ingredientUnitUsage.lastUsedAt,
      })
      .from(ingredientUnitUsage)
      .where(eq(ingredientUnitUsage.householdId, householdId))
      .all()
      .sort((a, b) => a.ingredientName.localeCompare(b.ingredientName) || a.unitKey.localeCompare(b.unitKey));

  // Data written before ingredient_unit_usage existed: rows inserted directly, so no units counted.
  beforeEach(() => {
    db.insert(lists).values([
      { id: 'l1', householdId: 'h1', name: 'Groceries', position: 1 },
      { id: 'l2', householdId: 'h2', name: 'Cabin', position: 1 },
    ]).run();
    db.insert(listItems).values([
      { id: 'i1', listId: 'l1', householdId: 'h1', ingredientName: 'milk', displayName: 'milk', createdAt: T1 },
      // Deleted later: its contributions are still history.
      { id: 'i2', listId: 'l1', householdId: 'h1', ingredientName: 'chicken thigh', displayName: 'chicken thighs', createdAt: T1, deletedAt: T3 },
      { id: 'i3', listId: 'l2', householdId: 'h2', ingredientName: 'milk', displayName: 'milk', createdAt: T3 },
      { id: 'i4', listId: 'l1', householdId: 'h1', ingredientName: 'eggs', displayName: 'eggs', createdAt: T1 },
    ]).run();
    db.insert(listItemContributions).values([
      { id: 'c1', listItemId: 'i1', householdId: 'h1', quantity: 1, unit: 'gal', createdAt: T2 },
      { id: 'c2', listItemId: 'i1', householdId: 'h1', quantity: 1, unit: 'gal', createdAt: T1 },
      // A bare number counts as 'count'.
      { id: 'c3', listItemId: 'i1', householdId: 'h1', quantity: 2, unit: null, createdAt: T1 },
      // No quantity: no unit.
      { id: 'c4', listItemId: 'i1', householdId: 'h1', quantity: null, unit: null, createdAt: T3 },
      { id: 'c5', listItemId: 'i2', householdId: 'h1', quantity: 2, unit: 'lb', createdAt: T1 },
      // Deleted contribution (an undone add): not counted.
      { id: 'c6', listItemId: 'i2', householdId: 'h1', quantity: 8, unit: 'oz', createdAt: T3, deletedAt: T3 },
      { id: 'c7', listItemId: 'i3', householdId: 'h2', quantity: 1, unit: 'l', createdAt: T3 },
      // An ingredient seen only without a quantity gets no rows.
      { id: 'c8', listItemId: 'i4', householdId: 'h1', quantity: null, unit: null, createdAt: T1 },
    ]).run();
    db.insert(recipes).values({ id: 'r1', householdId: 'h1', name: 'Curry' }).run();
    db.insert(recipeIngredients).values([
      { id: 'ri1', recipeId: 'r1', householdId: 'h1', ingredientName: 'chicken thigh', displayName: 'chicken thighs', quantity: 1.5, unit: 'lb', position: 1, createdAt: T3 },
      { id: 'ri2', recipeId: 'r1', householdId: 'h1', ingredientName: 'coconut milk', displayName: 'coconut milk', quantity: 1, unit: 'can', position: 2, createdAt: T2 },
      // Deleted recipe ingredient: not counted.
      { id: 'ri3', recipeId: 'r1', householdId: 'h1', ingredientName: 'coconut milk', displayName: 'coconut milk', quantity: 400, unit: 'ml', position: 3, createdAt: T3, deletedAt: T3 },
      // No quantity: not counted.
      { id: 'ri4', recipeId: 'r1', householdId: 'h1', ingredientName: 'lime', displayName: 'lime', quantity: null, unit: null, position: 4, createdAt: T2 },
    ]).run();
  });

  const EXPECTED_H1 = [
    { ingredientName: 'chicken thigh', unitKey: 'lb', useCount: 2, lastUsedAt: T3 },
    { ingredientName: 'coconut milk', unitKey: 'can', useCount: 1, lastUsedAt: T2 },
    { ingredientName: 'milk', unitKey: 'count', useCount: 1, lastUsedAt: T1 },
    { ingredientName: 'milk', unitKey: 'gal', useCount: 2, lastUsedAt: T2 },
  ];
  const EXPECTED_H2 = [{ ingredientName: 'milk', unitKey: 'l', useCount: 1, lastUsedAt: T3 }];

  test('builds unit rows from contributions and recipe ingredients with a quantity, per household', () => {
    backfillUnitUsage();
    expect(units('h1')).toEqual(EXPECTED_H1);
    expect(units('h2')).toEqual(EXPECTED_H2);
  });

  test('does not touch ingredient_usage', () => {
    backfillUnitUsage();
    expect(db.select().from(ingredientUsage).all()).toEqual([]);
  });

  test('running it twice changes nothing', () => {
    backfillUnitUsage();
    backfillUnitUsage();
    expect(units('h1')).toEqual(EXPECTED_H1);
    expect(units('h2')).toEqual(EXPECTED_H2);
  });

  test('runs once per device: units recorded after it are not counted again', () => {
    backfillUnitUsage();
    db.transaction((tx) => recordUsage(tx, 'h1', 'milk', 'milk', T3, { quantity: 1, unit: 'gal' }));
    backfillUnitUsage();
    expect(units('h1').find((r) => r.ingredientName === 'milk' && r.unitKey === 'gal')).toEqual(
      { ingredientName: 'milk', unitKey: 'gal', useCount: 3, lastUsedAt: T3 },
    );
  });

  test('keeps an ingredient whose units were already recorded as is, even without the device setting', () => {
    db.transaction((tx) => recordUsage(tx, 'h1', 'milk', 'milk', T3, { quantity: 2, unit: 'l' }));
    backfillUnitUsage();
    db.delete(deviceSettings).run();
    backfillUnitUsage();
    expect(units('h1')).toEqual([
      EXPECTED_H1[0],
      EXPECTED_H1[1],
      { ingredientName: 'milk', unitKey: 'l', useCount: 1, lastUsedAt: T3 },
    ]);
    // The same ingredient in another household is still backfilled.
    expect(units('h2')).toEqual(EXPECTED_H2);
  });

  test('is independent of the usage.backfilled setting', () => {
    backfillUsage();
    backfillUnitUsage();
    expect(units('h1')).toEqual(EXPECTED_H1);
  });

  test('does nothing when there is no data', () => {
    resetDb();
    backfillUnitUsage();
    expect(db.select().from(ingredientUnitUsage).all()).toEqual([]);
  });
});
