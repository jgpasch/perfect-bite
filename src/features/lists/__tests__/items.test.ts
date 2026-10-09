import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, ingredientUsage, lists } from '@/db';
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
  groupItems,
  listItemsQuery,
  planBulkAddToList,
  setItemChecked,
  uncheckAll,
  undeleteItem,
  undoAdd,
  updateItem,
} from '../items';
import { createRecipe } from '@/features/recipes/recipes';

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

const view = (id = listId) => groupItems(listItemsQuery(id, USER).all());
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
    expect(second).toMatchObject({ itemId: first.itemId, kind: 'combine', existingName: 'milk', totalAmountText: '1 gal + 1' });
    expect(rows(view().unchecked)).toEqual(['1 gal + 1 milk']);
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

  test('reports conflicts with open items only', () => {
    addItem(listId, '1 gal milk', USER);
    const eggs = addItem(listId, 'eggs', USER)!;
    setItemChecked(eggs.itemId, true, USER);
    expect(planBulkAddToList(listId, adds)).toEqual([
      { index: 0, ingredientName: 'milk', displayName: 'milk', existingAmountText: '1 gal', incomingAmountText: '2 cup' },
    ]);
  });

  test('combines by default, folding repeats within the batch', () => {
    addItem(listId, '1 gal milk', USER);
    addItemsBulk(listId, adds, USER);
    expect(rows(view().unchecked)).toEqual(['1¼ gal milk', '3 eggs', '1 tsp salt']); // 1 gal + 3 cups
  });

  test('keep existing skips a manual add, but keeps a recipe link without a quantity', () => {
    addItem(listId, '1 gal milk', USER);
    addItemsBulk(listId, adds, USER, new Set([0]));
    // The batch's second milk still folds into the first add, which was skipped.
    expect(rows(view().unchecked)).toEqual(['1 gal milk', '3 eggs', '1 tsp salt']);

    resetDb();
    ensureStarterData(USER);
    listId = getDefaultListId(USER)!;
    const tacos = createRecipe('Tacos');
    const recipeAdds = adds.map((a) => ({ ...a, source: 'recipe' as const, recipeId: tacos }));
    const milk = addItem(listId, '1 gal milk', USER)!;
    addItemsBulk(listId, recipeAdds, USER, new Set([0]));
    const amounts = contributionsQuery(milk.itemId).all();
    expect(amounts.map((c) => [c.source, c.quantity])).toEqual([
      ['manual', 1],
      ['recipe', null],
      ['recipe', 1],
    ]);
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

  test('addItemsBulk records nothing for a kept-existing manual add or empty text', () => {
    addItem(listId, '1 gal milk', USER);
    addItemsBulk(listId, [{ text: '2 cups milk' }, { text: '!!' }, { text: 'eggs' }], USER, new Set([0]));
    expect(counts()).toEqual({ egg: 1, milk: 1 });
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
    expect(getItemEdit(item.itemId)).toEqual({ name: 'chicken thighs', amount: '2 lb', note: '', ingredientName: 'chicken thigh' });
    updateItem(item.itemId, { name: 'Chicken breasts', amount: '1.5 lb', note: ' boneless ' });
    expect(view().unchecked[0]).toMatchObject({ displayName: 'Chicken breasts', amountText: '1.5 lb', note: 'boneless' });
  });

  test('leaves combined amounts alone unless they change, then replaces them', () => {
    const item = addItem(listId, '1 gal milk', USER)!;
    addItem(listId, 'milk', USER);
    updateItem(item.itemId, { name: 'milk', amount: '1 gal + 1', note: '' });
    expect(view().unchecked[0].amountText).toBe('1 gal + 1');
    updateItem(item.itemId, { name: 'milk', amount: '2 gal', note: '' });
    expect(view().unchecked[0].amounts).toEqual([{ quantity: 2, unit: 'gal' }]);
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

test('share text lists unchecked items with amounts and notes', () => {
  addItem(listId, '2 lbs chicken thighs', USER);
  const milk = addItem(listId, 'milk', USER)!;
  updateItem(milk.itemId, { name: 'milk', amount: '', note: 'oat' });
  expect(listShareText('Groceries', view().unchecked)).toBe('Groceries\n- 2 lb chicken thighs\n- milk (oat)');
});
