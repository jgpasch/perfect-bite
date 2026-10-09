import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { eq } from 'drizzle-orm';

import { db, ingredients } from '@/db';
import { SORTING_CATEGORY_ID } from '@/domain/category-resolver';
import { addItem, addItemsBulk, deleteItem, groupItems, listItemsQuery, updateItem } from '@/features/lists/items';
import { ensureStarterData, getDefaultListId } from '@/features/lists/lists';
import { applySuggestion, getSuggestions } from '@/features/lists/suggestions';
import {
  addParsedRecipeIngredients,
  addRecipeIngredient,
  createRecipe,
  deleteRecipe,
  deleteRecipeIngredient,
  updateRecipeIngredient,
} from '@/features/recipes/recipes';
import { normalizeIngredientName, OTHER_CATEGORY_ID, SYSTEM_CATEGORIES } from '@/shared';
import { resetDb } from '@/test/db';

import {
  clearCategoryOverride,
  createCategory,
  ensureMissingIngredients,
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

  test('a known ingredient lands in its section instantly; unknown ones go to Sorting', () => {
    addItem(listId, '2 lbs chicken thighs', A);
    addItem(listId, 'Tomatoes', A);
    addItem(listId, 'flux capacitor', A);
    expect(categoryOf(A, 'chicken thighs')).toBe(id('meat-seafood'));
    expect(categoryOf(A, 'Tomatoes')).toBe(id('produce'));
    expect(categoryOf(A, 'flux capacitor')).toBe(SORTING_CATEGORY_ID);
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

describe('pending ingredients (spec 4.3.1, 6.3)', () => {
  const key = normalizeIngredientName;
  const rows = (name: string) => db.select().from(ingredients).where(eq(ingredients.normalizedName, key(name))).all();
  const pendingNames = () =>
    db
      .select({ name: ingredients.normalizedName, displayName: ingredients.displayName })
      .from(ingredients)
      .where(eq(ingredients.status, 'pending'))
      .orderBy(ingredients.normalizedName)
      .all();
  const sorted = (list: { name: string; displayName: string }[]) => [...list].sort((a, b) => a.name.localeCompare(b.name));
  const pendingRow = (displayName: string) => ({
    normalizedName: key(displayName),
    displayName,
    defaultCategoryId: null,
    status: 'pending',
    isGroceryItem: null,
    categorizedBy: null,
  });
  const itemNamed = (name: string) =>
    groupItems(listItemsQuery(listId, A).all()).unchecked.find((i) => i.displayName === name)!;

  test('adding an unknown name creates one pending row', () => {
    addItem(listId, '2 Flux Capacitors', A);
    expect(rows('Flux Capacitors')).toEqual([pendingRow('Flux Capacitors')]);
    expect(pendingNames()).toHaveLength(1);
  });

  test('adding a seed name leaves its categorized row alone', () => {
    const before = rows('chicken thighs');
    expect(before[0].status).toBe('categorized');
    addItem(listId, '2 lbs Chicken Thighs', A);
    expect(rows('chicken thighs')).toEqual(before);
    expect(pendingNames()).toEqual([]);
  });

  test('adding the same unknown name twice creates one row, keeping the first display name', () => {
    addItem(listId, 'dukkah', A);
    addItem(listId, '2 Dukkah', A);
    expect(pendingNames()).toEqual([{ name: key('dukkah'), displayName: 'dukkah' }]);
  });

  test('a later add does not reset a failed row', () => {
    addItem(listId, 'flux capacitor', A);
    db.update(ingredients)
      .set({ status: 'failed', defaultCategoryId: OTHER_CATEGORY_ID })
      .where(eq(ingredients.normalizedName, key('flux capacitor')))
      .run();
    addItem(listId, '2 flux capacitor', A);
    expect(rows('flux capacitor')[0]).toMatchObject({ status: 'failed', defaultCategoryId: OTHER_CATEGORY_ID });
  });

  test('a bulk add creates one row per new name', () => {
    addItemsBulk(listId, [{ text: 'ssamjang' }, { text: 'tomatoes' }, { text: '2 ssamjang' }, { text: 'yuzu kosho' }], A);
    expect(pendingNames()).toEqual(
      sorted([
        { name: key('ssamjang'), displayName: 'ssamjang' },
        { name: key('yuzu kosho'), displayName: 'yuzu kosho' },
      ]),
    );
  });

  test('renaming an item to an unknown name creates a row; other edits do not', () => {
    addItem(listId, 'tomatoes', A);
    const item = itemNamed('tomatoes');
    updateItem(item.id, { name: 'tomatoes', amount: '', note: 'ripe' }, A);
    expect(pendingNames()).toEqual([]);
    updateItem(item.id, { name: 'Tomatillos', amount: '', note: '' }, A);
    expect(rows('Tomatillos')).toEqual([pendingRow('Tomatillos')]);
  });

  test('recipe ingredients: added, parsed and edited names create pending rows', () => {
    const recipe = createRecipe('Shakshuka');
    addRecipeIngredient(recipe, '1 tbsp harissa');
    addRecipeIngredient(recipe, '2 eggs');
    addParsedRecipeIngredients(recipe, [
      { ingredientName: key('urfa biber'), displayName: 'urfa biber', quantity: null, unit: null },
      { ingredientName: key('sumac'), displayName: 'sumac', quantity: null, unit: null },
    ]);
    const feta = addRecipeIngredient(recipe, 'feta')!;
    updateRecipeIngredient(feta, '100 g labneh');
    expect(pendingNames()).toEqual(
      sorted([
        { name: key('harissa'), displayName: 'harissa' },
        { name: key('labneh'), displayName: 'labneh' },
        { name: key('urfa biber'), displayName: 'urfa biber' },
      ]),
    );
    expect(rows('eggs')[0].status).toBe('categorized');
    expect(rows('feta')[0].status).toBe('categorized');
    expect(rows('sumac')[0].status).toBe('categorized');
  });

  test('pending names are not offered by catalog autocomplete', () => {
    addItem(listId, 'tomatillo salsa verde', A);
    expect(searchCatalog('tomatillo salsa', 5)).toEqual([]);
  });

  test('ensureMissingIngredients fills the gaps and changes nothing on a second run', () => {
    addItem(listId, 'ssamjang', A);
    addItem(listId, 'tomatoes', A);
    addItem(listId, 'old thing', A);
    const recipe = createRecipe('Bibimbap');
    addRecipeIngredient(recipe, 'Doenjang');
    const removed = addRecipeIngredient(recipe, 'removed paste')!;
    const gone = createRecipe('Gone');
    addRecipeIngredient(gone, 'mystery paste');
    // An install from before pending rows: items and recipe ingredients with no catalog row.
    db.delete(ingredients).where(eq(ingredients.status, 'pending')).run();
    deleteItem(itemNamed('old thing').id);
    deleteRecipeIngredient(removed);
    deleteRecipe(gone);
    const before = db.select().from(ingredients).all().length;

    ensureMissingIngredients();
    expect(pendingNames()).toEqual(
      sorted([
        { name: key('Doenjang'), displayName: 'Doenjang' },
        { name: key('ssamjang'), displayName: 'ssamjang' },
      ]),
    );
    expect(db.select().from(ingredients).all()).toHaveLength(before + 2);
    expect(rows('tomatoes')[0].status).toBe('categorized');

    const after = db.select().from(ingredients).all();
    ensureMissingIngredients();
    expect(db.select().from(ingredients).all()).toEqual(after);
  });

  test('ensureMissingIngredients leaves existing rows alone, and does nothing on an empty DB', () => {
    addItem(listId, 'flux capacitor', A);
    db.update(ingredients).set({ status: 'failed' }).where(eq(ingredients.normalizedName, key('flux capacitor'))).run();
    ensureMissingIngredients();
    expect(rows('flux capacitor')[0].status).toBe('failed');
    resetDb();
    ensureMissingIngredients();
    expect(db.select().from(ingredients).all()).toEqual([]);
  });

  test('loadCatalogSeed still overwrites a pending row whose name is in the seed', () => {
    db.delete(ingredients).where(eq(ingredients.normalizedName, key('tomatoes'))).run();
    addItem(listId, 'Tomatoes', A);
    expect(rows('tomatoes')[0]).toMatchObject({ status: 'pending', defaultCategoryId: null });
    require('@/features/settings/device-settings').setDeviceSetting('catalog.seedFingerprint', 0);
    loadCatalogSeed();
    expect(rows('tomatoes')).toEqual([
      {
        normalizedName: key('tomatoes'),
        displayName: 'tomatoes',
        defaultCategoryId: id('produce'),
        status: 'categorized',
        isGroceryItem: true,
        categorizedBy: 'seed',
      },
    ]);
    expect(categoryOf(A, 'Tomatoes')).toBe(id('produce'));
  });
});
