import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { db, ingredients } from '@/db';
import { addItem, groupItems, listItemsQuery, updateItem } from '@/features/lists/items';
import { ensureStarterData, getDefaultListId } from '@/features/lists/lists';
import { applySuggestion, getSuggestions } from '@/features/lists/suggestions';
import { OTHER_CATEGORY_ID, SYSTEM_CATEGORIES } from '@/shared';
import { resetDb } from '@/test/db';

import {
  clearCategoryOverride,
  createCategory,
  getOrderedCategories,
  loadCatalogSeed,
  moveCategory,
  searchCatalog,
  setCategoryOverride,
} from '../categories';

jest.mock('@/db/client', () => require('@/test/db'));

const A = 'user-a';
const B = 'user-b';
const id = (slug: string) => SYSTEM_CATEGORIES.find((c) => c.slug === slug)!.id;
const names = (userId: string) => getOrderedCategories(userId).map((c) => c.name);
let listId: string;

beforeEach(() => {
  resetDb();
  loadCatalogSeed();
  ensureStarterData(A);
  listId = getDefaultListId(A)!;
});

const categoryOf = (userId: string, name: string) =>
  groupItems(listItemsQuery(listId, userId).all()).unchecked.find((i) => i.displayName === name)!.categoryId;

describe('seed', () => {
  test('loads categories in store-walk order, and only once', () => {
    expect(names(A).slice(0, 3)).toEqual(['Produce', 'Bakery', 'Deli']);
    expect(names(A).at(-1)).toBe('Other');
    loadCatalogSeed();
    expect(names(A)).toHaveLength(SYSTEM_CATEGORIES.length);
  });

  test('a known ingredient lands in its section instantly; unknown ones go to Other', () => {
    addItem(listId, '2 lbs chicken thighs', A);
    addItem(listId, 'Tomatoes', A);
    addItem(listId, 'flux capacitor', A);
    expect(categoryOf(A, 'chicken thighs')).toBe(id('meat-seafood'));
    expect(categoryOf(A, 'Tomatoes')).toBe(id('produce'));
    expect(categoryOf(A, 'flux capacitor')).toBe(OTHER_CATEGORY_ID);
  });

  test('does not overwrite an ingredient the server categorized', () => {
    db.update(ingredients)
      .set({ defaultCategoryId: id('snacks'), categorizedBy: 'claude-haiku-5-5' })
      .run();
    // Force a reload by pretending the seed changed.
    require('@/features/settings/device-settings').setDeviceSetting('catalog.seedFingerprint', 0);
    loadCatalogSeed();
    addItem(listId, 'milk', A);
    expect(categoryOf(A, 'milk')).toBe(id('snacks'));
  });
});

describe('overrides (spec 4.3.2)', () => {
  test('apply to the user on every list, not to anyone else', () => {
    addItem(listId, 'tahini', A);
    setCategoryOverride(A, 'tahini', id('pantry'));
    expect(categoryOf(A, 'tahini')).toBe(id('pantry'));
    expect(categoryOf(B, 'tahini')).toBe(id('condiments'));
    clearCategoryOverride(A, 'tahini');
    expect(categoryOf(A, 'tahini')).toBe(id('condiments'));
  });

  test('set from the edit sheet, and reset to default', () => {
    const item = addItem(listId, 'tahini', A)!;
    updateItem(item.itemId, { name: 'tahini', amount: '', note: '', categoryId: id('pantry') }, A);
    expect(categoryOf(A, 'tahini')).toBe(id('pantry'));
    updateItem(item.itemId, { name: 'tahini', amount: '', note: '' }, A); // untouched
    expect(categoryOf(A, 'tahini')).toBe(id('pantry'));
    updateItem(item.itemId, { name: 'tahini', amount: '', note: '', categoryId: null }, A);
    expect(categoryOf(A, 'tahini')).toBe(id('condiments'));
  });
});

describe('category order (spec 4.3.3)', () => {
  test('moving a category changes only that user’s order', () => {
    const dairy = names(A).indexOf('Dairy & Eggs');
    moveCategory(A, dairy, 0);
    expect(names(A).slice(0, 2)).toEqual(['Dairy & Eggs', 'Produce']);
    expect(names(B).slice(0, 2)).toEqual(['Produce', 'Bakery']);
    moveCategory(A, 1, 2);
    expect(names(A).slice(0, 3)).toEqual(['Dairy & Eggs', 'Bakery', 'Produce']);
  });

  test('custom categories are per user and go at the end; names are reused', () => {
    const costco = createCategory(A, ' Costco  run ');
    expect(names(A).at(-1)).toBe('Costco run');
    expect(createCategory(A, 'costco run')).toBe(costco);
    expect(names(B)).not.toContain('Costco run');
    expect(() => createCategory(A, ' ')).toThrow();
  });
});

describe('autocomplete', () => {
  test('searches the catalog by name or word prefix', () => {
    expect(searchCatalog('chicken th', 5).map((r) => r.displayName)).toEqual(['chicken thighs']);
    expect(searchCatalog('thigh', 5).map((r) => r.displayName)).toContain('chicken thighs');
    expect(searchCatalog('%', 5)).toEqual([]);
  });

  test('suggests recent household items first, then the catalog, keeping a typed amount', () => {
    addItem(listId, 'chicken sausage from the butcher', A);
    const household = groupItems(listItemsQuery(listId, A).all()); // ensure the add landed
    expect(household.unchecked).toHaveLength(1);
    const list = require('@/features/lists/lists').getList(listId);
    const suggestions = getSuggestions(list.householdId, '2 lbs chick');
    expect(suggestions[0].displayName).toBe('chicken sausage from the butcher');
    expect(suggestions.map((s) => s.displayName)).toContain('chicken');
    expect(applySuggestion('2 lbs chick', { key: 'chicken thigh', displayName: 'chicken thighs' })).toBe(
      '2 lbs chicken thighs',
    );
    expect(getSuggestions(list.householdId, 'c')).toEqual([]);
  });
});
