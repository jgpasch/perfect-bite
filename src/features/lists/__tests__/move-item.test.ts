import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, households, ingredientUsage, listItemContributions, listItems } from '@/db';
import { createRecipe } from '@/features/recipes/recipes';
import { resetDb } from '@/test/db';

import {
  addItem,
  addItemsBulk,
  contributionsQuery,
  getMoveTargets,
  groupItems,
  itemStatusQuery,
  listItemsQuery,
  moveItemToList,
  setItemChecked,
  undoMove,
  updateItem,
  usualUnitsQuery,
} from '../items';
import { usualUnitsByKey } from '@/domain/usual-unit';
import { createList, deleteList, ensureStarterData, getDefaultListId, setListArchived } from '../lists';

jest.mock('@/db/client', () => require('@/test/db'));

const USER = 'user-1';
let groceries: string;
let costco: string;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  groceries = getDefaultListId(USER)!;
  costco = createList('Costco');
});

const view = (id: string) => groupItems(listItemsQuery(id, USER).all(), usualUnitsByKey(usualUnitsQuery(id).all()));
/** "1 gal milk" per unchecked item, then "✓ 2 milk" per checked one. */
const rows = (id: string) => {
  const { unchecked, checked } = view(id);
  const text = (i: { displayName: string; amountText: string }) =>
    i.amountText ? `${i.amountText} ${i.displayName}` : i.displayName;
  return [...unchecked.map(text), ...checked.map((i) => `✓ ${text(i)}`)];
};
const add = (listId: string, text: string) => addItem(listId, text, USER)!;

describe('moveItemToList', () => {
  test('with no match there, the item itself moves, keeping its amounts and note', () => {
    const { itemId } = add(groceries, '2 lb chicken thighs');
    add(groceries, '1 gal milk');
    updateItem(itemId, { name: 'chicken thighs', amount: '2 lb', note: 'boneless' });

    const result = moveItemToList(itemId, costco);

    expect(result).toMatchObject({ kind: 'new', itemId, targetItemId: itemId, name: 'chicken thighs', fromListName: 'Groceries' });
    expect(result.totalAmountText).toBeUndefined();
    expect(rows(groceries)).toEqual(['1 gal milk']);
    expect(rows(costco)).toEqual(['2 lb chicken thighs']);
    expect(view(costco).unchecked[0]).toMatchObject({ id: itemId, note: 'boneless' });
  });

  test('an open match on the other list gets the amounts (Combine), and the moved item goes', () => {
    const moving = add(groceries, '1 gal milk');
    const there = add(costco, '1 gal milk');

    const result = moveItemToList(moving.itemId, costco);

    expect(result).toMatchObject({
      kind: 'combine',
      itemId: moving.itemId,
      targetItemId: there.itemId,
      name: 'milk',
      totalAmountText: '2 gal',
      contributionIds: [moving.contributionId],
    });
    expect(rows(groceries)).toEqual([]);
    expect(rows(costco)).toEqual(['2 gal milk']);
    expect(contributionsQuery(there.itemId).all().map((c) => c.id)).toEqual([moving.contributionId, there.contributionId]); // oldest first
    expect(db.select().from(listItems).where(eq(listItems.id, moving.itemId)).get()!.deletedAt).not.toBeNull();
  });

  test('Combine sums incompatible units as an add would, and keeps a recipe amount linked to its recipe', () => {
    const tacos = createRecipe('Tacos');
    const [moving] = addItemsBulk(groceries, [{ text: '2 cans tomatoes', source: 'recipe', recipeId: tacos }], USER);
    add(costco, '400 g tomatoes');

    const result = moveItemToList(moving!.itemId, costco);

    // The toast's total reads as the row does (oldest amount first).
    expect(result.totalAmountText).toBe('2 can + 400 g');
    expect(rows(costco)).toEqual(['2 can + 400 g tomatoes']);
    const recipeAmount = view(costco).unchecked[0].contributions.find((c) => c.source === 'recipe');
    expect(recipeAmount).toMatchObject({ recipeId: tacos, recipeName: 'Tacos', quantity: 2, unit: 'can' });
  });

  test('a checked match is unchecked with its amounts replaced by the moved ones', () => {
    const moving = add(groceries, '1 gal milk');
    const there = add(costco, '2 milk');
    setItemChecked(there.itemId, true, 'user-2');

    const result = moveItemToList(moving.itemId, costco);

    expect(result.kind).toBe('reopen');
    expect(result.targetItemId).toBe(there.itemId);
    expect(result.reopened).toMatchObject({ checkedBy: 'user-2', contributionIds: [there.contributionId] });
    expect(rows(costco)).toEqual(['1 gal milk']);
    expect(itemStatusQuery(there.itemId).get()).toMatchObject({ checkedAt: null, checkedBy: null });
    expect(rows(groceries)).toEqual([]);
  });

  test('a checked item moves as it is, even with the same item open there', () => {
    const moving = add(groceries, '1 gal milk');
    setItemChecked(moving.itemId, true, USER);
    add(costco, '2 milk');

    const result = moveItemToList(moving.itemId, costco);

    expect(result.kind).toBe('new');
    expect(rows(costco)).toEqual(['2 milk', '✓ 1 gal milk']);
    expect(itemStatusQuery(moving.itemId).get()).toMatchObject({ listId: costco, checkedBy: USER });
  });

  test("a move isn't a use: the household's history is unchanged", () => {
    const moving = add(groceries, 'milk');
    add(costco, 'milk');
    const uses = () => db.select().from(ingredientUsage).where(eq(ingredientUsage.ingredientName, 'milk')).get()!.useCount;
    expect(uses()).toBe(2);
    moveItemToList(moving.itemId, costco);
    expect(uses()).toBe(2);
  });

  test('throws for its own list, a list in another household, a deleted list, or a missing item', () => {
    const { itemId } = add(groceries, 'milk');
    db.insert(households).values({ id: 'lake', name: 'Lake house' }).run();
    const lake = createList('Up north', 'lake');
    const gone = createList('Old');
    deleteList(gone);

    expect(() => moveItemToList(itemId, groceries)).toThrow('Milk is already on this list');
    expect(() => moveItemToList(itemId, lake)).toThrow('An item can only move to a list in its household');
    expect(() => moveItemToList(itemId, gone)).toThrow(`No list ${gone}`);
    expect(() => moveItemToList('nope', costco)).toThrow('No list item nope');
    expect(rows(groceries)).toEqual(['milk']);
  });
});

describe('undoMove', () => {
  test('after a Combine, both lists are exactly as they were', () => {
    const moving = add(groceries, '1 gal milk');
    const there = add(costco, '1 gal milk');

    undoMove(moveItemToList(moving.itemId, costco));

    expect(rows(groceries)).toEqual(['1 gal milk']);
    expect(rows(costco)).toEqual(['1 gal milk']);
    expect(view(groceries).unchecked[0].id).toBe(moving.itemId);
    expect(contributionsQuery(there.itemId).all().map((c) => c.id)).toEqual([there.contributionId]);
    expect(contributionsQuery(moving.itemId).all().map((c) => c.id)).toEqual([moving.contributionId]);
  });

  test('after a reopen, the item there is checked again with its old amounts', () => {
    const moving = add(groceries, '1 gal milk');
    const there = add(costco, '2 milk');
    setItemChecked(there.itemId, true, 'user-2');
    const checkedAt = itemStatusQuery(there.itemId).get()!.checkedAt;

    undoMove(moveItemToList(moving.itemId, costco));

    expect(rows(costco)).toEqual(['✓ 2 milk']);
    expect(itemStatusQuery(there.itemId).get()).toEqual({ listId: costco, checkedAt, checkedBy: 'user-2' });
    expect(rows(groceries)).toEqual(['1 gal milk']);
  });

  test('after a plain move, the item goes back to its list', () => {
    const { itemId } = add(groceries, '2 lb chicken thighs');
    undoMove(moveItemToList(itemId, costco));
    expect(rows(costco)).toEqual([]);
    expect(rows(groceries)).toEqual(['2 lb chicken thighs']);
    expect(itemStatusQuery(itemId).get()!.listId).toBe(groceries);
  });

  test('a plain move undone onto an item opened there since folds into it', () => {
    const moving = add(groceries, '1 gal milk');
    const result = moveItemToList(moving.itemId, costco);
    const readded = add(groceries, '1 gal milk');

    undoMove(result);

    expect(rows(costco)).toEqual([]);
    expect(rows(groceries)).toEqual(['2 gal milk']);
    expect(view(groceries).unchecked[0].id).toBe(readded.itemId);
    const moved = db.select().from(listItemContributions).where(eq(listItemContributions.id, moving.contributionId)).get()!;
    expect(moved.listItemId).toBe(readded.itemId);
  });
});

describe('itemStatusQuery (the sheet\'s "Got it" toggle)', () => {
  test('follows the check: who and when, then cleared by "Still need it"', () => {
    const { itemId } = add(groceries, 'milk');
    expect(itemStatusQuery(itemId).get()).toEqual({ listId: groceries, checkedAt: null, checkedBy: null });
    setItemChecked(itemId, true, USER);
    const checked = itemStatusQuery(itemId).get()!;
    expect(checked.checkedBy).toBe(USER);
    expect(checked.checkedAt).toBeInstanceOf(Date);
    setItemChecked(itemId, false, USER);
    expect(itemStatusQuery(itemId).get()).toEqual({ listId: groceries, checkedAt: null, checkedBy: null });
  });

  test('is empty once "Still need it" folds the item into the same one opened since, so the sheet closes', () => {
    const checked = add(groceries, '1 gal milk');
    setItemChecked(checked.itemId, true, USER);
    // Another item renamed to milk is the open milk now.
    const open = add(groceries, '1 gal bread');
    updateItem(open.itemId, { name: 'milk', amount: '1 gal', note: '' });

    setItemChecked(checked.itemId, false, USER);

    expect(itemStatusQuery(checked.itemId).get()).toBeUndefined();
    expect(rows(groceries)).toEqual(['2 gal milk']);
  });
});

describe('getMoveTargets', () => {
  test("the household's other open lists, in order, leaving out archived, deleted and other households' lists", () => {
    const { itemId } = add(groceries, 'milk');
    const hardware = createList('Hardware');
    const archived = createList('Summer');
    setListArchived(archived, true);
    deleteList(createList('Old'));
    db.insert(households).values({ id: 'lake', name: 'Lake house' }).run();
    createList('Up north', 'lake');

    expect(getMoveTargets(itemId)).toEqual([
      { id: costco, name: 'Costco' },
      { id: hardware, name: 'Hardware' },
    ]);
  });

  test('empty when the household has only the one list, or the item is gone', () => {
    deleteList(costco);
    const { itemId } = add(groceries, 'milk');
    expect(getMoveTargets(itemId)).toEqual([]);
    expect(getMoveTargets('nope')).toEqual([]);
  });
});
