import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';

import { categories, db, households, listItemContributions, listItems, lists, userCategoryOverrides, userSettings } from '@/db';
import { resetDb } from '@/test/db';
import { queries, queriesFor, respondTo, resetSupabase } from '@/test/fake-supabase';

import { pushLocalData, toServerRow } from '../dev-push';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));

const at = new Date('2026-10-01T12:00:00Z');
let warn: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  resetDb();
  resetSupabase();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  db.insert(households).values([
    { id: 'h1', name: 'Personal', createdAt: at },
    { id: 'h2', name: 'Not mine on the server', createdAt: at },
  ]).run();
  db.insert(lists).values([
    { id: 'l1', householdId: 'h1', name: 'Groceries', position: 1, createdAt: at },
    { id: 'l2', householdId: 'h2', name: 'Elsewhere', position: 1 },
  ]).run();
  respondTo('household_members', { data: [{ household_id: 'h1' }] });
});

afterEach(() => warn.mockRestore());

const upserted = (table: string) =>
  queriesFor(table).flatMap((q) => q.ops.filter(([op]) => op === 'upsert').flatMap(([, rows]) => rows as object[]));

test('toServerRow uses Postgres column names, ISO dates, and leaves out updated_at', () => {
  const row = db.select().from(lists).all().find((l) => l.id === 'l1')!;
  expect(toServerRow(lists, row)).toEqual({
    id: 'l1',
    household_id: 'h1',
    name: 'Groceries',
    emoji: null,
    position: 1,
    archived_at: null,
    deleted_at: null,
    created_at: '2026-10-01T12:00:00.000Z',
  });
});

test("pushes only the households the user belongs to on the server", async () => {
  const summary = await pushLocalData('u1');
  expect(upserted('lists')).toEqual([expect.objectContaining({ id: 'l1' })]);
  expect(summary).toContainEqual({ table: 'lists', rows: 1 });
});

test('pushes parents before children', async () => {
  db.insert(categories).values({ id: 'c1', name: 'Costco', ownerUserId: 'u1' }).run();
  db.insert(listItems).values({ id: 'i1', listId: 'l1', householdId: 'h1', ingredientName: 'egg', displayName: 'eggs' }).run();
  db.insert(listItemContributions).values({ id: 'k1', listItemId: 'i1', householdId: 'h1', quantity: 12 }).run();
  db.insert(userCategoryOverrides).values({ userId: 'u1', ingredientName: 'egg', categoryId: 'c1' }).run();
  await pushLocalData('u1');
  const order = queries.map((q) => q.table).filter((t, i, all) => all.indexOf(t) === i);
  expect(order.indexOf('categories')).toBeLessThan(order.indexOf('user_category_overrides'));
  expect(order.indexOf('lists')).toBeLessThan(order.indexOf('list_items'));
  expect(order.indexOf('list_items')).toBeLessThan(order.indexOf('list_item_contributions'));
});

test("pushes only the user's own preferences, replacing the server's", async () => {
  db.insert(userSettings).values([
    { userId: 'u1', defaultListId: 'l1' },
    { userId: 'u2', defaultListId: 'l1' },
  ]).run();
  await pushLocalData('u1');
  const ops = queriesFor('user_settings').map((q) => q.ops.map(([op]) => op));
  expect(ops).toEqual([['delete', 'eq'], ['upsert']]);
  expect(upserted('user_settings')).toEqual([{ user_id: 'u1', default_list_id: 'l1' }]);
});

test('sends closed list items before open ones', async () => {
  db.insert(listItems).values([
    { id: 'open', listId: 'l1', householdId: 'h1', ingredientName: 'milk', displayName: 'milk' },
    { id: 'checked', listId: 'l1', householdId: 'h1', ingredientName: 'milk', displayName: 'milk', checkedAt: at },
  ]).run();
  await pushLocalData('u1');
  expect(upserted('list_items').map((r) => (r as { id: string }).id)).toEqual(['checked', 'open']);
});

test('stops at the first failing table and names it', async () => {
  respondTo('lists', { error: { message: 'permission denied for table lists' } });
  await expect(pushLocalData('u1')).rejects.toThrow('lists: permission denied for table lists');
  expect(queriesFor('list_items')).toHaveLength(0);
});
