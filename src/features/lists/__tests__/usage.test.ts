import { beforeEach, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, households, ingredientUsage } from '@/db';
import { resetDb } from '@/test/db';

import { recordUsage, unrecordUsage } from '../usage';

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
