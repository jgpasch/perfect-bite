import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { asc, eq } from 'drizzle-orm';

import {
  categories,
  db,
  householdCategoryOverrides,
  households,
  householdStaples,
  ingredients,
  ingredientUnitUsage,
  ingredientUsage,
  listItemContributions,
  listItems,
  lists,
  outbox,
  recipeIngredients,
  recipes,
} from '@/db';
import { getDeviceSetting } from '@/features/settings/device-settings';
import type { Mutation } from '@/sync/mutation';
import { resetDb } from '@/test/db';

import { FOLD_ACCENTS_KEY, foldAccentKeys } from '../fold-accents';

jest.mock('@/db/client', () => require('@/test/db'));

const T1 = new Date('2026-10-01T10:00:00Z');
const T2 = new Date('2026-10-02T10:00:00Z');
const T3 = new Date('2026-10-04T10:00:00Z');
const NOW = new Date('2026-10-14T12:00:00Z');

beforeEach(() => {
  resetDb();
  db.insert(households).values([
    { id: 'h1', name: 'Home' },
    { id: 'h2', name: 'Cabin' },
  ]).run();
  db.insert(categories).values([
    { id: 'produce', slug: 'produce', name: 'Produce' },
    { id: 'deli', slug: 'deli', name: 'Deli' },
    { id: 'frozen', slug: 'frozen', name: 'Frozen' },
  ]).run();
  db.insert(lists).values({ id: 'l1', householdId: 'h1', name: 'Groceries', position: 1 }).run();
});

describe('catalog', () => {
  const catalog = () =>
    db
      .select({ key: ingredients.normalizedName, display: ingredients.displayName, category: ingredients.defaultCategoryId, status: ingredients.status, by: ingredients.categorizedBy, unit: ingredients.defaultUnit })
      .from(ingredients)
      .orderBy(asc(ingredients.normalizedName))
      .all();

  test('keeps the categorized row under the folded key', () => {
    db.insert(ingredients).values([
      { normalizedName: 'limón', displayName: 'Limón', defaultCategoryId: 'produce', status: 'categorized', categorizedBy: 'admin', defaultUnit: 'lb' },
      { normalizedName: 'limon', displayName: 'limon', status: 'pending' },
    ]).run();
    foldAccentKeys(NOW);
    expect(catalog()).toEqual([{ key: 'limon', display: 'Limón', category: 'produce', status: 'categorized', by: 'admin', unit: 'lb' }]);
  });

  test('prefers the seed row over a model one, both categorized', () => {
    db.insert(ingredients).values([
      { normalizedName: 'jalapeno', displayName: 'jalapeno', defaultCategoryId: 'deli', status: 'categorized', categorizedBy: 'model-x', defaultUnit: 'jar' },
      { normalizedName: 'jalapeño', displayName: 'Jalapeño', defaultCategoryId: 'produce', status: 'categorized', categorizedBy: 'seed', defaultUnit: 'count' },
    ]).run();
    foldAccentKeys(NOW);
    expect(catalog()).toEqual([{ key: 'jalapeno', display: 'Jalapeño', category: 'produce', status: 'categorized', by: 'seed', unit: 'count' }]);
  });

  test('prefers the row already under the folded key when both are seed rows', () => {
    db.insert(ingredients).values([
      { normalizedName: 'tajín', displayName: 'tajín', defaultCategoryId: 'deli', status: 'categorized', categorizedBy: 'seed' },
      { normalizedName: 'tajin', displayName: 'tajin', defaultCategoryId: 'produce', status: 'categorized', categorizedBy: 'seed' },
    ]).run();
    foldAccentKeys(NOW);
    expect(catalog()).toEqual([expect.objectContaining({ key: 'tajin', display: 'tajin', category: 'produce' })]);
  });

  test('renames an accented key with no plain twin and leaves plain keys alone', () => {
    db.insert(ingredients).values([
      { normalizedName: 'crème fraîche', displayName: 'Crème fraîche', status: 'failed' },
      { normalizedName: 'milk', displayName: 'milk', defaultCategoryId: 'deli', status: 'categorized', categorizedBy: 'seed' },
    ]).run();
    foldAccentKeys(NOW);
    expect(catalog().map((r) => [r.key, r.display, r.status])).toEqual([
      ['creme fraiche', 'Crème fraîche', 'failed'],
      ['milk', 'milk', 'categorized'],
    ]);
  });
});

describe('list items and recipe ingredients', () => {
  const items = () =>
    db
      .select({ id: listItems.id, key: listItems.ingredientName, display: listItems.displayName, deletedAt: listItems.deletedAt })
      .from(listItems)
      .orderBy(asc(listItems.id))
      .all();

  test('two open items that fold to one key merge into the older, contributions and all', () => {
    db.insert(listItems).values([
      { id: 'i1', listId: 'l1', householdId: 'h1', ingredientName: 'limon', displayName: 'limones', createdAt: T1 },
      { id: 'i2', listId: 'l1', householdId: 'h1', ingredientName: 'limón', displayName: 'Limón', createdAt: T2 },
    ]).run();
    db.insert(listItemContributions).values([
      { id: 'c1', listItemId: 'i1', householdId: 'h1', quantity: 2 },
      { id: 'c2', listItemId: 'i2', householdId: 'h1', quantity: 3 },
    ]).run();
    foldAccentKeys(NOW);
    expect(items()).toEqual([
      { id: 'i1', key: 'limon', display: 'limones', deletedAt: null },
      { id: 'i2', key: 'limon', display: 'Limón', deletedAt: NOW },
    ]);
    expect(db.select({ id: listItemContributions.id, item: listItemContributions.listItemId }).from(listItemContributions).orderBy(asc(listItemContributions.id)).all()).toEqual([
      { id: 'c1', item: 'i1' },
      { id: 'c2', item: 'i1' },
    ]);
  });

  test('the older item stays even when it is the accented one', () => {
    db.insert(listItems).values([
      { id: 'i1', listId: 'l1', householdId: 'h1', ingredientName: 'piña', displayName: 'piña', createdAt: T1 },
      { id: 'i2', listId: 'l1', householdId: 'h1', ingredientName: 'pina', displayName: 'pina', createdAt: T2 },
    ]).run();
    foldAccentKeys(NOW);
    expect(items()).toEqual([
      { id: 'i1', key: 'pina', display: 'piña', deletedAt: null },
      { id: 'i2', key: 'pina', display: 'pina', deletedAt: NOW },
    ]);
  });

  test('checked and deleted items are only renamed, and an open one with no clash is kept', () => {
    db.insert(listItems).values([
      { id: 'i1', listId: 'l1', householdId: 'h1', ingredientName: 'limón', displayName: 'limón', createdAt: T1, checkedAt: T2 },
      { id: 'i2', listId: 'l1', householdId: 'h1', ingredientName: 'limon', displayName: 'limon', createdAt: T2 },
      { id: 'i3', listId: 'l1', householdId: 'h1', ingredientName: 'café', displayName: 'café', createdAt: T1, deletedAt: T2 },
    ]).run();
    foldAccentKeys(NOW);
    expect(items()).toEqual([
      { id: 'i1', key: 'limon', display: 'limón', deletedAt: null },
      { id: 'i2', key: 'limon', display: 'limon', deletedAt: null },
      { id: 'i3', key: 'cafe', display: 'café', deletedAt: T2 },
    ]);
  });

  test('recipe ingredients get the folded key and keep their display name', () => {
    db.insert(recipes).values({ id: 'r1', householdId: 'h1', name: 'Salsa' }).run();
    db.insert(recipeIngredients).values([
      { id: 'ri1', recipeId: 'r1', householdId: 'h1', ingredientName: 'jalapeño', displayName: 'jalapeños', position: 1 },
      { id: 'ri2', recipeId: 'r1', householdId: 'h1', ingredientName: 'onion', displayName: 'onion', position: 2 },
    ]).run();
    foldAccentKeys(NOW);
    expect(db.select({ key: recipeIngredients.ingredientName, display: recipeIngredients.displayName }).from(recipeIngredients).orderBy(asc(recipeIngredients.id)).all()).toEqual([
      { key: 'jalapeno', display: 'jalapeños' },
      { key: 'onion', display: 'onion' },
    ]);
  });
});

describe('usage', () => {
  test('two rows that fold to one in a household: counts summed, the latest use kept, hidden only if both were', () => {
    db.insert(ingredientUsage).values([
      { householdId: 'h1', ingredientName: 'limón', displayName: 'Limón', useCount: 2, lastUsedAt: T2, hiddenAt: T3, fieldClock: { hidden_at: 'a' }, createdAt: T1 },
      { householdId: 'h1', ingredientName: 'limon', displayName: 'limones', useCount: 3, lastUsedAt: T3, fieldClock: { display_name: 'b' }, createdAt: T2 },
      { householdId: 'h2', ingredientName: 'limón', displayName: 'limón', useCount: 1, lastUsedAt: T1 },
    ]).run();
    foldAccentKeys(NOW);
    const rows = db
      .select({ h: ingredientUsage.householdId, key: ingredientUsage.ingredientName, display: ingredientUsage.displayName, n: ingredientUsage.useCount, at: ingredientUsage.lastUsedAt, hidden: ingredientUsage.hiddenAt, clock: ingredientUsage.fieldClock, created: ingredientUsage.createdAt })
      .from(ingredientUsage)
      .orderBy(asc(ingredientUsage.householdId))
      .all();
    expect(rows).toEqual([
      { h: 'h1', key: 'limon', display: 'limones', n: 5, at: T3, hidden: null, clock: { display_name: 'b' }, created: T1 },
      { h: 'h2', key: 'limon', display: 'limón', n: 1, at: T1, hidden: null, clock: {}, created: expect.any(Date) },
    ]);
  });

  test('stays hidden when every merged row was hidden', () => {
    db.insert(ingredientUsage).values([
      { householdId: 'h1', ingredientName: 'café', displayName: 'café', useCount: 1, lastUsedAt: T1, hiddenAt: T2 },
      { householdId: 'h1', ingredientName: 'cafe', displayName: 'cafe', useCount: 1, lastUsedAt: T1, hiddenAt: T3 },
    ]).run();
    foldAccentKeys(NOW);
    expect(db.select({ key: ingredientUsage.ingredientName, hidden: ingredientUsage.hiddenAt, n: ingredientUsage.useCount }).from(ingredientUsage).all()).toEqual([
      { key: 'cafe', hidden: T3, n: 2 },
    ]);
  });

  test('unit usage sums per unit with the latest last_used_at', () => {
    db.insert(ingredientUnitUsage).values([
      { householdId: 'h1', ingredientName: 'limón', unitKey: 'count', useCount: 1, lastUsedAt: T2 },
      { householdId: 'h1', ingredientName: 'limón', unitKey: 'lb', useCount: 1, lastUsedAt: T2 },
      { householdId: 'h1', ingredientName: 'limon', unitKey: 'count', useCount: 2, lastUsedAt: T1 },
      { householdId: 'h1', ingredientName: 'lime', unitKey: 'count', useCount: 4, lastUsedAt: T1 },
    ]).run();
    foldAccentKeys(NOW);
    expect(
      db
        .select({ key: ingredientUnitUsage.ingredientName, unit: ingredientUnitUsage.unitKey, n: ingredientUnitUsage.useCount, at: ingredientUnitUsage.lastUsedAt })
        .from(ingredientUnitUsage)
        .orderBy(asc(ingredientUnitUsage.ingredientName), asc(ingredientUnitUsage.unitKey))
        .all(),
    ).toEqual([
      { key: 'lime', unit: 'count', n: 4, at: T1 },
      { key: 'limon', unit: 'count', n: 3, at: T2 },
      { key: 'limon', unit: 'lb', n: 1, at: T2 },
    ]);
  });
});

describe('household overrides and staples', () => {
  test('of two overrides that fold to one, the newer HLC wins', () => {
    db.insert(householdCategoryOverrides).values([
      { householdId: 'h1', ingredientName: 'limón', categoryId: 'deli', fieldClock: { category_id: '1760000000009-0000-a' }, updatedAt: T1 },
      { householdId: 'h1', ingredientName: 'limon', categoryId: 'frozen', fieldClock: { category_id: '1760000000001-0000-a' }, updatedAt: T3 },
    ]).run();
    foldAccentKeys(NOW);
    expect(db.select({ key: householdCategoryOverrides.ingredientName, category: householdCategoryOverrides.categoryId, clock: householdCategoryOverrides.fieldClock }).from(householdCategoryOverrides).all()).toEqual([
      { key: 'limon', category: 'deli', clock: { category_id: '1760000000009-0000-a' } },
    ]);
  });

  test('an override with no clock loses to one with a clock; with neither, updated_at decides', () => {
    db.insert(householdCategoryOverrides).values([
      { householdId: 'h1', ingredientName: 'limón', categoryId: 'deli', updatedAt: T3 },
      { householdId: 'h1', ingredientName: 'limon', categoryId: 'frozen', fieldClock: { category_id: '1760000000001-0000-a' }, updatedAt: T1 },
      { householdId: 'h2', ingredientName: 'piña', categoryId: 'deli', updatedAt: T3 },
      { householdId: 'h2', ingredientName: 'pina', categoryId: 'frozen', updatedAt: T1 },
    ]).run();
    foldAccentKeys(NOW);
    expect(db.select({ h: householdCategoryOverrides.householdId, key: householdCategoryOverrides.ingredientName, category: householdCategoryOverrides.categoryId }).from(householdCategoryOverrides).orderBy(asc(householdCategoryOverrides.householdId)).all()).toEqual([
      { h: 'h1', key: 'limon', category: 'frozen' },
      { h: 'h2', key: 'pina', category: 'deli' },
    ]);
  });

  test('of two staples that fold to one, the newer mark or unmark wins', () => {
    db.insert(householdStaples).values([
      { householdId: 'h1', ingredientName: 'piña', fieldClock: { deleted_at: '1760000000002-0000-a' } },
      { householdId: 'h1', ingredientName: 'pina', deletedAt: T1, fieldClock: { deleted_at: '1760000000001-0000-a' } },
      { householdId: 'h2', ingredientName: 'sazón', createdBy: 'u1' },
    ]).run();
    foldAccentKeys(NOW);
    expect(db.select({ h: householdStaples.householdId, key: householdStaples.ingredientName, deletedAt: householdStaples.deletedAt, by: householdStaples.createdBy }).from(householdStaples).orderBy(asc(householdStaples.householdId)).all()).toEqual([
      { h: 'h1', key: 'pina', deletedAt: null, by: null },
      { h: 'h2', key: 'sazon', deletedAt: null, by: 'u1' },
    ]);
  });
});

describe('outbox', () => {
  test('unpushed mutations name the folded key, in fields and in composite keys', () => {
    const mutations: Mutation[] = [
      { table: 'list_items', id: 'i1', hlc: 'x1', fields: { ingredient_name: 'limón', display_name: 'Limón' } },
      { table: 'ingredient_usage', key: { household_id: 'h1', ingredient_name: 'limón' }, hlc: 'x2', fields: { display_name: 'Limón' }, counters: { use_count: 1 } },
      { table: 'list_items', id: 'i2', hlc: 'x3', fields: { note: 'ripe' } },
      { table: 'household_staples', key: { household_id: 'h1', ingredient_name: 'salt' }, hlc: 'x4', fields: {} },
    ];
    db.insert(outbox).values(mutations.map((mutation) => ({ householdId: 'h1', mutation }))).run();
    foldAccentKeys(NOW);
    expect(db.select({ m: outbox.mutation }).from(outbox).orderBy(asc(outbox.id)).all().map((r) => r.m)).toEqual([
      { table: 'list_items', id: 'i1', hlc: 'x1', fields: { ingredient_name: 'limon', display_name: 'Limón' } },
      { table: 'ingredient_usage', key: { household_id: 'h1', ingredient_name: 'limon' }, hlc: 'x2', fields: { display_name: 'Limón' }, counters: { use_count: 1 } },
      mutations[2],
      mutations[3],
    ]);
  });
});

describe('once per device', () => {
  test('sets its marker and does nothing on a later run', () => {
    expect(getDeviceSetting(FOLD_ACCENTS_KEY, false)).toBe(false);
    foldAccentKeys(NOW);
    expect(getDeviceSetting(FOLD_ACCENTS_KEY, false)).toBe(true);
    // Written after the merge (e.g. pulled from a server that hasn't run its migration yet): left alone.
    db.insert(ingredientUsage).values({ householdId: 'h1', ingredientName: 'limón', displayName: 'limón', useCount: 1, lastUsedAt: T1 }).run();
    foldAccentKeys(NOW);
    expect(db.select({ key: ingredientUsage.ingredientName }).from(ingredientUsage).where(eq(ingredientUsage.householdId, 'h1')).all()).toEqual([{ key: 'limón' }]);
  });

  test('a device with nothing accented changes nothing', () => {
    db.insert(ingredientUsage).values({ householdId: 'h1', ingredientName: 'milk', displayName: 'milk', useCount: 2, lastUsedAt: T1 }).run();
    foldAccentKeys(NOW);
    expect(db.select({ key: ingredientUsage.ingredientName, n: ingredientUsage.useCount }).from(ingredientUsage).all()).toEqual([{ key: 'milk', n: 2 }]);
  });
});
