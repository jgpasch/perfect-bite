// Last seen per list (spec 4.1): the device's marker for when each list was last on screen, and
// what the rest of the household added to it since.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { AppState, type AppStateStatus } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { db, deviceSettings, listItemContributions } from '@/db';
import { resetDb } from '@/test/db';
import { purgeHousehold } from '@/sync/purge';

import { shoppingOnList } from '../keep-awake';
import { addItem, deleteContribution, deleteItem, setItemChecked } from '../items';
import { getListSeenAt, groupListNews, listNewsSince, markListSeen, SEEN_CLOCK_SKEW_MS, useListSeenMarker } from '../last-seen';
import { createList, currentHouseholdId, deleteList, ensureStarterData, setListArchived } from '../lists';
import { listSeenAtKey } from '../list-view';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('expo-keep-awake', () => ({ activateKeepAwakeAsync: jest.fn(), deactivateKeepAwake: jest.fn() }));

const ME = 'u-me';
const ALEX = 'u-alex';
const SAM = 'u-sam';
const mockAuth: { account: { userId: string } | null } = { account: { userId: ME } };
jest.mock('@/features/auth/account', () => ({ getAccount: () => mockAuth.account }));

const mockApp: { listener: ((s: AppStateStatus) => void) | null } = { listener: null };
const setAppState = (state: AppStateStatus) =>
  Object.defineProperty(AppState, 'currentState', { value: state, configurable: true, writable: true });
jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
  mockApp.listener = listener as (s: AppStateStatus) => void;
  return { remove: () => void (mockApp.listener = null) };
});
const goTo = (state: AppStateStatus) =>
  act(() => {
    setAppState(state);
    mockApp.listener?.(state);
  });

const T0 = new Date('2026-10-16T12:00:00.000Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

let L: string;

beforeEach(() => {
  resetDb();
  ensureStarterData(ME);
  L = createList('Groceries');
  mockAuth.account = { userId: ME };
  setAppState('active');
});

describe('the marker', () => {
  let tree: ReactTestRenderer | null;

  function Probe({ id, pathname }: { id: string; pathname: string }) {
    useListSeenMarker(id, shoppingOnList(pathname, id));
    return null;
  }

  const show = (pathname: string, id = L) =>
    act(() => {
      if (tree) tree.update(<Probe id={id} pathname={pathname} />);
      else tree = create(<Probe id={id} pathname={pathname} />);
    });
  const at = (date: Date) => jest.setSystemTime(date);
  const seenAt = (id = L) => getListSeenAt(id)?.toISOString() ?? null;

  beforeEach(() => {
    tree = null;
    jest.useFakeTimers({ now: T0 });
  });

  afterEach(() => {
    act(() => tree?.unmount());
    jest.useRealTimers();
  });

  test('a list shown for the first time on this device is marked at once', () => {
    expect(seenAt()).toBeNull();
    show('/lists');
    expect(seenAt()).toBe(T0.toISOString());
  });

  test('an existing marker stays put while the list is on screen', () => {
    markListSeen(L, minutes(-60));
    show('/lists');
    at(minutes(5));
    show('/lists');
    expect(seenAt()).toBe(minutes(-60).toISOString());
  });

  test("the list's own sheets and Your lists count as on screen", () => {
    markListSeen(L, minutes(-60));
    show('/lists');
    at(minutes(1));
    show(`/list/${L}/item/i1`);
    at(minutes(2));
    show(`/list/${L}/edit`);
    at(minutes(3));
    show('/lists-sheet');
    at(minutes(4));
    show('/lists');
    expect(seenAt()).toBe(minutes(-60).toISOString());
  });

  test('another tab moves it to the moment the list left the screen', () => {
    markListSeen(L, minutes(-60));
    show('/lists');
    at(minutes(10));
    show('/recipes');
    expect(seenAt()).toBe(minutes(10).toISOString());
    // Off screen nothing moves it; coming back and leaving again does.
    at(minutes(20));
    show('/settings');
    expect(seenAt()).toBe(minutes(10).toISOString());
    show('/lists');
    at(minutes(30));
    show('/recipes');
    expect(seenAt()).toBe(minutes(30).toISOString());
  });

  test("a pushed screen or another list's sheet moves it", () => {
    markListSeen(L, minutes(-60));
    show('/lists');
    at(minutes(1));
    show('/import-recipe');
    expect(seenAt()).toBe(minutes(1).toISOString());
    show('/lists');
    at(minutes(2));
    show('/list/other-list/edit');
    expect(seenAt()).toBe(minutes(2).toISOString());
  });

  test('going to the background moves it; inactive (Control Center) does not', () => {
    markListSeen(L, minutes(-60));
    show('/lists');
    at(minutes(1));
    goTo('inactive');
    expect(seenAt()).toBe(minutes(-60).toISOString());
    goTo('active');
    at(minutes(2));
    goTo('background');
    expect(seenAt()).toBe(minutes(2).toISOString());
    at(minutes(3));
    goTo('active');
    expect(seenAt()).toBe(minutes(2).toISOString());
    at(minutes(4));
    goTo('background');
    expect(seenAt()).toBe(minutes(4).toISOString());
  });

  test('a list never shown in the foreground gets no marker', () => {
    setAppState('background');
    show('/lists');
    at(minutes(1));
    show('/recipes');
    act(() => tree?.unmount());
    tree = null;
    expect(seenAt()).toBeNull();
  });

  test('a list mounted off screen is not marked until it is shown', () => {
    show('/recipes');
    expect(seenAt()).toBeNull();
    at(minutes(1));
    show('/lists');
    expect(seenAt()).toBe(minutes(1).toISOString());
  });

  test('switching lists marks the one left, and the new one if it is new here', () => {
    const other = createList('Hardware');
    markListSeen(L, minutes(-60));
    show('/lists');
    at(minutes(5));
    // The List tab keys its screen by list id, so switching unmounts this one.
    act(() => tree?.unmount());
    tree = null;
    show('/lists', other);
    expect(seenAt(L)).toBe(minutes(5).toISOString());
    expect(seenAt(other)).toBe(minutes(5).toISOString());
  });

  test('a list deleted or archived while shown is marked as its screen closes', () => {
    const archived = createList('Party');
    markListSeen(L, minutes(-60));
    markListSeen(archived, minutes(-60));
    show('/lists');
    at(minutes(1));
    deleteList(L);
    act(() => tree?.unmount());
    tree = null;
    expect(seenAt(L)).toBe(minutes(1).toISOString());

    show('/lists', archived);
    at(minutes(2));
    setListArchived(archived, true);
    act(() => tree?.unmount());
    tree = null;
    expect(seenAt(archived)).toBe(minutes(2).toISOString());
  });

  test('a list purged while shown leaves no marker behind', () => {
    markListSeen(L, minutes(-60));
    show('/lists');
    db.transaction((tx) => purgeHousehold(tx, currentHouseholdId()));
    act(() => tree?.unmount());
    tree = null;
    expect(db.select().from(deviceSettings).where(eq(deviceSettings.key, listSeenAtKey(L))).get()).toBeUndefined();
  });

  test('the stored value is the time in ms; anything else reads as no marker', () => {
    markListSeen(L, T0);
    expect(db.select().from(deviceSettings).where(eq(deviceSettings.key, listSeenAtKey(L))).get()?.value).toBe(T0.getTime());
    db.update(deviceSettings).set({ value: 'yesterday' }).where(eq(deviceSettings.key, listSeenAtKey(L))).run();
    expect(getListSeenAt(L)).toBeNull();
  });

  test('markListSeen does nothing for a list this device does not have', () => {
    markListSeen('no-such-list', T0);
    expect(getListSeenAt('no-such-list')).toBeNull();
  });
});

describe('listNewsSince', () => {
  /** An add as pull leaves it: by `by`, with the server's `created_at`. */
  function addAs(text: string, by: string | null, at: Date, listId = L, source: 'manual' | 'siri' = 'manual') {
    const result = addItem(listId, text, by, source)!;
    db.update(listItemContributions).set({ createdAt: at }).where(eq(listItemContributions.id, result.contributionId)).run();
    return result;
  }

  const SINCE = T0;
  const news = (since = SINCE, listId = L) => listNewsSince(listId, since);
  const summary = async (since = SINCE) =>
    (await news(since)).map((m) => ({ userId: m.userId, items: m.items.map((i) => i.displayName) }));

  test("another member's new items count, dated by the server time", async () => {
    addAs('eggs', ALEX, minutes(10));
    addAs('2 limes', ALEX, minutes(20));
    expect(await news()).toEqual([
      {
        userId: ALEX,
        items: [
          { itemId: expect.any(String), displayName: 'limes', addedAt: minutes(20) },
          { itemId: expect.any(String), displayName: 'eggs', addedAt: minutes(10) },
        ],
      },
    ]);
  });

  test('nothing new is an empty list', async () => {
    addAs('eggs', ALEX, minutes(-30));
    expect(await news()).toEqual([]);
  });

  test('a Combine into an existing item counts, once however many contributions it has', async () => {
    const eggs = addAs('eggs', ME, minutes(-60));
    addAs('6 eggs', ALEX, minutes(5));
    addAs('6 eggs', ALEX, minutes(15));
    const result = await news();
    expect(result).toEqual([
      { userId: ALEX, items: [{ itemId: eggs.itemId, displayName: 'eggs', addedAt: minutes(15) }] },
    ]);
  });

  test('2 minutes of clock skew: counted from since - 2 min, not before', async () => {
    addAs('eggs', ALEX, new Date(SINCE.getTime() - SEEN_CLOCK_SKEW_MS + 1_000));
    addAs('limes', ALEX, new Date(SINCE.getTime() - SEEN_CLOCK_SKEW_MS));
    addAs('corn', ALEX, minutes(-3));
    expect(await summary()).toEqual([{ userId: ALEX, items: ['eggs'] }]);
  });

  test('an item removed after it was added does not count', async () => {
    const eggs = addAs('eggs', ALEX, minutes(5));
    addAs('limes', ALEX, minutes(6));
    deleteItem(eggs.itemId);
    expect(await summary()).toEqual([{ userId: ALEX, items: ['limes'] }]);
  });

  test("a removed amount doesn't count, though the item's older amount stays", async () => {
    addAs('eggs', ME, minutes(-60));
    const combine = addAs('6 eggs', ALEX, minutes(5));
    deleteContribution(combine.contributionId);
    expect(await news()).toEqual([]);
  });

  test('an item I checked off does not count; unchecked again, it does', async () => {
    const eggs = addAs('eggs', ALEX, minutes(5));
    setItemChecked(eggs.itemId, true, ME);
    expect(await news()).toEqual([]);
    setItemChecked(eggs.itemId, false, ME);
    expect(await summary()).toEqual([{ userId: ALEX, items: ['eggs'] }]);
  });

  test('my own adds never count: from another device, by Siri on my account, or Combined into theirs', async () => {
    addAs('eggs', ME, minutes(5));
    addAs('milk', ME, minutes(6), L, 'siri');
    const limes = addAs('limes', ALEX, minutes(-60));
    addAs('2 limes', ME, minutes(7));
    expect(await news()).toEqual([]);
    // Alex's own Combine onto it later does.
    addAs('limes', ALEX, minutes(8));
    expect(await news()).toEqual([{ userId: ALEX, items: [{ itemId: limes.itemId, displayName: 'limes', addedAt: minutes(8) }] }]);
  });

  test("Siri on another member's account counts", async () => {
    addAs('milk', SAM, minutes(5), L, 'siri');
    expect(await summary()).toEqual([{ userId: SAM, items: ['milk'] }]);
  });

  test('a null added_by never counts', async () => {
    addAs('eggs', null, minutes(5));
    expect(await news()).toEqual([]);
  });

  test('only this list', async () => {
    const other = createList('Hardware');
    addAs('nails', ALEX, minutes(5), other);
    expect(await news()).toEqual([]);
    expect((await news(SINCE, other)).map((m) => m.userId)).toEqual([ALEX]);
  });

  test('grouped per member, most items first; an item both added to is in both', async () => {
    addAs('eggs', ALEX, minutes(1));
    addAs('limes', SAM, minutes(2));
    addAs('corn tortillas', SAM, minutes(3));
    addAs('eggs', SAM, minutes(4));
    expect(await summary()).toEqual([
      { userId: SAM, items: ['eggs', 'corn tortillas', 'limes'] },
      { userId: ALEX, items: ['eggs'] },
    ]);
  });

  test('signed out, only null added_by is left out', async () => {
    mockAuth.account = null;
    addAs('eggs', ME, minutes(5));
    addAs('limes', null, minutes(6));
    expect(await summary()).toEqual([{ userId: ME, items: ['eggs'] }]);
  });

  test('each then runs the query again, so a live query sees new rows', async () => {
    const query = news();
    expect(await query).toEqual([]);
    addAs('eggs', ALEX, minutes(5));
    expect((await query).map((m) => m.userId)).toEqual([ALEX]);
  });
});

describe('groupListNews', () => {
  test('equal counts: the member who added most recently comes first', () => {
    const rows = [
      { itemId: 'a', displayName: 'eggs', userId: ALEX, addedAt: minutes(1) },
      { itemId: 'b', displayName: 'limes', userId: SAM, addedAt: minutes(2) },
      { itemId: 'c', displayName: 'corn', userId: null, addedAt: minutes(3) },
    ];
    expect(groupListNews(rows).map((m) => m.userId)).toEqual([SAM, ALEX]);
  });

  test('an item keeps its latest add, whatever order the rows come in', () => {
    const rows = [
      { itemId: 'a', displayName: 'eggs', userId: ALEX, addedAt: minutes(1) },
      { itemId: 'a', displayName: 'eggs', userId: ALEX, addedAt: minutes(9) },
      { itemId: 'a', displayName: 'eggs', userId: ALEX, addedAt: minutes(4) },
    ];
    expect(groupListNews(rows)).toEqual([{ userId: ALEX, items: [{ itemId: 'a', displayName: 'eggs', addedAt: minutes(9) }] }]);
  });
});
