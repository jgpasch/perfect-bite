// The current list (spec 4.1): the one last shown on this device, else the default list, else the
// first open list, and the store that tells the List tab to re-read it when another screen picks one.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { getDeviceSetting } from '@/features/settings/device-settings';
import { resetDb } from '@/test/db';

import { openList, resolveCurrentListId, setCurrentList, useCurrentListVersion } from '../current-list';
import { createList, ensureStarterData, getDefaultListId, LAST_OPENED_LIST_KEY, setDefaultList, setLastOpenedList, setListArchived } from '../lists';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
// Remembering the list is real (a device setting); the Siri snapshot write is not.
const mockRecordListOpened = jest.fn((listId: string, _userId: string | null) =>
  require('@/features/lists/lists').setLastOpenedList(listId),
);
jest.mock('@/features/siri/list-snapshot', () => ({
  recordListOpened: (listId: string, userId: string | null) => mockRecordListOpened(listId, userId),
}));

const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({
  router: { navigate: (...args: unknown[]) => mockNavigate(...args), push: jest.fn(), back: jest.fn() },
}));

const USER = 'user-1';
const mockAccount: { current: { userId: string } | null } = { current: { userId: USER } };
jest.mock('@/features/auth/account', () => ({ getAccount: () => mockAccount.current }));

let groceries: string;
let tree: ReactTestRenderer | null = null;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  groceries = getDefaultListId(USER)!;
  mockAccount.current = { userId: USER };
  mockRecordListOpened.mockClear();
  mockNavigate.mockClear();
});

afterEach(() => {
  const shown = tree;
  tree = null;
  act(() => shown?.unmount());
});

const ids = (...list: string[]) => list.map((id) => ({ id }));

describe('resolveCurrentListId', () => {
  test('is the list last shown on this device', () => {
    const costco = createList('Costco');
    setLastOpenedList(costco);
    expect(resolveCurrentListId(ids(groceries, costco), USER)).toBe(costco);
  });

  test('falls back to the default list when none was shown, or the last one is gone', () => {
    const costco = createList('Costco');
    setDefaultList(USER, costco);
    expect(resolveCurrentListId(ids(groceries, costco), USER)).toBe(costco);
    // The last-opened list was archived or deleted: it's no longer among the open lists.
    setLastOpenedList('gone');
    expect(resolveCurrentListId(ids(groceries, costco), USER)).toBe(costco);
  });

  test('falls back to the first open list when the default is not open', () => {
    const costco = createList('Costco');
    const heb = createList('HEB');
    expect(resolveCurrentListId(ids(heb, costco), USER)).toBe(heb);
  });

  test('skips the default list without a signed-in user', () => {
    const costco = createList('Costco');
    setDefaultList(USER, costco);
    expect(resolveCurrentListId(ids(groceries, costco), null)).toBe(groceries);
  });

  test('is the list last shown even before the open lists include it (just made)', () => {
    const costco = createList('Costco');
    setLastOpenedList(costco);
    expect(resolveCurrentListId(ids(groceries), USER)).toBe(costco);
  });

  test('is not an archived list the open lists leave out', () => {
    const costco = createList('Costco');
    setLastOpenedList(costco);
    setListArchived(costco, true);
    expect(resolveCurrentListId(ids(groceries), USER)).toBe(groceries);
  });

  test('is null with no open lists', () => {
    setLastOpenedList(groceries);
    setListArchived(groceries, true);
    expect(resolveCurrentListId([], USER)).toBeNull();
  });
});

describe('setCurrentList', () => {
  test('records the list as opened for the signed-in user, without navigating', () => {
    const costco = createList('Costco');
    setCurrentList(costco);
    expect(mockRecordListOpened).toHaveBeenCalledWith(costco, USER);
    expect(getDeviceSetting(LAST_OPENED_LIST_KEY, null)).toBe(costco);
    expect(resolveCurrentListId(ids(groceries, costco), USER)).toBe(costco);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test('passes no user when signed out', () => {
    mockAccount.current = null;
    setCurrentList(groceries);
    expect(mockRecordListOpened).toHaveBeenCalledWith(groceries, null);
  });
});

describe('useCurrentListVersion', () => {
  function render() {
    const seen: number[] = [];
    const Probe = () => {
      seen.push(useCurrentListVersion());
      return null;
    };
    act(() => {
      tree = create(createElement(Probe));
    });
    return seen;
  }

  test('changes each time a list is picked, re-rendering subscribers', () => {
    const seen = render();
    const start = seen.at(-1)!;
    act(() => setCurrentList(groceries));
    expect(seen.at(-1)).toBe(start + 1);
    act(() => setCurrentList(groceries));
    expect(seen.at(-1)).toBe(start + 2);
  });

  test('stops re-rendering once unmounted', () => {
    const seen = render();
    act(() => tree!.unmount());
    tree = null;
    const renders = seen.length;
    act(() => setCurrentList(groceries));
    expect(seen).toHaveLength(renders);
  });
});

describe('openList', () => {
  test('makes the list current and shows the List tab', () => {
    const costco = createList('Costco');
    const seen: number[] = [];
    const Probe = () => {
      seen.push(useCurrentListVersion());
      return null;
    };
    act(() => {
      tree = create(createElement(Probe));
    });
    const start = seen.at(-1)!;
    act(() => openList(costco));
    expect(mockRecordListOpened).toHaveBeenCalledWith(costco, USER);
    expect(getDeviceSetting(LAST_OPENED_LIST_KEY, null)).toBe(costco);
    expect(seen.at(-1)).toBe(start + 1);
    expect(mockNavigate).toHaveBeenCalledWith('/lists');
  });
});
