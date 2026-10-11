import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, households, ingredients, ingredientUnitUsage, ingredientUsage, lists } from '@/db';
import { resetDb } from '@/test/db';

import {
  addItem,
  addItemsBulk,
  clearChecked,
  contributionsQuery,
  deleteContribution,
  deleteItem,
  DuplicateItemError,
  getItemEdit,
  getItemHouseholdName,
  groupItems,
  listItemsQuery,
  orderByAisle,
  searchRecentItems,
  setItemAmount,
  setItemChecked,
  stepItemAmount,
  steppableAmount,
  uncheckAll,
  undeleteItem,
  undoAdd,
  undoAdds,
  updateItem,
  usualUnitsQuery,
} from '../items';
import { groupByCategory, SORTING_CATEGORY_ID } from '@/domain/category-resolver';
import { groupByRecipe } from '@/domain/recipe-grouping';
import { usualUnitsByKey } from '@/domain/usual-unit';
import { getOrderedCategories, loadCatalogSeed, moveCategory, setCategoryOverride } from '@/features/categories/categories';
import { createRecipe, deleteRecipe } from '@/features/recipes/recipes';
import { SYSTEM_CATEGORIES, type Unit } from '@/shared';

import { orderByNewest } from '../list-view';
import { createList, ensureStarterData, getDefaultListId } from '../lists';
import { listShareText } from '../share';

jest.mock('@/db/client', () => require('@/test/db'));

const USER = 'user-1';
let listId: string;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  listId = getDefaultListId(USER)!;
});

const view = (id = listId) => groupItems(listItemsQuery(id, USER).all(), usualUnitsByKey(usualUnitsQuery(id).all()));
const rows = (items: { displayName: string; amountText: string }[]) =>
  items.map((i) => (i.amountText ? `${i.amountText} ${i.displayName}` : i.displayName));

describe('addItem', () => {
  test('parses the amount off the front and keeps what was typed as the name', () => {
    addItem(listId, '2 lbs chicken thighs', USER);
    addItem(listId, 'two avocados', USER);
    addItem(listId, 'Milk', USER);
    expect(rows(view().unchecked)).toEqual(['2 lb chicken thighs', '2 avocados', 'Milk']);
  });

  test('ignores text with nothing to add', () => {
    expect(addItem(listId, '   ', USER)).toBeNull();
    expect(addItem(listId, '!!', USER)).toBeNull();
    expect(view().unchecked).toHaveLength(0);
  });

  test('combines an add into the open item for the same ingredient', () => {
    const first = addItem(listId, '1 gal milk', USER)!;
    const second = addItem(listId, 'milk', USER)!;
    // The first add made gal milk's usual unit, so the add with no amount counts as 1 gal.
    expect(second).toMatchObject({ itemId: first.itemId, kind: 'combine', existingName: 'milk', totalAmountText: '2 gal' });
    expect(rows(view().unchecked)).toEqual(['2 gal milk']);
  });

  test('sums compatible amounts when combining', () => {
    addItem(listId, '2 lbs chicken thighs', USER);
    addItem(listId, '8 oz chicken thighs', USER);
    expect(rows(view().unchecked)).toEqual(['2.5 lb chicken thighs']);
  });

  test('a checked match is unchecked and its amounts replaced', () => {
    const milk = addItem(listId, '1 gal milk', USER)!;
    setItemChecked(milk.itemId, true, USER);
    const again = addItem(listId, '2 milk', USER)!;
    expect(again).toMatchObject({ itemId: milk.itemId, kind: 'reopen' });
    expect(rows(view().unchecked)).toEqual(['2 milk']);
    expect(view().checked).toHaveLength(0);
  });

  test('lists are independent', () => {
    addItem(listId, 'milk', USER);
    const other = createList('Costco');
    expect(addItem(other, 'milk', USER)!.kind).toBe('new');
    expect(view(other).unchecked).toHaveLength(1);
  });
});

describe('undo and keep existing (spec 4.4)', () => {
  test('undo removes a new item', () => {
    const r = addItem(listId, 'milk', USER)!;
    undoAdd(r);
    expect(view().unchecked).toHaveLength(0);
  });

  test('undo of a combine restores the original row', () => {
    addItem(listId, '1 gal milk', USER);
    const r = addItem(listId, '2 milk', USER)!;
    undoAdd(r);
    expect(rows(view().unchecked)).toEqual(['1 gal milk']);
  });

  test('undo of a reopen puts the checked item and its amounts back', () => {
    const milk = addItem(listId, '1 gal milk', USER)!;
    setItemChecked(milk.itemId, true, USER);
    const r = addItem(listId, '2 milk', USER)!;
    undoAdd(r);
    expect(view().unchecked).toHaveLength(0);
    expect(rows(view().checked)).toEqual(['1 gal milk']);
  });

  test('undo of a combine drops the new amount', () => {
    addItem(listId, '1 gal milk', USER);
    const r = addItem(listId, '2 milk', USER)!;
    undoAdd(r);
    expect(rows(view().unchecked)).toEqual(['1 gal milk']);
  });

  test('the edit sheet lists amounts and can delete one', () => {
    const r = addItem(listId, '1 gal milk', USER)!;
    const second = addItem(listId, '2 milk', USER)!;
    expect(contributionsQuery(r.itemId).all().map((c) => c.quantity)).toEqual([1, 2]);
    deleteContribution(second.contributionId);
    expect(rows(view().unchecked)).toEqual(['1 gal milk']);
  });
});

describe('bulk add (spec 4.4)', () => {
  const adds = [{ text: '2 cups milk' }, { text: '3 eggs' }, { text: '1 tsp salt' }, { text: '1 cup milk' }];

  test('every clash Combines with no question, the total as its row reads', () => {
    addItem(listId, '2 lb chicken thighs', USER);
    addItem(listId, '4 limes', USER);
    const results = addItemsBulk(listId, [{ text: '4 lb chicken thighs' }, { text: '2 limes' }], USER);
    expect(results.map((r) => r?.kind)).toEqual(['combine', 'combine']);
    expect(results.map((r) => r?.totalAmountText)).toEqual(['6 lb', '6']);
    expect(rows(view().unchecked)).toEqual(['6 lb chicken thighs', '6 limes']);
  });

  test('a recipe repeat folds into its first add, which Combines', () => {
    const pie = createRecipe('Pie');
    addItem(listId, '1 cup butter', USER);
    addItemsBulk(
      listId,
      [
        { text: '1/2 cup butter', source: 'recipe', recipeId: pie },
        { text: '4 tbsp butter', source: 'recipe', recipeId: pie },
      ],
      USER,
    );
    expect(rows(view().unchecked)).toEqual(['1¾ cup butter']);
  });

  test('an incoming add with no amount counts as one; a recipe link with none adds nothing', () => {
    addItem(listId, '2 eggs', USER);
    addItemsBulk(listId, [{ text: 'eggs' }], USER);
    expect(rows(view().unchecked)).toEqual(['3 eggs']);
    const tacos = createRecipe('Tacos');
    addItemsBulk(listId, [{ text: 'eggs', source: 'recipe', recipeId: tacos }], USER);
    expect(rows(view().unchecked)).toEqual(['3 eggs']);
  });

  test('combines, folding repeats within the batch', () => {
    addItem(listId, '1 gal milk', USER);
    addItemsBulk(listId, adds, USER);
    expect(rows(view().unchecked)).toEqual(['1¼ gal milk', '3 eggs', '1 tsp salt']); // 1 gal + 3 cups
  });
});

describe('adds with no amount count as one (spec 4.4)', () => {
  // A recipe ingredient with no amount added onto an open item: a link that records the recipe only.
  const recipeLink = (text: string) => {
    const tacos = createRecipe('Tacos');
    addItemsBulk(listId, [{ text, source: 'recipe', recipeId: tacos }], USER);
  };

  test('adding milk twice reads 2, and the combine toast says so', () => {
    const first = addItem(listId, 'milk', USER)!;
    expect(rows(view().unchecked)).toEqual(['milk']);
    const second = addItem(listId, 'milk', USER)!;
    expect(second).toMatchObject({ itemId: first.itemId, kind: 'combine', totalAmountText: '2' });
    expect(rows(view().unchecked)).toEqual(['2 milk']);
    const third = addItem(listId, 'Milk', USER)!;
    expect(third).toMatchObject({ kind: 'combine', totalAmountText: '3' });
  });

  test('an add with no amount joins a unitless count', () => {
    addItem(listId, '2 avocados', USER);
    const r = addItem(listId, 'avocados', USER)!;
    expect(r.totalAmountText).toBe('3');
    expect(rows(view().unchecked)).toEqual(['3 avocados']);
  });

  test('the stored quantities stay null', () => {
    const r = addItem(listId, 'milk', USER)!;
    addItem(listId, 'milk', USER);
    expect(contributionsQuery(r.itemId).all().map((c) => [c.quantity, c.unit])).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  test('the edit sheet shows the count, and saving it unchanged keeps the contributions', () => {
    const r = addItem(listId, 'milk', USER)!;
    addItem(listId, 'milk', USER);
    expect(getItemEdit(r.itemId)).toMatchObject({ amount: '2' });
    const before = contributionsQuery(r.itemId).all();
    updateItem(r.itemId, { name: 'milk', amount: '2', note: '' });
    expect(contributionsQuery(r.itemId).all()).toEqual(before);
    expect(before.map((c) => c.quantity)).toEqual([null, null]);
  });

  test('a recipe link with no amount does not count as one', () => {
    const beef = addItem(listId, '2 lbs ground beef', USER)!;
    recipeLink('ground beef');
    expect(contributionsQuery(beef.itemId).all().map((c) => [c.source, c.quantity])).toEqual([
      ['manual', 2],
      ['recipe', null],
    ]);
    expect(rows(view().unchecked)).toEqual(['2 lb ground beef']);
    expect(getItemEdit(beef.itemId)).toMatchObject({ amount: '2 lb' });
  });

  test('a manual add with no amount plus a link still reads empty', () => {
    const milk = addItem(listId, 'milk', USER)!;
    recipeLink('milk');
    expect(contributionsQuery(milk.itemId).all()).toHaveLength(2);
    expect(rows(view().unchecked)).toEqual(['milk']);
    expect(getItemEdit(milk.itemId)).toMatchObject({ amount: '' });
  });
});

describe('usual unit in totals (spec 4.2, 4.4)', () => {
  const householdId = () => db.select({ id: lists.householdId }).from(lists).where(eq(lists.id, listId)).get()!.id;
  const seedUnit = (ingredientName: string, unitKey: string, useCount: number, household = householdId()) =>
    db
      .insert(ingredientUnitUsage)
      .values({ householdId: household, ingredientName, unitKey, useCount, lastUsedAt: new Date() })
      .run();

  test('1 gal milk twice, then milk: the row reads 3 gal and the toast says so', () => {
    addItem(listId, '1 gal milk', USER);
    addItem(listId, '1 gal milk', USER);
    const third = addItem(listId, 'milk', USER)!;
    expect(third).toMatchObject({ kind: 'combine', totalAmountText: '3 gal' });
    expect(rows(view().unchecked)).toEqual(['3 gal milk']);
    expect(view().unchecked[0].usualUnit).toBe('gal');
    expect(getItemEdit(third.itemId)).toMatchObject({ amount: '3 gal', usualUnit: 'gal' });
  });

  test('with no unit history, an add with no amount is a plain 1', () => {
    const milk = addItem(listId, '1 gal milk', USER)!;
    addItem(listId, 'milk', USER);
    db.delete(ingredientUnitUsage).run();
    expect(rows(view().unchecked)).toEqual(['1 gal + 1 milk']);
    expect(view().unchecked[0].usualUnit).toBeNull();
    expect(getItemEdit(milk.itemId)).toMatchObject({ amount: '1 gal + 1', usualUnit: null });
    expect(addItem(listId, 'milk', USER)!.totalAmountText).toBe('1 gal + 2');
  });

  test('a count as the usual unit keeps the add with no amount unitless', () => {
    addItem(listId, '1 gal milk', USER);
    seedUnit('milk', 'count', 3);
    const r = addItem(listId, 'milk', USER)!;
    expect(r.totalAmountText).toBe('1 gal + 1');
    expect(rows(view().unchecked)).toEqual(['1 gal + 1 milk']);
  });

  test('a usual unit from another household does not apply', () => {
    db.insert(households).values({ id: 'other', name: 'Other' }).run();
    seedUnit('milk', 'gal', 5, 'other');
    const milk = addItem(listId, 'milk', USER)!;
    expect(addItem(listId, 'milk', USER)!.totalAmountText).toBe('2');
    expect(rows(view().unchecked)).toEqual(['2 milk']);
    expect(getItemEdit(milk.itemId)).toMatchObject({ amount: '2', usualUnit: null });
    expect(usualUnitsQuery(listId).all()).toEqual([]);
  });

  test('usualUnitsQuery reads only the list household’s rows for keys on the list', () => {
    db.insert(households).values({ id: 'other', name: 'Other' }).run();
    addItem(listId, '2 lbs chicken thighs', USER);
    const flour = addItem(listId, 'flour', USER)!;
    deleteItem(flour.itemId);
    seedUnit('flour', 'cup', 2); // its item is deleted
    seedUnit('egg', 'dozen', 2); // not on the list
    seedUnit('chicken thigh', 'kg', 9, 'other');
    expect(usualUnitsQuery(listId).all().map((r) => [r.ingredientName, r.unitKey, r.useCount])).toEqual([
      ['chicken thigh', 'lb', 1],
    ]);
  });

  test('the usual unit is converted into, and other units stay apart', () => {
    addItem(listId, '8 oz chicken thighs', USER);
    seedUnit('chicken thigh', 'lb', 3);
    expect(addItem(listId, 'chicken thighs', USER)!.totalAmountText).toBe('1.5 lb');
    addItem(listId, '400 g tomatoes', USER);
    seedUnit('tomato', 'can', 4);
    expect(addItem(listId, 'tomatoes', USER)!.totalAmountText).toBe('400 g + 1 can');
    expect(rows(view().unchecked)).toEqual(['1.5 lb chicken thighs', '400 g + 1 can tomatoes']);
  });

  test('a lone add with no amount still reads empty', () => {
    seedUnit('milk', 'gal', 4);
    const milk = addItem(listId, 'milk', USER)!;
    expect(rows(view().unchecked)).toEqual(['milk']);
    expect(getItemEdit(milk.itemId)).toMatchObject({ amount: '' });
  });

  test('saving the edit sheet unchanged keeps the contributions', () => {
    const milk = addItem(listId, '1 gal milk', USER)!;
    addItem(listId, 'milk', USER);
    const before = contributionsQuery(milk.itemId).all();
    updateItem(milk.itemId, { name: 'milk', amount: '2 gal', note: '' });
    expect(contributionsQuery(milk.itemId).all()).toEqual(before);
    expect(before.map((c) => [c.quantity, c.unit])).toEqual([
      [1, 'gal'],
      [null, null],
    ]);
  });

  test('a bulk add Combines with the usual unit, as a single add does', () => {
    addItem(listId, '1 gal milk', USER);
    addItem(listId, 'milk', USER);
    expect(addItemsBulk(listId, [{ text: 'milk' }], USER)).toMatchObject([{ kind: 'combine', totalAmountText: '3 gal' }]);
  });
});

describe('ingredient history (spec 4.2)', () => {
  const T1 = new Date('2026-10-01T12:00:00Z');
  const T2 = new Date('2026-10-03T09:15:00Z');

  afterEach(() => {
    jest.useRealTimers();
  });

  const usage = () =>
    db
      .select({
        householdId: ingredientUsage.householdId,
        ingredientName: ingredientUsage.ingredientName,
        displayName: ingredientUsage.displayName,
        useCount: ingredientUsage.useCount,
        lastUsedAt: ingredientUsage.lastUsedAt,
      })
      .from(ingredientUsage)
      .orderBy(ingredientUsage.ingredientName)
      .all();
  const counts = () => Object.fromEntries(usage().map((u) => [u.ingredientName, u.useCount]));
  const householdId = () => db.select({ id: lists.householdId }).from(lists).where(eq(lists.id, listId)).get()!.id;

  test('addItem records a use with the typed name and the time, in the list household', () => {
    jest.useFakeTimers({ now: T1 });
    addItem(listId, '2 lbs chicken thighs', USER);
    expect(usage()).toEqual([
      { householdId: householdId(), ingredientName: 'chicken thigh', displayName: 'chicken thighs', useCount: 1, lastUsedAt: T1 },
    ]);
  });

  test('a combine counts again and takes the newest typed name', () => {
    jest.useFakeTimers({ now: T1 });
    addItem(listId, '1 gal milk', USER);
    jest.setSystemTime(T2);
    const r = addItem(listId, 'Milk', USER)!;
    expect(r.kind).toBe('combine');
    expect(usage()).toEqual([expect.objectContaining({ ingredientName: 'milk', displayName: 'Milk', useCount: 2, lastUsedAt: T2 })]);
  });

  test('a reopen counts again', () => {
    const milk = addItem(listId, 'milk', USER)!;
    setItemChecked(milk.itemId, true, USER);
    expect(addItem(listId, 'milk', USER)!.kind).toBe('reopen');
    expect(counts()).toEqual({ milk: 2 });
  });

  test('text with nothing to add records nothing', () => {
    addItem(listId, '  ', USER);
    expect(usage()).toEqual([]);
  });

  test('undo of a new item removes its only use', () => {
    const r = addItem(listId, 'mlik', USER)!;
    undoAdd(r);
    expect(usage()).toEqual([]);
  });

  test('undo of a combine or a reopen takes back one use only', () => {
    addItem(listId, '1 gal milk', USER);
    undoAdd(addItem(listId, '2 milk', USER)!);
    expect(counts()).toEqual({ milk: 1 });

    const eggs = addItem(listId, 'eggs', USER)!;
    setItemChecked(eggs.itemId, true, USER);
    undoAdd(addItem(listId, 'eggs', USER)!);
    expect(counts()).toEqual({ egg: 1, milk: 1 });
  });

  test('addItemsBulk counts each add once, including repeats folded within the batch and combines', () => {
    addItem(listId, '1 gal milk', USER);
    addItemsBulk(listId, [{ text: '2 cups milk' }, { text: '3 eggs' }, { text: '1 tsp salt' }, { text: '1 cup milk' }], USER);
    expect(counts()).toEqual({ egg: 1, milk: 3, salt: 1 });
  });

  test('addItemsBulk records nothing for empty text', () => {
    addItem(listId, '1 gal milk', USER);
    expect(addItemsBulk(listId, [{ text: '2 cups milk' }, { text: '!!' }, { text: 'eggs' }], USER)[1]).toBeNull();
    expect(counts()).toEqual({ egg: 1, milk: 2 });
  });

  test('undoAdds takes back every use the bulk add counted', () => {
    addItem(listId, '1 gal milk', USER);
    undoAdds(addItemsBulk(listId, [{ text: '2 cups milk' }, { text: '!!' }, { text: 'eggs' }, { text: 'milk' }], USER));
    expect(counts()).toEqual({ milk: 1 });
  });
});

describe('searchRecentItems (spec 4.2)', () => {
  const NOW = new Date('2026-10-09T12:00:00Z');
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
  const householdId = () => db.select({ id: lists.householdId }).from(lists).where(eq(lists.id, listId)).get()!.id;
  const seed = (
    ingredientName: string,
    displayName: string,
    useCount: number,
    lastUsedAt: Date,
    extra: { hiddenAt?: Date; householdId?: string } = {},
  ) =>
    db
      .insert(ingredientUsage)
      .values({ householdId: extra.householdId ?? householdId(), ingredientName, displayName, useCount, lastUsedAt, hiddenAt: extra.hiddenAt ?? null })
      .run();
  const search = (q: string, limit = 5) => searchRecentItems(householdId(), q, limit, NOW);

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns key and latest display name from ingredient history', () => {
    seed('chicken thigh', 'Chicken Thighs', 2, daysAgo(1));
    expect(search('chi')).toEqual([{ key: 'chicken thigh', displayName: 'Chicken Thighs' }]);
  });

  test('an item used 5 times outranks one used once yesterday', () => {
    seed('chicken breast', 'chicken breast', 1, daysAgo(1));
    seed('chicken thigh', 'chicken thighs', 5, daysAgo(10));
    expect(search('chi').map((s) => s.key)).toEqual(['chicken thigh', 'chicken breast']);
  });

  test('a deleted list item stays in history', () => {
    jest.useFakeTimers({ now: daysAgo(2) });
    const r = addItem(listId, '2 lbs chicken thighs', USER)!;
    deleteItem(r.itemId);
    jest.useRealTimers();
    expect(view().unchecked).toEqual([]);
    expect(search('chi')).toEqual([{ key: 'chicken thigh', displayName: 'chicken thighs' }]);
  });

  test('an undone add leaves nothing to suggest', () => {
    undoAdd(addItem(listId, 'chiken', USER)!);
    expect(search('chi')).toEqual([]);
  });

  test('matches the start of a word, not the middle of one', () => {
    seed('chicken thigh', 'chicken thighs', 1, daysAgo(1));
    seed('pistachio', 'pistachios', 1, daysAgo(1));
    expect(search('thi').map((s) => s.key)).toEqual(['chicken thigh']);
    expect(search('chio')).toEqual([]);
  });

  test('a row whose key matches but display name does not still reaches the ranking', () => {
    seed('zaatar', "za'atar", 1, daysAgo(1));
    expect(search('zaa')).toEqual([{ key: 'zaatar', displayName: "za'atar" }]);
  });

  test('a whole-name prefix beats a word match at equal score', () => {
    seed('cream cheese', 'cream cheese', 1, daysAgo(3));
    seed('cheese', 'cheese', 1, daysAgo(3));
    expect(search('chee').map((s) => s.key)).toEqual(['cheese', 'cream cheese']);
  });

  test('leaves out hidden rows and other households', () => {
    db.insert(households).values({ id: 'other', name: 'Other' }).run();
    seed('chicken thigh', 'chicken thighs', 3, daysAgo(1), { hiddenAt: daysAgo(0) });
    seed('chickpea', 'chickpeas', 3, daysAgo(1), { householdId: 'other' });
    seed('chive', 'chives', 1, daysAgo(1));
    expect(search('chi').map((s) => s.key)).toEqual(['chive']);
  });

  test('applies the limit after ranking', () => {
    seed('chive', 'chives', 1, daysAgo(1));
    seed('chili', 'chili', 2, daysAgo(1));
    seed('chicken thigh', 'chicken thighs', 9, daysAgo(1));
    expect(search('chi', 2).map((s) => s.key)).toEqual(['chicken thigh', 'chili']);
  });

  test('case and surrounding space in the query are ignored', () => {
    seed('milk', 'Milk', 1, daysAgo(1));
    expect(search('  MIL ')).toEqual([{ key: 'milk', displayName: 'Milk' }]);
  });

  test('an empty query or LIKE wildcards alone return nothing', () => {
    seed('milk', 'milk', 1, daysAgo(1));
    expect(search('')).toEqual([]);
    expect(search('  ')).toEqual([]);
    expect(search('%')).toEqual([]);
    expect(search('_')).toEqual([]);
  });

  test('a wildcard in the query is treated as nothing, not as any character', () => {
    seed('milk', 'milk', 1, daysAgo(1));
    expect(search('m_lk')).toEqual([]);
    expect(search('mi%')).toEqual([{ key: 'milk', displayName: 'milk' }]);
  });
});

describe('check, delete, undo', () => {
  test('checking moves an item to checked, most recent first', () => {
    const a = addItem(listId, 'apples', USER)!;
    const b = addItem(listId, 'bread', USER)!;
    setItemChecked(a.itemId, true, USER);
    setItemChecked(b.itemId, true, USER);
    expect(view().unchecked).toHaveLength(0);
    expect(view().checked.map((i) => i.displayName)).toContain('apples');
    setItemChecked(a.itemId, false, USER);
    expect(rows(view().unchecked)).toEqual(['apples']);
  });

  test('unchecking merges into an open item for the same ingredient', () => {
    const old = addItem(listId, '1 gal milk', USER)!;
    setItemChecked(old.itemId, true, USER);
    // Adding milk now would reopen the checked one, so get an open copy by renaming.
    const other = addItem(listId, '2 oat milk', USER)!;
    updateItem(other.itemId, { name: 'milk', amount: '2', note: '' });
    setItemChecked(old.itemId, false, USER);
    expect(rows(view().unchecked)).toEqual(['1 gal + 2 milk']) // amounts in the order they were added;
    expect(view().checked).toHaveLength(0);
  });

  test('delete and undo', () => {
    const eggs = addItem(listId, '12 eggs', USER)!;
    deleteItem(eggs.itemId);
    expect(view().unchecked).toHaveLength(0);
    undeleteItem(eggs.itemId);
    expect(rows(view().unchecked)).toEqual(['12 eggs']);
  });

  test('undoing a delete keeps a checked item checked', () => {
    const eggs = addItem(listId, 'eggs', USER)!;
    setItemChecked(eggs.itemId, true, USER);
    deleteItem(eggs.itemId);
    undeleteItem(eggs.itemId);
    expect(view().checked).toHaveLength(1);
  });

  test('undoing a delete after re-adding the same ingredient combines them', () => {
    const eggs = addItem(listId, '12 eggs', USER)!;
    deleteItem(eggs.itemId);
    addItem(listId, '6 eggs', USER);
    undeleteItem(eggs.itemId);
    expect(rows(view().unchecked)).toEqual(['18 eggs']);
  });

  test('clear checked and uncheck all', () => {
    const a = addItem(listId, 'apples', USER)!;
    const b = addItem(listId, 'bread', USER)!;
    addItem(listId, 'cheese', USER);
    setItemChecked(a.itemId, true, USER);
    setItemChecked(b.itemId, true, USER);
    uncheckAll(listId);
    expect(view().unchecked).toHaveLength(3);
    setItemChecked(a.itemId, true, USER);
    expect(clearChecked(listId)).toBe(1);
    expect(rows(view().unchecked)).toEqual(['bread', 'cheese']);
    expect(view().checked).toHaveLength(0);
  });

  test('uncheck all merges two checked copies of the same ingredient', () => {
    const first = addItem(listId, '1 milk', USER)!;
    setItemChecked(first.itemId, true, USER);
    const second = addItem(listId, '2 oat milk', USER)!;
    updateItem(second.itemId, { name: 'milk', amount: '2', note: '' });
    setItemChecked(second.itemId, true, USER);
    uncheckAll(listId);
    expect(view().unchecked).toHaveLength(1);
    expect(view().unchecked[0].amounts).toHaveLength(2);
  });
});

describe('updateItem', () => {
  test('edits name, amount and note', () => {
    const item = addItem(listId, '2 lbs chicken thighs', USER)!;
    expect(getItemEdit(item.itemId)).toEqual({
      name: 'chicken thighs',
      amount: '2 lb',
      note: '',
      ingredientName: 'chicken thigh',
      usualUnit: 'lb',
    });
    updateItem(item.itemId, { name: 'Chicken breasts', amount: '1.5 lb', note: ' boneless ' });
    expect(view().unchecked[0]).toMatchObject({ displayName: 'Chicken breasts', amountText: '1.5 lb', note: 'boneless' });
  });

  test('leaves combined amounts alone unless they change, then replaces them', () => {
    const item = addItem(listId, '2 cans tomatoes', USER)!;
    addItem(listId, '400 g tomatoes', USER);
    updateItem(item.itemId, { name: 'tomatoes', amount: '2 can + 400 g', note: '' });
    expect(view().unchecked[0].amounts).toHaveLength(2);
    expect(view().unchecked[0].amountText).toBe('2 can + 400 g');
    updateItem(item.itemId, { name: 'tomatoes', amount: '3 can', note: '' });
    expect(view().unchecked[0].amounts).toEqual([{ quantity: 3, unit: 'can' }]);
    updateItem(item.itemId, { name: 'milk', amount: '', note: '' });
    expect(view().unchecked[0].amountText).toBe('');
  });

  test('rejects a rename onto another open item, and bad amounts', () => {
    addItem(listId, 'milk', USER);
    const eggs = addItem(listId, 'eggs', USER)!;
    expect(() => updateItem(eggs.itemId, { name: 'Milk', amount: '', note: '' })).toThrow(DuplicateItemError);
    expect(() => updateItem(eggs.itemId, { name: 'eggs', amount: 'lots', note: '' })).toThrow(/isn't an amount/);
    expect(() => updateItem(eggs.itemId, { name: ' ', amount: '', note: '' })).toThrow();
    expect(rows(view().unchecked)).toEqual(['milk', 'eggs']);
  });
});

describe('changing an amount (spec 4.4)', () => {
  // A recipe ingredient with no amount added onto an open item: a link that records the recipe only.
  const recipeLink = (text: string) => {
    const tacos = createRecipe('Tacos');
    addItemsBulk(listId, [{ text, source: 'recipe', recipeId: tacos }], USER);
  };
  const amounts = (itemId: string) =>
    contributionsQuery(itemId)
      .all()
      .map((c) => [c.source, c.quantity, c.unit])
      .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  const c = (quantity: number | null, unit: Unit | null = null, source = 'manual') => ({ quantity, unit, source });

  describe('steppableAmount', () => {
    test('a single amount', () => {
      expect(steppableAmount([c(2, 'lb')])).toEqual({ quantity: 2, unit: 'lb' });
      expect(steppableAmount([c(400, 'g', 'recipe')], 'can')).toEqual({ quantity: 400, unit: 'g' });
    });

    test('a same-unit sum, counting no amount as the usual unit', () => {
      expect(steppableAmount([c(1, 'gal'), c(2, 'gal')])).toEqual({ quantity: 3, unit: 'gal' });
      expect(steppableAmount([c(1, 'gal'), c(null)], 'gal')).toEqual({ quantity: 2, unit: 'gal' });
      expect(steppableAmount([c(null), c(null)])).toEqual({ quantity: 2, unit: null });
    });

    test('a convertible sum', () => {
      expect(steppableAmount([c(2, 'lb'), c(8, 'oz')])).toEqual({ quantity: 2.5, unit: 'lb' });
    });

    test('mixed units are null', () => {
      expect(steppableAmount([c(2, 'can'), c(400, 'g')])).toBeNull();
      expect(steppableAmount([c(1, 'cup'), c(1, 'tsp')])).toBeNull();
      expect(steppableAmount([c(1, 'gal'), c(null)])).toBeNull();
    });

    test('nothing is one of the usual unit, or a count of one', () => {
      expect(steppableAmount([], 'gal')).toEqual({ quantity: 1, unit: 'gal' });
      expect(steppableAmount([])).toEqual({ quantity: 1, unit: null });
      expect(steppableAmount([c(null)], 'lb')).toEqual({ quantity: 1, unit: 'lb' });
    });

    test('a recipe link with no quantity does not count', () => {
      expect(steppableAmount([c(2, 'lb'), c(null, null, 'recipe')])).toEqual({ quantity: 2, unit: 'lb' });
      expect(steppableAmount([c(null, null, 'recipe')], 'gal')).toEqual({ quantity: 1, unit: 'gal' });
    });
  });

  describe('stepItemAmount', () => {
    test('steps a single amount in place and updates the row', () => {
      const beef = addItem(listId, '2 lbs ground beef', USER)!;
      expect(stepItemAmount(beef.itemId, 1, 'lb')).toEqual({ quantity: 2.5, unit: 'lb' });
      expect(contributionsQuery(beef.itemId).all().map((x) => [x.id, x.quantity, x.unit])).toEqual([
        [beef.contributionId, 2.5, 'lb'],
      ]);
      expect(rows(view().unchecked)).toEqual(['2.5 lb ground beef']);
      expect(stepItemAmount(beef.itemId, -1, 'lb')).toEqual({ quantity: 2, unit: 'lb' });
      expect(rows(view().unchecked)).toEqual(['2 lb ground beef']);
    });

    test('replaces several amounts with the one stepped amount', () => {
      const beef = addItem(listId, '2 lbs ground beef', USER)!;
      addItem(listId, '8 oz ground beef', USER);
      expect(stepItemAmount(beef.itemId, 1, 'lb')).toEqual({ quantity: 3, unit: 'lb' });
      expect(amounts(beef.itemId)).toEqual([['manual', 3, 'lb']]);
      expect(rows(view().unchecked)).toEqual(['3 lb ground beef']);
    });

    test('an add with no amount steps from one of the usual unit', () => {
      const milk = addItem(listId, '1 gal milk', USER)!;
      addItem(listId, 'milk', USER);
      expect(rows(view().unchecked)).toEqual(['2 gal milk']);
      expect(stepItemAmount(milk.itemId, 1, 'gal')).toEqual({ quantity: 3, unit: 'gal' });
      expect(amounts(milk.itemId)).toEqual([['manual', 3, 'gal']]);
      expect(rows(view().unchecked)).toEqual(['3 gal milk']);
    });

    test('a lone add with no amount steps from one, with or without a usual unit', () => {
      const milk = addItem(listId, 'milk', USER)!;
      expect(stepItemAmount(milk.itemId, 1, null)).toEqual({ quantity: 2, unit: null });
      expect(rows(view().unchecked)).toEqual(['2 milk']);

      const bread = addItem(listId, 'bread', USER)!;
      expect(stepItemAmount(bread.itemId, 1, 'box')).toEqual({ quantity: 2, unit: 'box' });
      expect(amounts(bread.itemId)).toEqual([['manual', 2, 'box']]);
    });

    test('− at one step changes nothing', () => {
      const milk = addItem(listId, 'milk', USER)!;
      const before = contributionsQuery(milk.itemId).all();
      expect(stepItemAmount(milk.itemId, -1, null)).toBeNull();
      expect(contributionsQuery(milk.itemId).all()).toEqual(before);
      expect(rows(view().unchecked)).toEqual(['milk']);
    });

    test('a total that is not one amount changes nothing', () => {
      const tomatoes = addItem(listId, '2 cans tomatoes', USER)!;
      addItem(listId, '400 g tomatoes', USER);
      const before = contributionsQuery(tomatoes.itemId).all();
      expect(stepItemAmount(tomatoes.itemId, 1, null)).toBeNull();
      expect(stepItemAmount(tomatoes.itemId, -1, 'can')).toBeNull();
      expect(contributionsQuery(tomatoes.itemId).all()).toEqual(before);
      expect(rows(view().unchecked)).toEqual(['2 can + 400 g tomatoes']);
    });

    test('keeps recipe links with no quantity', () => {
      const beef = addItem(listId, '2 lbs ground beef', USER)!;
      addItem(listId, '8 oz ground beef', USER);
      recipeLink('ground beef');
      expect(stepItemAmount(beef.itemId, -1, 'lb')).toEqual({ quantity: 2, unit: 'lb' });
      expect(amounts(beef.itemId)).toEqual([
        ['manual', 2, 'lb'],
        ['recipe', null, null],
      ]);
      const [item] = view().unchecked;
      expect(item.amountText).toBe('2 lb');
      expect(item.contributions.map((x) => x.recipeName)).toContain('Tacos');
    });

    test('throws for a missing item', () => {
      expect(() => stepItemAmount('nope', 1, null)).toThrow(/No list item nope/);
    });
  });

  describe('setItemAmount', () => {
    test('replaces the amounts with the one amount', () => {
      const milk = addItem(listId, 'milk', USER)!;
      addItem(listId, 'milk', USER);
      setItemAmount(milk.itemId, { quantity: 1, unit: 'gal' });
      expect(amounts(milk.itemId)).toEqual([['manual', 1, 'gal']]);
      expect(rows(view().unchecked)).toEqual(['1 gal milk']);
    });

    test('changes a single amount in place', () => {
      const beef = addItem(listId, '2 lbs ground beef', USER)!;
      setItemAmount(beef.itemId, { quantity: 500, unit: 'g' });
      expect(contributionsQuery(beef.itemId).all().map((x) => [x.id, x.quantity, x.unit])).toEqual([
        [beef.contributionId, 500, 'g'],
      ]);
      expect(rows(view().unchecked)).toEqual(['500 g ground beef']);
    });

    test('keeps recipe links with no quantity, and adds an amount beside a lone link', () => {
      const beef = addItem(listId, '2 lbs ground beef', USER)!;
      recipeLink('ground beef');
      setItemAmount(beef.itemId, { quantity: 3, unit: 'lb' });
      expect(amounts(beef.itemId)).toEqual([
        ['manual', 3, 'lb'],
        ['recipe', null, null],
      ]);
      expect(rows(view().unchecked)).toEqual(['3 lb ground beef']);

      // A recipe ingredient with no quantity: the item has only a link.
      const tacos = createRecipe('Tacos');
      addItemsBulk(listId, [{ text: 'salsa', source: 'recipe', recipeId: tacos }], USER);
      const salsa = view().unchecked.find((i) => i.ingredientName === 'salsa')!;
      setItemAmount(salsa.id, { quantity: 2, unit: 'jar' });
      expect(amounts(salsa.id)).toEqual([
        ['manual', 2, 'jar'],
        ['recipe', null, null],
      ]);
      expect(view().unchecked.find((i) => i.id === salsa.id)!.amountText).toBe('2 jar');
    });

    test('throws for a missing item', () => {
      expect(() => setItemAmount('nope', { quantity: 1, unit: null })).toThrow(/No list item nope/);
    });
  });
});

test('share text lists unchecked items with amounts and notes', () => {
  addItem(listId, '2 lbs chicken thighs', USER);
  const milk = addItem(listId, 'milk', USER)!;
  updateItem(milk.itemId, { name: 'milk', amount: '', note: 'oat' });
  expect(listShareText('Groceries', view().unchecked)).toBe('Groceries\n- 2 lb chicken thighs\n- milk (oat)');
});

describe('Sorting section (spec 4.3.1)', () => {
  const categoryId = (slug: string) => SYSTEM_CATEGORIES.find((c) => c.slug === slug)!.id;
  const sections = () =>
    groupByCategory(getOrderedCategories(USER), view().unchecked).map((s) => [
      s.category.name,
      s.items.map((i) => i.displayName),
    ]);

  beforeEach(() => loadCatalogSeed());

  test('an unknown item is grouped under Sorting and a seed item under its category', () => {
    addItem(listId, 'milk', USER);
    addItem(listId, 'dukkah', USER);
    const [milk, dukkah] = view().unchecked;
    expect(milk.categoryId).toBe(categoryId('dairy-eggs'));
    expect(dukkah.categoryId).toBe(SORTING_CATEGORY_ID);
    expect(sections()).toEqual([
      ['Sorting...', ['dukkah']],
      ['Dairy & Eggs', ['milk']],
    ]);
  });

  test('an item with no ingredient row is under Sorting', () => {
    addItem(listId, 'dukkah', USER);
    db.delete(ingredients).where(eq(ingredients.normalizedName, 'dukkah')).run();
    expect(view().unchecked[0].categoryId).toBe(SORTING_CATEGORY_ID);
  });

  test('a failed ingredient goes to Other, and an override moves an item out of Sorting', () => {
    addItem(listId, 'dukkah', USER);
    addItem(listId, 'flux capacitor', USER);
    db.update(ingredients).set({ status: 'failed' }).where(eq(ingredients.normalizedName, 'flux capacitor')).run();
    setCategoryOverride(USER, 'dukkah', categoryId('spices'));
    expect(sections()).toEqual([
      ['Spices & Seasonings', ['dukkah']],
      ['Other', ['flux capacitor']],
    ]);
  });
});

describe('item sheet "Added" rows and household (board 04)', () => {
  const addFromRecipe = (recipeId: string) =>
    addItemsBulk(listId, [{ text: '1 cup milk', source: 'recipe', recipeId }], USER);

  test('contributionsQuery says who added each amount and from which recipe', () => {
    const milk = addItem(listId, '1 gal milk', USER)!;
    addFromRecipe(createRecipe('Lasagne'));
    expect(contributionsQuery(milk.itemId).all().map((c) => [c.source, c.addedBy, c.recipeName])).toEqual([
      ['manual', USER, null],
      ['recipe', USER, 'Lasagne'],
    ]);
  });

  test('a deleted recipe no longer names its amount', () => {
    const milk = addItem(listId, '1 gal milk', USER)!;
    const lasagne = createRecipe('Lasagne');
    addFromRecipe(lasagne);
    deleteRecipe(lasagne);
    expect(contributionsQuery(milk.itemId).all().map((c) => [c.source, c.recipeId, c.recipeName])).toEqual([
      ['manual', null, null],
      ['recipe', null, null],
    ]);
  });

  test('getItemHouseholdName reads the name of the household the item belongs to', () => {
    const milk = addItem(listId, 'milk', USER)!;
    const householdId = db.select({ id: lists.householdId }).from(lists).where(eq(lists.id, listId)).get()!.id;
    db.update(households).set({ name: 'Our place' }).where(eq(households.id, householdId)).run();
    expect(getItemHouseholdName(milk.itemId)).toBe('Our place');
  });

  test('getItemHouseholdName is null for a deleted or unknown item', () => {
    const milk = addItem(listId, 'milk', USER)!;
    deleteItem(milk.itemId);
    expect(getItemHouseholdName(milk.itemId)).toBeNull();
    expect(getItemHouseholdName('no-such-item')).toBeNull();
  });
});

describe('Newest view (spec 4.6)', () => {
  const T0 = new Date('2026-10-10T09:00:00Z');
  const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
  const newest = () => orderByNewest(view().unchecked).map((i) => i.displayName);

  afterEach(() => {
    jest.useRealTimers();
  });

  test('groupItems carries the item and amount times and amount ids', () => {
    jest.useFakeTimers({ now: at(0) });
    const milk = addItem(listId, '1 gal milk', USER)!;
    jest.setSystemTime(at(5));
    const more = addItem(listId, 'milk', USER)!;
    const [item] = view().unchecked;
    expect(item.createdAt).toEqual(at(0));
    expect(item.contributions.map((c) => [c.id, c.createdAt])).toEqual([
      [milk.contributionId, at(0)],
      [more.contributionId, at(5)],
    ]);
  });

  test('latest add first; a Combine keeps its place; a checked re-add goes to the top', () => {
    jest.useFakeTimers({ now: at(0) });
    const milk = addItem(listId, 'milk', USER)!;
    jest.setSystemTime(at(1));
    addItem(listId, 'eggs', USER);
    jest.setSystemTime(at(2));
    addItem(listId, 'bread', USER);
    expect(newest()).toEqual(['bread', 'eggs', 'milk']);

    jest.setSystemTime(at(3));
    addItem(listId, '2 eggs', USER);
    expect(newest()).toEqual(['bread', 'eggs', 'milk']);

    setItemChecked(milk.itemId, true, USER);
    expect(newest()).toEqual(['bread', 'eggs']);
    jest.setSystemTime(at(4));
    addItem(listId, 'milk', USER);
    expect(newest()).toEqual(['milk', 'bread', 'eggs']);
  });

  test('a recipe add shares one timestamp and keeps its ingredient order as a block', () => {
    jest.useFakeTimers({ now: at(0) });
    addItem(listId, 'milk', USER);
    const tacos = createRecipe('Tacos');
    jest.setSystemTime(at(1));
    addItemsBulk(
      listId,
      ['tortillas', 'onion', 'lime', 'cilantro'].map((text) => ({ text, source: 'recipe' as const, recipeId: tacos })),
      USER,
    );
    const stamps = new Set(view().unchecked.filter((i) => i.displayName !== 'milk').map((i) => i.createdAt.getTime()));
    expect(stamps).toEqual(new Set([at(1).getTime()]));
    jest.setSystemTime(at(2));
    addItem(listId, 'bread', USER);
    expect(newest()).toEqual(['bread', 'tortillas', 'onion', 'lime', 'cilantro', 'milk']);
  });

  test('a checked item re-added by a recipe keeps its ingredient place in the block', () => {
    jest.useFakeTimers({ now: at(0) });
    const lime = addItem(listId, 'lime', USER)!;
    setItemChecked(lime.itemId, true, USER);
    const tacos = createRecipe('Tacos');
    jest.setSystemTime(at(1));
    addItemsBulk(
      listId,
      ['tortillas', 'lime', 'cilantro'].map((text) => ({ text, source: 'recipe' as const, recipeId: tacos })),
      USER,
    );
    expect(newest()).toEqual(['tortillas', 'lime', 'cilantro']);
  });
});

describe('orderByAisle (spec 4.6, By recipe)', () => {
  const cat = (slug: string) => SYSTEM_CATEGORIES.find((c) => c.slug === slug)!.id;
  const T0 = new Date('2026-10-10T09:00:00Z');
  const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
  const item = (id: string, slug: string, minutes: number) => ({
    id,
    categoryId: slug === 'sorting' ? SORTING_CATEGORY_ID : slug === 'unknown' ? 'no-such-category' : cat(slug),
    createdAt: at(minutes),
  });
  const ids = (items: readonly { id: string }[]) => items.map((i) => i.id);

  describe('pure', () => {
    const order = SYSTEM_CATEGORIES.map((c) => ({ id: c.id }));

    test('follows the given aisle order, then when added, then id', () => {
      const items = [
        item('cumin', 'spices', 0),
        item('milk', 'dairy-eggs', 1),
        item('onion', 'produce', 2),
        item('lime', 'produce', 1),
        item('b-eggs', 'dairy-eggs', 1),
      ];
      expect(ids(orderByAisle(items, order))).toEqual(['lime', 'onion', 'b-eggs', 'milk', 'cumin']);
    });

    test('Sorting… comes first whatever the order, oldest first', () => {
      const items = [item('onion', 'produce', 0), item('yuzu', 'sorting', 2), item('dukkah', 'sorting', 1)];
      expect(ids(orderByAisle(items, order))).toEqual(['dukkah', 'yuzu', 'onion']);
    });

    test('a custom order is followed as given', () => {
      const custom = [{ id: cat('spices') }, { id: cat('dairy-eggs') }, { id: cat('produce') }];
      const items = [item('onion', 'produce', 0), item('milk', 'dairy-eggs', 1), item('cumin', 'spices', 2)];
      expect(ids(orderByAisle(items, custom))).toEqual(['cumin', 'milk', 'onion']);
    });

    test('an unknown aisle sorts as Other, or last when Other is not in the order', () => {
      const items = [item('mystery', 'unknown', 0), item('dog food', 'pet', 1), item('foil', 'other', 2)];
      // Pet comes before Other in the store walk; the unknown one shares Other's place, oldest first.
      expect(ids(orderByAisle(items, order))).toEqual(['dog food', 'mystery', 'foil']);
      const noOther = [{ id: cat('pet') }];
      expect(ids(orderByAisle(items, noOther))).toEqual(['dog food', 'mystery', 'foil']);
      expect(ids(orderByAisle([item('mystery', 'unknown', 0), item('onion', 'produce', 1)], noOther))).toEqual([
        'mystery',
        'onion',
      ]);
    });

    test('empty input, and the input is not changed', () => {
      expect(orderByAisle([], order)).toEqual([]);
      const items = [item('milk', 'dairy-eggs', 0), item('onion', 'produce', 1)];
      orderByAisle(items, order);
      expect(ids(items)).toEqual(['milk', 'onion']);
    });
  });

  describe('By recipe on a list', () => {
    beforeEach(() => loadCatalogSeed());
    afterEach(() => {
      jest.useRealTimers();
    });

    const byRecipe = () =>
      groupByRecipe(orderByAisle(view().unchecked, getOrderedCategories(USER))).map((s) => [
        s.name,
        s.entries.map((e) => e.item.displayName),
      ]);
    const addRecipe = (recipeId: string, names: string[]) =>
      addItemsBulk(listId, names.map((text) => ({ text, source: 'recipe' as const, recipeId })), USER);

    test('items in each recipe card and Other items follow the aisle order, Sorting… first', () => {
      jest.useFakeTimers({ now: at(0) });
      addItem(listId, 'milk', USER);
      jest.setSystemTime(at(1));
      addItem(listId, 'bread', USER);
      const tacos = createRecipe('Tacos');
      jest.setSystemTime(at(2));
      addRecipe(tacos, ['cumin', 'cheddar', 'ground beef', 'dukkah', 'tortillas', 'cilantro']);
      expect(byRecipe()).toEqual([
        ['Tacos', ['dukkah', 'cilantro', 'tortillas', 'ground beef', 'cheddar', 'cumin']],
        ['Other items', ['bread', 'milk']],
      ]);
    });

    test('recipe cards keep their order, most recently added first', () => {
      jest.useFakeTimers({ now: at(0) });
      const tacos = createRecipe('Tacos');
      addRecipe(tacos, ['cumin', 'cilantro']);
      const toast = createRecipe('Cheese toast');
      jest.setSystemTime(at(1));
      addRecipe(toast, ['cheddar', 'bread']);
      expect(byRecipe()).toEqual([
        ['Cheese toast', ['bread', 'cheddar']],
        ['Tacos', ['cilantro', 'cumin']],
      ]);
    });

    test("the user's custom order and overrides apply; ties go by when added", () => {
      jest.useFakeTimers({ now: at(0) });
      addItem(listId, 'cumin', USER);
      jest.setSystemTime(at(1));
      addItem(listId, 'cilantro', USER);
      jest.setSystemTime(at(2));
      addItem(listId, 'milk', USER);
      expect(byRecipe()).toEqual([['Other items', ['cilantro', 'milk', 'cumin']]]);

      // Dairy & Eggs to the top of this user's order.
      const dairy = getOrderedCategories(USER).findIndex((c) => c.id === cat('dairy-eggs'));
      moveCategory(USER, dairy, 0);
      expect(byRecipe()).toEqual([['Other items', ['milk', 'cilantro', 'cumin']]]);

      // Cumin moved to Produce for this user: it joins cilantro, and was added first.
      setCategoryOverride(USER, 'cumin', cat('produce'));
      expect(byRecipe()).toEqual([['Other items', ['milk', 'cumin', 'cilantro']]]);
    });
  });
});
