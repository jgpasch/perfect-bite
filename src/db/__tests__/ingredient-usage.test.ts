import { beforeEach, expect, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { households, ingredientUsage } from '@/db/schema';
import { db, resetDb } from '@/test/db';

beforeEach(() => {
  resetDb();
  db.insert(households).values([
    { id: 'h1', name: 'Home' },
    { id: 'h2', name: 'Cabin' },
  ]).run();
});

test('inserts a row and reads it back with defaults', () => {
  const lastUsedAt = new Date('2026-10-01T12:00:00Z');
  db.insert(ingredientUsage)
    .values({ householdId: 'h1', ingredientName: 'chicken thigh', displayName: 'Chicken thighs', lastUsedAt })
    .run();

  const rows = db.select().from(ingredientUsage).where(eq(ingredientUsage.householdId, 'h1')).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    householdId: 'h1',
    ingredientName: 'chicken thigh',
    displayName: 'Chicken thighs',
    useCount: 0,
    lastUsedAt,
    hiddenAt: null,
  });
  expect(rows[0].createdAt).toBeInstanceOf(Date);
  expect(rows[0].updatedAt).toBeInstanceOf(Date);
});

test('the primary key rejects a duplicate (household, ingredient) pair', () => {
  const row = { householdId: 'h1', ingredientName: 'milk', displayName: 'milk', lastUsedAt: new Date() };
  db.insert(ingredientUsage).values(row).run();
  expect(() => db.insert(ingredientUsage).values({ ...row, displayName: 'Milk' }).run()).toThrow(
    /UNIQUE constraint failed/,
  );
  expect(db.select().from(ingredientUsage).all()).toHaveLength(1);
});

test('the same ingredient can exist in two households', () => {
  const lastUsedAt = new Date();
  db.insert(ingredientUsage)
    .values([
      { householdId: 'h1', ingredientName: 'milk', displayName: 'milk', useCount: 3, lastUsedAt },
      { householdId: 'h2', ingredientName: 'milk', displayName: 'oat milk', useCount: 1, lastUsedAt },
    ])
    .run();
  expect(db.select().from(ingredientUsage).all()).toHaveLength(2);
});

test('household_id must reference a household', () => {
  expect(() =>
    db.insert(ingredientUsage)
      .values({ householdId: 'nope', ingredientName: 'milk', displayName: 'milk', lastUsedAt: new Date() })
      .run(),
  ).toThrow(/FOREIGN KEY constraint failed/);
});
