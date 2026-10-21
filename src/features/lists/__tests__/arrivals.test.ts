// A row that arrives while you look (spec 4.1): which changes are arrivals, and what VoiceOver says.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, listItemContributions } from '@/db';
import { initI18n } from '@/i18n';
import { resetDb } from '@/test/db';

import {
  arrivalAnnouncement,
  detectArrivals,
  listContents,
  openSince,
  readListContents,
  type Arrival,
} from '../arrivals';
import { addItem, deleteItem, setItemChecked, type ItemContribution, type ItemView } from '../items';
import { ensureStarterData, getDefaultListId } from '../lists';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'me' }) }));

const ME = 'me';
const ALEX = 'alex';
const SAM = 'sam';
const NOW = new Date('2026-10-16T12:00:00Z');
const FROM = new Date(NOW.getTime() - 2 * 60_000);
const NAMES = new Map([
  [ALEX, 'Alex'],
  [SAM, 'Sam'],
]);

const amount = (id: string, addedBy: string | null, minutesAgo = 0): ItemContribution => ({
  id,
  quantity: null,
  unit: null,
  source: 'manual',
  recipeId: null,
  recipeName: null,
  createdAt: new Date(NOW.getTime() - minutesAgo * 60_000),
  addedBy,
});

const item = (id: string, contributions: ItemContribution[], over: Partial<ItemView> = {}): ItemView => ({
  id,
  ingredientName: id,
  familyKey: id,
  categoryId: 'produce',
  displayName: id,
  note: null,
  checkedAt: null,
  createdAt: NOW,
  amounts: [],
  usualUnit: null,
  amountText: '',
  contributions,
  ...over,
});

const arrival = (itemId: string, userId: string, over: Partial<Arrival> = {}): Arrival => ({
  itemId,
  userId,
  displayName: itemId,
  contributionId: `${itemId}-c`,
  contributionIds: [`${itemId}-c`],
  grow: true,
  ...over,
});

afterEach(() => initI18n('en'));

describe('detectArrivals', () => {
  const before = listContents([item('milk', [amount('m1', ME, 10)]), item('bread', [amount('b1', ALEX, 10)])]);

  test("another member's new item grows in", () => {
    const now = [item('milk', [amount('m1', ME, 10)]), item('limes ', [amount('l1', ALEX)])];
    expect(detectArrivals(before, now, ME, FROM)).toEqual([
      { itemId: 'limes ', userId: ALEX, displayName: 'limes', contributionId: 'l1', contributionIds: ['l1'], grow: true },
    ]);
  });

  test("another member's Combine into an item already there doesn't grow", () => {
    const now = [item('milk', [amount('m1', ME, 10), amount('m2', SAM)])];
    expect(detectArrivals(before, now, ME, FROM)).toEqual([
      { itemId: 'milk', userId: SAM, displayName: 'milk', contributionId: 'm2', contributionIds: ['m2'], grow: false },
    ]);
  });

  test('my own adds, from any device, are never arrivals', () => {
    const now = [item('milk', [amount('m1', ME, 10), amount('m2', ME)]), item('eggs', [amount('e1', ME)])];
    expect(detectArrivals(before, now, ME, FROM)).toEqual([]);
  });

  test('an add with no added_by is not one', () => {
    expect(detectArrivals(before, [item('eggs', [amount('e1', null)])], ME, FROM)).toEqual([]);
  });

  test('what was there when the list was shown is not one, nor is what pull brings that was made before', () => {
    expect(detectArrivals(before, [item('bread', [amount('b1', ALEX, 10)])], ME, FROM)).toEqual([]);
    // Made 3 minutes ago on the server, before the visit (less the skew) began: catching up.
    expect(detectArrivals(before, [item('eggs', [amount('e1', ALEX, 3)])], ME, FROM)).toEqual([]);
    // Just inside the skew: counted.
    expect(detectArrivals(before, [item('eggs', [amount('e1', ALEX, 1)])], ME, FROM)).toHaveLength(1);
  });

  test('a checked item is not one', () => {
    expect(detectArrivals(before, [item('eggs', [amount('e1', ALEX)], { checkedAt: NOW })], ME, FROM)).toEqual([]);
  });

  test('a checked item re-added by another member grows back in', () => {
    const was = listContents([item('eggs', [amount('e1', ME, 10)], { checkedAt: NOW })]);
    expect(detectArrivals(was, [item('eggs', [amount('e2', ALEX)])], ME, FROM)).toEqual([
      { itemId: 'eggs', userId: ALEX, displayName: 'eggs', contributionId: 'e2', contributionIds: ['e2'], grow: true },
    ]);
  });

  test("an item that comes down before its amount still grows in when the amount does", () => {
    const first = [item('milk', [amount('m1', ME, 10)]), item('bread', [amount('b1', ALEX, 10)]), item('limes', [])];
    const was = { contributions: before.contributions, open: openSince(before, first) };
    expect(detectArrivals(before, first, ME, FROM)).toEqual([]);
    expect(was.open.has('limes')).toBe(false);
    const then = [...first.slice(0, 2), item('limes', [amount('l1', ALEX)])];
    expect(detectArrivals(was, then, ME, FROM)).toEqual([arrival('limes', ALEX, { contributionId: 'l1', contributionIds: ['l1'] })]);
    expect(openSince(was, then).has('limes')).toBe(true);
  });

  test('a re-add unchecked before its amount comes down still grows back in', () => {
    const checked = listContents([item('eggs', [amount('e1', ME, 10)], { checkedAt: NOW })]);
    const unchecked = [item('eggs', [amount('e1', ME, 10)])];
    const was = { contributions: checked.contributions, open: openSince(checked, unchecked) };
    expect(was.open.has('eggs')).toBe(false);
    expect(detectArrivals(was, [item('eggs', [amount('e1', ME, 10), amount('e2', ALEX)])], ME, FROM)).toEqual([
      arrival('eggs', ALEX, { contributionId: 'e2', contributionIds: ['e2'] }),
    ]);
  });

  test("an item the live query doesn't show yet is still there: a Combine into it doesn't grow", () => {
    const lagging = { contributions: before.contributions, open: openSince(before, []) };
    expect([...lagging.open].sort()).toEqual(['bread', 'milk']);
    const shown = [item('milk', [amount('m1', ME, 10)]), item('bread', [amount('b1', ALEX, 10)])];
    const caughtUp = { contributions: before.contributions, open: openSince(lagging, shown) };
    expect([...caughtUp.open].sort()).toEqual(['bread', 'milk']);
    const now = [item('milk', [amount('m1', ME, 10), amount('m2', SAM)]), shown[1]];
    expect(detectArrivals(caughtUp, now, ME, FROM)).toEqual([
      arrival('milk', SAM, { contributionId: 'm2', contributionIds: ['m2'], grow: false }),
    ]);
  });

  test('a checked item leaves the items to get', () => {
    expect(openSince(before, [item('milk', [amount('m1', ME, 10)], { checkedAt: NOW })]).has('milk')).toBe(false);
  });

  test('several new amounts on one item: one arrival, by the latest, with them all', () => {
    const now = [item('eggs', [amount('e1', ALEX, 1), amount('e2', SAM, 0)])];
    expect(detectArrivals(before, now, ME, FROM)).toEqual([
      { itemId: 'eggs', userId: SAM, displayName: 'eggs', contributionId: 'e2', contributionIds: ['e1', 'e2'], grow: true },
    ]);
  });

  test('signed out, any member counts', () => {
    expect(detectArrivals(before, [item('eggs', [amount('e1', ME)])], null, FROM)).toHaveLength(1);
  });
});

describe('readListContents', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['queueMicrotask', 'nextTick'] });
    resetDb();
    ensureStarterData(ME);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test("the list's live amounts and its items to get", () => {
    const listId = getDefaultListId(ME)!;
    const milk = addItem(listId, 'milk', ME)!;
    const more = addItem(listId, '2 milk', ALEX)!;
    const eggs = addItem(listId, 'eggs', ME)!;
    const bread = addItem(listId, 'bread', ME)!;
    setItemChecked(eggs.itemId, true, ME);
    deleteItem(bread.itemId);
    db.update(listItemContributions).set({ deletedAt: NOW }).where(eq(listItemContributions.id, more.contributionId)).run();
    const contents = readListContents(listId);
    expect([...contents.contributions].sort()).toEqual([milk.contributionId, eggs.contributionId].sort());
    expect([...contents.open]).toEqual([milk.itemId]);
    expect(readListContents('nope')).toEqual({ contributions: new Set(), open: new Set() });
  });
});

describe('the VoiceOver announcement', () => {
  test('one item names it', () => {
    expect(arrivalAnnouncement([arrival('limes', ALEX)], NAMES, ME)).toBe('Alex added limes');
  });

  test('several from one member are grouped, an item counted once', () => {
    const arrivals = [arrival('limes', ALEX), arrival('eggs', ALEX), arrival('limes', ALEX, { contributionId: 'x' }), arrival('milk', ALEX)];
    expect(arrivalAnnouncement(arrivals, NAMES, ME)).toBe('Alex added 3 items');
    expect(arrivalAnnouncement([arrival('limes', ALEX), arrival('limes', ALEX)], NAMES, ME)).toBe('Alex added limes');
  });

  test('several members: a sentence each, in the order they came', () => {
    const arrivals = [arrival('limes', SAM), arrival('eggs', ALEX), arrival('milk', ALEX)];
    expect(arrivalAnnouncement(arrivals, NAMES, ME)).toBe('Sam added limes. Alex added 2 items');
  });

  test('in Spanish', () => {
    initI18n('es');
    expect(arrivalAnnouncement([arrival('limones', ALEX)], NAMES, ME)).toBe('Alex agregó limones');
    expect(arrivalAnnouncement([arrival('limones', ALEX), arrival('huevos', ALEX)], NAMES, ME)).toBe('Alex agregó 2 artículos');
  });
});
