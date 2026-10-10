import { beforeEach, expect, jest, test } from '@jest/globals';

import { db, households, lists } from '@/db';
import { resetDb } from '@/test/db';

import { groupListsByHousehold } from '../list-view';
import {
  createList,
  deleteList,
  ensureStarterData,
  getDefaultListId,
  listsWithCountsQuery,
  moveList,
  renameList,
  setDefaultList,
  setListArchived,
} from '../lists';
import { addItem, setItemChecked } from '../items';

jest.mock('@/db/client', () => require('@/test/db'));

const USER = 'user-1';

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
});

const names = () => listsWithCountsQuery().all().map((l) => l.name);

test('first run creates Groceries as the default list, once', () => {
  ensureStarterData(USER);
  expect(names()).toEqual(['Groceries']);
  const [groceries] = listsWithCountsQuery().all();
  expect(getDefaultListId(USER)).toBe(groceries.id);
});

test('creates lists at the end and renames them', () => {
  const costco = createList('  Costco ');
  createList('Hardware');
  renameList(costco, 'Costco run');
  renameList(costco, '   '); // ignored
  expect(names()).toEqual(['Groceries', 'Costco run', 'Hardware']);
  expect(() => createList(' ')).toThrow();
});

test('counts unchecked items per list', () => {
  const costco = createList('Costco');
  const [groceries] = listsWithCountsQuery().all();
  addItem(groceries.id, 'milk', USER);
  const eggs = addItem(groceries.id, 'eggs', USER)!;
  addItem(costco, 'paper towels', USER);
  setItemChecked(eggs.itemId, true, USER);
  expect(listsWithCountsQuery().all().map((l) => [l.name, l.uncheckedCount])).toEqual([
    ['Groceries', 1],
    ['Costco', 1],
  ]);
});

test('each list carries its household, for the household groups on the lists home', () => {
  db.insert(households).values({ id: 'lake', name: 'Lake house' }).run();
  db.insert(lists).values({ id: 'weekend', householdId: 'lake', name: 'Weekend up north', position: 0.5 }).run();
  createList('Costco');
  const rows = listsWithCountsQuery().all();
  const personal = rows.find((l) => l.name === 'Groceries')!.householdId;
  expect(rows.map((l) => [l.name, l.householdName])).toEqual([
    ['Weekend up north', 'Lake house'],
    ['Groceries', 'Personal'],
    ['Costco', 'Personal'],
  ]);
  expect(groupListsByHousehold(rows).map((g) => [g.householdId, g.name, g.lists.map((l) => l.name)])).toEqual([
    ['lake', 'Lake house', ['Weekend up north']],
    [personal, 'Personal', ['Groceries', 'Costco']],
  ]);
});

test('creates a list in the household it was asked for', () => {
  db.insert(households).values({ id: 'lake', name: 'Lake house' }).run();
  createList('Weekend up north', 'lake');
  createList('Costco');
  expect(listsWithCountsQuery().all().map((l) => [l.name, l.householdName])).toEqual([
    ['Groceries', 'Personal'],
    ['Weekend up north', 'Lake house'],
    ['Costco', 'Personal'],
  ]);
});

test('reorders by moving one list', () => {
  createList('B');
  createList('C');
  moveList(listsWithCountsQuery().all(), 2, 0);
  expect(names()).toEqual(['C', 'Groceries', 'B']);
  moveList(listsWithCountsQuery().all(), 0, 1);
  expect(names()).toEqual(['Groceries', 'C', 'B']);
});

test('deleted lists disappear; archived lists stay, marked', () => {
  const b = createList('B');
  const c = createList('C');
  deleteList(b);
  setListArchived(c, true);
  const rows = listsWithCountsQuery().all();
  expect(rows.map((l) => [l.name, l.archivedAt !== null])).toEqual([
    ['Groceries', false],
    ['C', true],
  ]);
  setListArchived(c, false);
  expect(listsWithCountsQuery().all()[1].archivedAt).toBeNull();
});

test('the default list falls back to the first remaining list', () => {
  const groceries = getDefaultListId(USER)!;
  const costco = createList('Costco');
  const hardware = createList('Hardware');
  setDefaultList(USER, hardware);
  expect(getDefaultListId(USER)).toBe(hardware);
  setListArchived(hardware, true);
  expect(getDefaultListId(USER)).toBe(groceries);
  deleteList(groceries);
  expect(getDefaultListId(USER)).toBe(costco);
  deleteList(costco);
  expect(getDefaultListId(USER)).toBeNull();
  expect(db.select().from(lists).all()).toHaveLength(3); // soft deletes
});
