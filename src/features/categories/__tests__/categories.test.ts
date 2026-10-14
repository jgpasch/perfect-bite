import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { eq } from 'drizzle-orm';

import { categories, db, householdCategoryOverrides, households, ingredients } from '@/db';
import { categoryNameById, effectiveCategoryId, SORTING_CATEGORY_ID } from '@/domain/category-resolver';
import { addItem, addItemsBulk, deleteItem, groupItems, listItemsQuery, updateItem } from '@/features/lists/items';
import { createList, ensureStarterData, getDefaultListId, getList } from '@/features/lists/lists';
import { initI18n } from '@/i18n';
import { insertRow } from '@/sync/mutate';
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
import { seedCatalog } from '@/test/seed';

import {
  clearCategoryOverride,
  createCategory,
  ensureMissingIngredients,
  getIngredientCategory,
  getOrderedCategories,
  ingredientAisles,
  loadCatalogSeed,
  moveCategory,
  searchCatalog,
  setCategoryOverride,
} from '../categories';

jest.mock('@/db/client', () => require('@/test/db'));

const A = 'user-a';
const B = 'user-b';
/** A second household, with its own list: A's cabin, which B isn't in. */
const CABIN = 'household-cabin';
const id = (slug: string) => SYSTEM_CATEGORIES.find((c) => c.slug === slug)!.id;
let listId: string;
/** The household of A's starter list, which B shares on this device. */
let home: string;
let cabinListId: string;
const names = (userId: string, households: string | string[] = home) =>
  getOrderedCategories(userId, households).map((c) => c.name);

beforeEach(() => {
  resetDb();
  seedCatalog();
  ensureStarterData(A);
  listId = getDefaultListId(A)!;
  home = getList(listId)!.householdId;
  insertRow(db, households, { id: CABIN, name: 'Cabin' });
  cabinListId = createList('Cabin groceries', CABIN);
});

const key = normalizeIngredientName;
/** The aisle an item shows under on a list; the same for every member, whoever looks. */
const categoryOf = (name: string, list = listId) =>
  groupItems(listItemsQuery(list).all()).unchecked.find((i) => i.displayName === name)!.categoryId;

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
    expect(categoryOf('chicken thighs')).toBe(id('meat-seafood'));
    expect(categoryOf('Tomatoes')).toBe(id('produce'));
    expect(categoryOf('flux capacitor')).toBe(SORTING_CATEGORY_ID);
  });

  test('does not overwrite an ingredient the server categorized', () => {
    db.update(ingredients)
      .set({ defaultCategoryId: id('snacks'), categorizedBy: 'claude-haiku-5-5' })
      .run();
    // Force a reload by pretending the seed changed.
    require('@/features/settings/device-settings').setDeviceSetting('catalog.seedFingerprint', 0);
    loadCatalogSeed();
    addItem(listId, 'milk', A);
    expect(categoryOf('milk')).toBe(id('snacks'));
  });
});

describe('Spanish seed and links (spec 4.15)', () => {
  const row = (name: string) =>
    db.select().from(ingredients).where(eq(ingredients.normalizedName, key(name))).get();
  const reload = () => {
    require('@/features/settings/device-settings').setDeviceSetting('catalog.seedFingerprint', 0);
    loadCatalogSeed();
  };

  test('loads Spanish names with their language, links, and their target’s aisle and unit', () => {
    expect(row('leche')).toEqual({
      normalizedName: 'leche',
      displayName: 'leche',
      defaultCategoryId: id('dairy-eggs'),
      status: 'categorized',
      isGroceryItem: true,
      categorizedBy: 'seed',
      defaultUnit: 'gal',
      lang: 'es',
      sameAs: 'milk',
      linkedBy: 'seed',
    });
    expect(row('milk')).toMatchObject({ lang: 'en', sameAs: null, linkedBy: null });
    expect(row('limones')).toMatchObject({ normalizedName: 'limon', lang: 'es', sameAs: null, linkedBy: null });
    expect(row('tomate')).toMatchObject({ lang: 'es', sameAs: null });
    expect(row('crema')).toMatchObject({ lang: 'en', sameAs: null });
    addItem(listId, '2 pepinos', A);
    expect(categoryOf('pepinos')).toBe(id('produce'));
  });

  test('a row the server categorized keeps its answer but learns its language and the seed link', () => {
    db.update(ingredients)
      .set({ defaultCategoryId: id('snacks'), categorizedBy: 'gemini-test', lang: null, sameAs: null, linkedBy: null })
      .where(eq(ingredients.normalizedName, 'leche'))
      .run();
    reload();
    expect(row('leche')).toMatchObject({
      defaultCategoryId: id('snacks'),
      categorizedBy: 'gemini-test',
      lang: 'es',
      sameAs: 'milk',
      linkedBy: 'seed',
    });
  });

  test("a seed link replaces a model's link but not an admin's", () => {
    db.update(ingredients).set({ sameAs: 'cream', linkedBy: 'gemini-test' }).where(eq(ingredients.normalizedName, 'leche')).run();
    db.update(ingredients).set({ sameAs: 'egg white', linkedBy: 'admin' }).where(eq(ingredients.normalizedName, 'huevo')).run();
    reload();
    expect(row('leche')).toMatchObject({ sameAs: 'milk', linkedBy: 'seed' });
    expect(row('huevos')).toMatchObject({ sameAs: 'egg white', linkedBy: 'admin' });
  });

  test("clears a seed link the seed no longer lists, and leaves other links alone", () => {
    db.insert(ingredients)
      .values([
        { normalizedName: 'old seed link', displayName: 'old seed link', status: 'categorized', sameAs: 'milk', linkedBy: 'seed' },
        { normalizedName: 'model link', displayName: 'model link', status: 'categorized', sameAs: 'milk', linkedBy: 'gemini-test' },
      ])
      .run();
    reload();
    expect(row('old seed link')).toMatchObject({ sameAs: null, linkedBy: null });
    expect(row('model link')).toMatchObject({ sameAs: 'milk', linkedBy: 'gemini-test' });
  });
});

describe('overrides (spec 4.3.2)', () => {
  test("apply to everyone in the household on every list, not to another household's", () => {
    const second = createList('Costco', home);
    addItem(listId, 'tahini', A);
    addItem(second, 'tahini', B);
    addItem(cabinListId, 'tahini', A);
    setCategoryOverride(home, 'tahini', id('pantry'));
    // A set it; B, in the same household, sees it too, on both of its lists.
    expect(categoryOf('tahini')).toBe(id('pantry'));
    expect(categoryOf('tahini', second)).toBe(id('pantry'));
    expect(getIngredientCategory(home, 'tahini').overrideCategoryId).toBe(id('pantry'));
    // The cabin is another household: still the default.
    expect(categoryOf('tahini', cabinListId)).toBe(id('condiments'));
    expect(getIngredientCategory(CABIN, 'tahini').overrideCategoryId).toBeNull();
  });

  test('a user in two households has a separate override in each', () => {
    addItem(listId, 'tahini', A);
    addItem(cabinListId, 'tahini', A);
    setCategoryOverride(home, 'tahini', id('pantry'));
    setCategoryOverride(CABIN, 'tahini', id('spices'));
    expect(categoryOf('tahini')).toBe(id('pantry'));
    expect(categoryOf('tahini', cabinListId)).toBe(id('spices'));
    clearCategoryOverride(CABIN, 'tahini');
    expect(categoryOf('tahini')).toBe(id('pantry'));
    expect(categoryOf('tahini', cabinListId)).toBe(id('condiments'));
  });

  test('reset writes a null category for the whole household and falls back to the default', () => {
    addItem(listId, 'tahini', A);
    setCategoryOverride(home, 'tahini', id('pantry'));
    clearCategoryOverride(home, 'tahini');
    expect(db.select().from(householdCategoryOverrides).all()).toMatchObject([
      { householdId: home, ingredientName: 'tahini', categoryId: null },
    ]);
    expect(getIngredientCategory(home, 'tahini')).toEqual({
      defaultCategoryId: id('condiments'),
      overrideCategoryId: null,
      status: 'categorized',
    });
    expect(categoryOf('tahini')).toBe(id('condiments'));
    // And a later change still applies over the reset.
    setCategoryOverride(home, 'tahini', id('spices'));
    expect(categoryOf('tahini')).toBe(id('spices'));
  });

  test("set from the edit sheet for the item's household, and reset to default", () => {
    const item = addItem(listId, 'tahini', A)!;
    addItem(cabinListId, 'tahini', A);
    updateItem(item.itemId, { name: 'tahini', amount: '', note: '', categoryId: id('pantry') });
    expect(categoryOf('tahini')).toBe(id('pantry'));
    expect(categoryOf('tahini', cabinListId)).toBe(id('condiments'));
    updateItem(item.itemId, { name: 'tahini', amount: '', note: '' }); // untouched
    expect(categoryOf('tahini')).toBe(id('pantry'));
    updateItem(item.itemId, { name: 'tahini', amount: '', note: '', categoryId: null });
    expect(categoryOf('tahini')).toBe(id('condiments'));
  });

  test('the edit sheet reads the status, so a pending item shows Sorting... and can be moved', () => {
    const item = addItem(listId, 'kashk', A)!;
    const current = getIngredientCategory(home, key('kashk'));
    expect(current).toEqual({ defaultCategoryId: null, overrideCategoryId: null, status: 'pending' });
    const defaultId = effectiveCategoryId(null, current.defaultCategoryId, current.status);
    expect(defaultId).toBe(SORTING_CATEGORY_ID);
    expect(categoryNameById(getOrderedCategories(A, home), defaultId)).toBe('Sorting...');

    updateItem(item.itemId, { name: 'kashk', amount: '', note: '', categoryId: id('spices') });
    expect(getIngredientCategory(home, key('kashk'))).toEqual({
      defaultCategoryId: null,
      overrideCategoryId: id('spices'),
      status: 'pending',
    });
    expect(categoryOf('kashk')).toBe(id('spices'));
    // Reset to default goes back to Sorting...
    updateItem(item.itemId, { name: 'kashk', amount: '', note: '', categoryId: null });
    expect(categoryOf('kashk')).toBe(SORTING_CATEGORY_ID);
  });

  test('getIngredientCategory gives a categorized status, a failed status, or null with no row', () => {
    expect(getIngredientCategory(home, key('milk'))).toEqual({
      defaultCategoryId: id('dairy-eggs'),
      overrideCategoryId: null,
      status: 'categorized',
    });
    addItem(listId, 'kashk', A);
    db.update(ingredients).set({ status: 'failed' }).where(eq(ingredients.normalizedName, key('kashk'))).run();
    expect(getIngredientCategory(home, key('kashk')).status).toBe('failed');
    expect(getIngredientCategory(home, key('never added'))).toEqual({
      defaultCategoryId: null,
      overrideCategoryId: null,
      status: null,
    });
  });
});

describe('shared aisle across a family (spec 4.15)', () => {
  const overrideRows = () =>
    db
      .select({ householdId: householdCategoryOverrides.householdId, ingredientName: householdCategoryOverrides.ingredientName, categoryId: householdCategoryOverrides.categoryId })
      .from(householdCategoryOverrides)
      .all();

  beforeEach(() => {
    addItem(listId, 'milk', A);
    // Two items on one list: leche is added unlinked, as an add would now Combine it into milk (4.4).
    const leche = eq(ingredients.normalizedName, 'leche');
    const link = db.select({ sameAs: ingredients.sameAs, linkedBy: ingredients.linkedBy }).from(ingredients).where(leche).get()!;
    db.update(ingredients).set({ sameAs: null, linkedBy: null }).where(leche).run();
    addItem(listId, 'leche', A);
    db.update(ingredients).set(link).where(leche).run();
  });

  test('moving milk moves leche, on the list and in the item sheet and aisle dots', () => {
    expect(categoryOf('milk')).toBe(id('dairy-eggs'));
    expect(categoryOf('leche')).toBe(id('dairy-eggs'));
    setCategoryOverride(home, key('milk'), id('beverages'));
    expect(categoryOf('milk')).toBe(id('beverages'));
    expect(categoryOf('leche')).toBe(id('beverages'));
    expect(getIngredientCategory(home, key('leche'))).toEqual({
      defaultCategoryId: id('dairy-eggs'),
      overrideCategoryId: id('beverages'),
      status: 'categorized',
    });
    expect(ingredientAisles(home, [key('leche')]).get(key('leche'))).toEqual({ slug: 'beverages', name: 'Beverages' });
    expect(overrideRows()).toEqual([{ householdId: home, ingredientName: 'milk', categoryId: id('beverages') }]);
  });

  test('moving leche moves milk: the override is written under the family key', () => {
    setCategoryOverride(home, key('leche'), id('frozen'));
    expect(overrideRows()).toEqual([{ householdId: home, ingredientName: 'milk', categoryId: id('frozen') }]);
    expect(categoryOf('milk')).toBe(id('frozen'));
    expect(categoryOf('leche')).toBe(id('frozen'));
    expect(getIngredientCategory(home, key('milk')).overrideCategoryId).toBe(id('frozen'));
  });

  test("from leche's item sheet, then Reset to default from it, for both names", () => {
    const leche = groupItems(listItemsQuery(listId).all()).unchecked.find((i) => i.displayName === 'leche')!;
    updateItem(leche.id, { name: 'leche', amount: '', note: '', categoryId: id('pantry') });
    expect(categoryOf('milk')).toBe(id('pantry'));
    expect(categoryOf('leche')).toBe(id('pantry'));
    updateItem(leche.id, { name: 'leche', amount: '', note: '', categoryId: null });
    expect(overrideRows()).toEqual([{ householdId: home, ingredientName: 'milk', categoryId: null }]);
    expect(categoryOf('milk')).toBe(id('dairy-eggs'));
    expect(categoryOf('leche')).toBe(id('dairy-eggs'));
  });

  test('the later of two changes on either twin wins, since both write one row', () => {
    setCategoryOverride(home, key('milk'), id('beverages'));
    setCategoryOverride(home, key('leche'), id('frozen'));
    expect(categoryOf('milk')).toBe(id('frozen'));
    clearCategoryOverride(home, key('milk'));
    expect(categoryOf('leche')).toBe(id('dairy-eggs'));
    expect(overrideRows()).toHaveLength(1);
  });

  test("another household's milk keeps its own aisle", () => {
    addItem(cabinListId, 'leche', A);
    setCategoryOverride(home, key('leche'), id('frozen'));
    expect(categoryOf('leche', cabinListId)).toBe(id('dairy-eggs'));
    expect(getIngredientCategory(CABIN, key('milk')).overrideCategoryId).toBeNull();
  });

  test('an unlinked pair (tomate, tomato) stays separate, both ways', () => {
    addItem(listId, 'tomate', A);
    addItem(listId, 'tomato', A);
    const tomatoDefault = categoryOf('tomato');
    setCategoryOverride(home, key('tomate'), id('canned-jarred'));
    expect(categoryOf('tomate')).toBe(id('canned-jarred'));
    expect(categoryOf('tomato')).toBe(tomatoDefault);
    setCategoryOverride(home, key('tomato'), id('frozen'));
    expect(categoryOf('tomate')).toBe(id('canned-jarred'));
    expect(categoryOf('tomato')).toBe(id('frozen'));
    expect(overrideRows().map((r) => r.ingredientName).sort()).toEqual(['tomate', 'tomato']);
  });

  test('a name linked later (pulled from the server) follows its family at once', () => {
    addItem(listId, 'kashk', A);
    setCategoryOverride(home, key('milk'), id('beverages'));
    expect(categoryOf('kashk')).toBe(SORTING_CATEGORY_ID);
    db.update(ingredients).set({ sameAs: 'milk', linkedBy: 'model-x' }).where(eq(ingredients.normalizedName, key('kashk'))).run();
    expect(categoryOf('kashk')).toBe(id('beverages'));
    expect(getIngredientCategory(home, key('kashk')).overrideCategoryId).toBe(id('beverages'));
  });
});

describe('category order (spec 4.3.3)', () => {
  test('moving a category changes only that user’s order', () => {
    const dairy = names(A).indexOf('Dairy & Eggs');
    moveCategory(A, home, dairy, 0);
    expect(names(A).slice(0, 2)).toEqual(['Dairy & Eggs', 'Produce']);
    expect(names(B).slice(0, 2)).toEqual(['Produce', 'Bakery']);
    moveCategory(A, home, 1, 2);
    expect(names(A).slice(0, 3)).toEqual(['Dairy & Eggs', 'Bakery', 'Produce']);
    // The order is the user's, whichever household's aisles are shown.
    expect(names(A, CABIN).slice(0, 3)).toEqual(['Dairy & Eggs', 'Bakery', 'Produce']);
  });
});

describe('custom aisles (spec 4.3.2)', () => {
  test("belong to the household: every member has them, another household doesn't", () => {
    const costco = createCategory(A, home, ' Costco  run ');
    expect(names(A).at(-1)).toBe('Costco run');
    // B is in the same household, so has it too (at the end: B hasn't placed it).
    expect(names(B)).toContain('Costco run');
    expect(names(A, CABIN)).not.toContain('Costco run');
    expect(db.select().from(categories).where(eq(categories.id, costco)).get()).toMatchObject({
      name: 'Costco run',
      householdId: home,
      slug: null,
      defaultRank: null,
    });
  });

  test('names are deduped within the household, in any case, system aisles included', () => {
    const costco = createCategory(A, home, 'Costco');
    expect(createCategory(B, home, 'costco')).toBe(costco);
    expect(createCategory(A, home, 'PRODUCE')).toBe(id('produce'));
    // Another household gets its own.
    const cabinCostco = createCategory(A, CABIN, 'Costco');
    expect(cabinCostco).not.toBe(costco);
    expect(names(A, CABIN).filter((n) => n === 'Costco')).toHaveLength(1);
    expect(() => createCategory(A, home, ' ')).toThrow();
  });

  test('a member can file an item under the household aisle another member made', () => {
    const costco = createCategory(A, home, 'Costco');
    const item = addItem(listId, 'paper towels', B)!;
    updateItem(item.itemId, { name: 'paper towels', amount: '', note: '', categoryId: costco });
    expect(categoryOf('paper towels')).toBe(costco);
  });

  test('the aisle order screen shows every household the user is in', () => {
    createCategory(A, home, 'Costco');
    createCategory(A, CABIN, 'Costco');
    createCategory(A, CABIN, 'Farm stand');
    const all = names(A, [home, CABIN]);
    expect(all.filter((n) => n === 'Costco')).toHaveLength(2);
    expect(all).toContain('Farm stand');
    expect(all).toHaveLength(SYSTEM_CATEGORIES.length + 3);
    expect(names(A, [])).toHaveLength(SYSTEM_CATEGORIES.length);
    // Moving within that view moves the right aisle.
    const farm = all.indexOf('Farm stand');
    moveCategory(A, [home, CABIN], farm, 0);
    expect(names(A, [home, CABIN])[0]).toBe('Farm stand');
    expect(names(A, CABIN)[0]).toBe('Farm stand');
  });
});

describe('system aisles in either language (spec 4.15)', () => {
  afterEach(() => initI18n('en'));

  test('"New category…" with a system aisle’s English or Spanish name picks that aisle', () => {
    expect(createCategory(A, home, 'Lácteos')).toBe(id('dairy-eggs'));
    expect(createCategory(A, home, '  lacteos ')).toBe(id('dairy-eggs'));
    expect(createCategory(A, home, 'FRUTAS Y  VERDURAS')).toBe(id('produce'));
    expect(createCategory(A, home, 'panaderia')).toBe(id('bakery'));
    expect(createCategory(A, home, 'dairy & eggs')).toBe(id('dairy-eggs'));
    // Whatever the app's language.
    initI18n('es');
    expect(createCategory(A, home, 'Meat & Seafood')).toBe(id('meat-seafood'));
    expect(createCategory(A, home, 'Carnes y mariscos')).toBe(id('meat-seafood'));
    expect(names(A)).toHaveLength(SYSTEM_CATEGORIES.length);
  });

  test('a name that is only close to a system aisle is a new custom aisle', () => {
    const dairy = createCategory(A, home, 'Lácteos extra');
    expect(dairy).not.toBe(id('dairy-eggs'));
    expect(db.select().from(categories).where(eq(categories.id, dairy)).get()).toMatchObject({ name: 'Lácteos extra', slug: null });
  });

  test('system aisles show in the app’s language; stored names and custom aisles don’t change', () => {
    const custom = createCategory(A, home, 'Costco');
    initI18n('es');
    expect(names(A).slice(0, 3)).toEqual(['Frutas y verduras', 'Panadería', 'Salchichonería']);
    expect(names(A).at(-1)).toBe('Costco');
    expect(ingredientAisles(home, [key('milk')]).get(key('milk'))).toEqual({ slug: 'dairy-eggs', name: 'Lácteos' });
    setCategoryOverride(home, key('milk'), custom);
    expect(ingredientAisles(home, [key('milk')]).get(key('milk'))).toEqual({ slug: null, name: 'Costco' });
    expect(db.select().from(categories).where(eq(categories.id, id('produce'))).get()!.name).toBe('Produce');
    expect(categoryNameById([], 'gone')).toBe('Otros');
    initI18n('en');
    expect(names(A).slice(0, 3)).toEqual(['Produce', 'Bakery', 'Deli']);
    expect(categoryNameById([], 'gone')).toBe('Other');
  });
});

describe('autocomplete', () => {
  test('searches the catalog by name or word prefix', () => {
    // Whole-name prefix matches first, shortest first, then word matches, up to the limit.
    expect(searchCatalog('chicken th', 5).map((r) => r.displayName)).toEqual([
      'chicken thighs',
      'frozen chicken thighs',
      'bone in chicken thighs',
      'boneless chicken thighs',
      'boneless skinless chicken thighs',
    ]);
    expect(searchCatalog('thigh', 5).map((r) => r.displayName)).toContain('chicken thighs');
    expect(searchCatalog('%', 5)).toEqual([]);
  });

  test("names in the app's language come first (spec 4.15)", () => {
    const shown = (q: string, language?: string) => searchCatalog(q, 5, language).map((r) => r.displayName);
    // English: whole-name prefix first, so `dulce de leche` and `tres leches cake` (English names) come first.
    expect(shown('lech', 'en')).toEqual(['dulce de leche', 'tres leches cake', 'leche', 'lechuga', 'leche de soya']);
    expect(shown('lech', 'es')).toEqual(['leche', 'lechuga', 'leche de soya', 'leche de avena', 'leche evaporada']);
    expect(shown('tomat', 'en')).toEqual(['tomatoes', 'tomato jam', 'tomato soup', 'tomato juice', 'tomato paste']);
    // Spanish names first, a word match included, before the English prefix matches.
    expect(shown('tomat', 'es')).toEqual(['tomate', 'tomate verde', 'puré de tomate', 'pasta de tomate', 'tomatoes']);
    // No Spanish match: the English names as before.
    expect(shown('cuc', 'es')).toEqual(shown('cuc', 'en'));
    // The default is the app's language.
    expect(shown('lech')).toEqual(shown('lech', 'en'));
    initI18n('es');
    expect(shown('lech')).toEqual(shown('lech', 'es'));
    initI18n('en');
  });

  test('suggests recent household items first, then the catalog, keeping a typed amount', () => {
    addItem(listId, 'chicken sausage from the butcher', A);
    const household = groupItems(listItemsQuery(listId).all()); // ensure the add landed
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

describe('ingredientAisles', () => {
  test('gives each ingredient its default aisle', () => {
    const aisles = ingredientAisles(home, [key('chicken thighs'), key('chickpeas'), key('milk')]);
    expect(Object.fromEntries(aisles)).toEqual({
      [key('chicken thighs')]: { slug: 'meat-seafood', name: 'Meat & Seafood' },
      [key('chickpeas')]: { slug: 'canned-jarred', name: 'Canned & Jarred' },
      [key('milk')]: { slug: 'dairy-eggs', name: 'Dairy & Eggs' },
    });
  });

  test("uses the household's override, and only that household's", () => {
    setCategoryOverride(home, key('milk'), id('beverages'));
    expect(ingredientAisles(home, [key('milk')]).get(key('milk'))).toEqual({ slug: 'beverages', name: 'Beverages' });
    expect(ingredientAisles(CABIN, [key('milk')]).get(key('milk'))).toEqual({ slug: 'dairy-eggs', name: 'Dairy & Eggs' });
    // A reset override is the default again.
    clearCategoryOverride(home, key('milk'));
    expect(ingredientAisles(home, [key('milk')]).get(key('milk'))).toEqual({ slug: 'dairy-eggs', name: 'Dairy & Eggs' });
  });

  test('gives a custom aisle no slug', () => {
    const custom = createCategory(A, home, 'Asian market');
    setCategoryOverride(home, key('milk'), custom);
    expect(ingredientAisles(home, [key('milk')]).get(key('milk'))).toEqual({ slug: null, name: 'Asian market' });
  });

  test('leaves out pending and unknown ingredients', () => {
    addItem(listId, 'gochujang paste from h mart', A); // pending: not in the seed
    const aisles = ingredientAisles(home, [key('gochujang paste from h mart'), 'not an ingredient']);
    expect(aisles.size).toBe(0);
  });

  test('is empty for no names', () => {
    expect(ingredientAisles(home, []).size).toBe(0);
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
    defaultUnit: null,
    lang: null,
    sameAs: null,
    linkedBy: null,
  });
  const itemNamed = (name: string) =>
    groupItems(listItemsQuery(listId).all()).unchecked.find((i) => i.displayName === name)!;

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
    addItem(listId, 'kashk', A);
    addItem(listId, '2 Dukkah', A);
    expect(pendingNames()).toEqual([{ name: key('kashk'), displayName: 'kashk' }]);
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
    addItemsBulk(listId, [{ text: 'amba' }, { text: 'tomatoes' }, { text: '2 amba' }, { text: 'yuzu kosho' }], A);
    expect(pendingNames()).toEqual(
      sorted([
        { name: key('amba'), displayName: 'amba' },
        { name: key('yuzu kosho'), displayName: 'yuzu kosho' },
      ]),
    );
  });

  test('renaming an item to an unknown name creates a row; other edits do not', () => {
    addItem(listId, 'tomatoes', A);
    const item = itemNamed('tomatoes');
    updateItem(item.id, { name: 'tomatoes', amount: '', note: 'ripe' });
    expect(pendingNames()).toEqual([]);
    updateItem(item.id, { name: 'Tomatillos', amount: '', note: '' });
    expect(rows('Tomatillos')).toEqual([pendingRow('Tomatillos')]);
  });

  test('recipe ingredients: added, parsed and edited names create pending rows', () => {
    const recipe = createRecipe('Shakshuka');
    addRecipeIngredient(recipe, '1 tbsp black garlic');
    addRecipeIngredient(recipe, '2 eggs');
    addParsedRecipeIngredients(recipe, [
      { ingredientName: key('black lime'), displayName: 'black lime', quantity: null, unit: null },
      { ingredientName: key('sumac'), displayName: 'sumac', quantity: null, unit: null },
    ]);
    const feta = addRecipeIngredient(recipe, 'feta')!.id;
    updateRecipeIngredient(feta, '100 g labneh');
    expect(pendingNames()).toEqual(
      sorted([
        { name: key('black garlic'), displayName: 'black garlic' },
        { name: key('labneh'), displayName: 'labneh' },
        { name: key('black lime'), displayName: 'black lime' },
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
    addItem(listId, 'amba', A);
    addItem(listId, 'tomatoes', A);
    addItem(listId, 'old thing', A);
    const recipe = createRecipe('Bibimbap');
    addRecipeIngredient(recipe, 'Doenjang');
    const removed = addRecipeIngredient(recipe, 'removed paste')!.id;
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
        { name: key('amba'), displayName: 'amba' },
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
        defaultUnit: 'lb',
        lang: 'en',
        sameAs: null,
        linkedBy: null,
      },
    ]);
    expect(categoryOf('Tomatoes')).toBe(id('produce'));
  });
});
