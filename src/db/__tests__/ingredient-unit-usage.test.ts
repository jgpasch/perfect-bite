import { beforeEach, expect, test } from '@jest/globals';
import { asc, eq } from 'drizzle-orm';

import { households, ingredientUnitUsage } from '@/db/schema';
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
  db.insert(ingredientUnitUsage)
    .values({ householdId: 'h1', ingredientName: 'milk', unitKey: 'gal', lastUsedAt })
    .run();

  const rows = db.select().from(ingredientUnitUsage).where(eq(ingredientUnitUsage.householdId, 'h1')).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    householdId: 'h1',
    ingredientName: 'milk',
    unitKey: 'gal',
    useCount: 0,
    lastUsedAt,
  });
  expect(rows[0].createdAt).toBeInstanceOf(Date);
  expect(rows[0].updatedAt).toBeInstanceOf(Date);
});

test('the primary key rejects a duplicate (household, ingredient, unit) triple', () => {
  const row = { householdId: 'h1', ingredientName: 'milk', unitKey: 'gal', lastUsedAt: new Date() };
  db.insert(ingredientUnitUsage).values(row).run();
  expect(() => db.insert(ingredientUnitUsage).values({ ...row, useCount: 2 }).run()).toThrow(
    /UNIQUE constraint failed/,
  );
  expect(db.select().from(ingredientUnitUsage).all()).toHaveLength(1);
});

test('one ingredient can have several units, and the same triple can exist in two households', () => {
  const lastUsedAt = new Date('2026-10-01T12:00:00Z');
  db.insert(ingredientUnitUsage)
    .values([
      { householdId: 'h1', ingredientName: 'milk', unitKey: 'gal', useCount: 3, lastUsedAt },
      { householdId: 'h1', ingredientName: 'milk', unitKey: 'count', useCount: 1, lastUsedAt },
      { householdId: 'h2', ingredientName: 'milk', unitKey: 'gal', useCount: 5, lastUsedAt },
    ])
    .run();

  const rows = db
    .select({ h: ingredientUnitUsage.householdId, unit: ingredientUnitUsage.unitKey, n: ingredientUnitUsage.useCount })
    .from(ingredientUnitUsage)
    .orderBy(asc(ingredientUnitUsage.householdId), asc(ingredientUnitUsage.unitKey))
    .all();
  expect(rows).toEqual([
    { h: 'h1', unit: 'count', n: 1 },
    { h: 'h1', unit: 'gal', n: 3 },
    { h: 'h2', unit: 'gal', n: 5 },
  ]);
});

test('household_id must reference a household', () => {
  expect(() =>
    db.insert(ingredientUnitUsage)
      .values({ householdId: 'nope', ingredientName: 'milk', unitKey: 'gal', lastUsedAt: new Date() })
      .run(),
  ).toThrow(/FOREIGN KEY constraint failed/);
});
