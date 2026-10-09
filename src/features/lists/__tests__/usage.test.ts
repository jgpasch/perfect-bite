import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import {
  db,
  deviceSettings,
  households,
  ingredientUsage,
  listItemContributions,
  listItems,
  lists,
  recipeIngredients,
  recipes,
} from '@/db';
import { resetDb } from '@/test/db';

import { addItem, undoAdd } from '../items';
import { backfillUsage, hideFromSuggestions, recordUsage, unrecordUsage } from '../usage';

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
