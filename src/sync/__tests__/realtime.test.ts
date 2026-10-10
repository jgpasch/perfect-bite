import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import type { NetworkState } from 'expo-network';
import { AppState, type AppStateStatus } from 'react-native';

import { categories, db, households, listItems, lists, userCategoryOverrides } from '@/db';
import {
  emitChange,
  onQuery,
  openChannels,
  queries,
  realtimeChannels,
  resetSupabase,
  setChannelStatus,
  setSupabaseConfigured,
  supabase,
  type FakeChannel,
  type RecordedQuery,
} from '@/test/fake-supabase';
import { resetDb } from '@/test/db';

import { pullNow, type ServerRow } from '../pull';
import { HOUSEHOLD_TABLES, REALTIME_BATCH_MS, startRealtime } from '../realtime';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));

// jest.mock is hoisted above the imports; the factories read these lazily.
const mockAuth: { account: { userId: string } | null } = { account: { userId: 'u1' } };
jest.mock('@/features/auth/account', () => ({ getAccount: () => mockAuth.account }));

const mockNetwork: { listener: ((s: NetworkState) => void) | null } = { listener: null };
jest.mock('expo-network', () => ({
  addNetworkStateListener: (listener: (s: NetworkState) => void) => {
    mockNetwork.listener = listener;
    return { remove: () => (mockNetwork.listener = null) };
  },
}));

const mockApp: { listener: ((s: AppStateStatus) => void) | null } = { listener: null };
jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
  mockApp.listener = listener as (s: AppStateStatus) => void;
  return { remove: () => (mockApp.listener = null) };
});
const setCurrentState = (state: AppStateStatus) =>
  Object.defineProperty(AppState, 'currentState', { value: state, configurable: true, writable: true });

const H1 = 'household-1';
const H2 = 'household-2';
const H3 = 'household-3';
const L = 'list-1';
const OLD = '1000000000000-0000-remote';
const NEW = '9000000000000-0000-remote';
const ts = (s: number) => `2026-10-10T12:00:${String(s).padStart(2, '0')}.000000+00:00`;

// --- A tiny server, as in pull.test.ts. -----------------------------------------------------

let server: Record<string, ServerRow[]>;
let memberships: string[];

function serve(query: RecordedQuery) {
  if (query.table === 'household_members') {
    return { data: memberships.map((household_id) => ({ household_id })), status: 200 };
  }
  let rows = [...(server[query.table] ?? [])];
  for (const [op, column, value] of query.ops) {
    if (op === 'eq') rows = rows.filter((r) => String(r[column as string]) === value);
    if (op === 'gt') rows = rows.filter((r) => Date.parse(r[column as string] as string) > Date.parse(value as string));
  }
  return { data: rows, status: 200 };
}

const household = (id: string): ServerRow => ({ id, name: 'Test home', created_by: 'u2', created_at: ts(0), updated_at: ts(1) });
const list = (): ServerRow => ({
  id: L,
  household_id: H1,
  name: 'Groceries',
  emoji: null,
  position: 1,
  archived_at: null,
  deleted_at: null,
  field_clock: { name: OLD },
  created_at: ts(0),
  updated_at: ts(1),
});
const item = (extra: Partial<ServerRow> = {}): ServerRow => ({
  id: 'i1',
  list_id: L,
  household_id: H1,
  ingredient_name: 'milk',
  display_name: 'milk',
  note: null,
  checked_at: null,
  checked_by: null,
  added_by: 'u2',
  deleted_at: null,
  merged_into: null,
  field_clock: { display_name: OLD, checked_at: OLD },
  created_at: ts(0),
  updated_at: ts(2),
  ...extra,
});

/** Lets the batch timer fire and the pull it starts finish. */
async function settle() {
  await jest.advanceTimersByTimeAsync(REALTIME_BATCH_MS);
  await new Promise((resolve) => setImmediate(resolve));
}

const channelNamed = (prefix: string): FakeChannel | undefined =>
  openChannels().find((c) => c.name.startsWith(`sync:${prefix}:`));
const tablesQueried = () => queries.map((q) => q.table);

let stop: (() => void) | null = null;
function start(userId = 'u1') {
  stop = startRealtime(userId);
  return stop;
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  resetDb();
  resetSupabase();
  setCurrentState('active');
  mockAuth.account = { userId: 'u1' };
  server = { households: [household(H1)], lists: [list()], list_items: [item()] };
  memberships = [H1];
  onQuery(serve);
});

afterEach(() => {
  stop?.();
  stop = null;
  jest.useRealTimers();
});

describe('channels', () => {
  test("before memberships are known, only the user's and the catalog channels open", () => {
    start('u-new');

    expect(openChannels().map((c) => c.name)).toEqual(['sync:user:1', 'sync:catalog:2']);
    expect(channelNamed('user')!.bindings.map(({ table, filter, event, schema }) => ({ table, filter, event, schema }))).toEqual([
      { table: 'household_members', filter: 'user_id=eq.u-new', event: '*', schema: 'public' },
      { table: 'categories', filter: 'owner_user_id=eq.u-new', event: '*', schema: 'public' },
      { table: 'user_category_order', filter: 'user_id=eq.u-new', event: '*', schema: 'public' },
      { table: 'user_category_overrides', filter: 'user_id=eq.u-new', event: '*', schema: 'public' },
      { table: 'user_settings', filter: 'user_id=eq.u-new', event: '*', schema: 'public' },
    ]);
    expect(channelNamed('catalog')!.bindings.map((b) => [b.table, b.filter])).toEqual([['ingredients', undefined]]);
  });

  test('a full pull opens one channel per household, every household table filtered to it', async () => {
    start();
    memberships = [H1, H2];
    await pullNow();

    const h2 = channelNamed(`household:${H2}`)!;
    expect(h2.bindings.map((b) => [b.table, b.filter])).toEqual([
      ['households', `id=eq.${H2}`],
      ...HOUSEHOLD_TABLES.slice(1).map((table) => [table, `household_id=eq.${H2}`]),
    ]);
    expect(channelNamed(`household:${H1}`)).toBeDefined();
    expect(openChannels()).toHaveLength(4);
  });

  test('starting after a full pull uses the households it read', async () => {
    await pullNow();
    start();
    expect(channelNamed(`household:${H1}`)).toBeDefined();
  });

  test('not configured: no channels', () => {
    setSupabaseConfigured(false);
    start();
    expect(realtimeChannels).toEqual([]);
  });

  test('cleanup closes every channel and cancels a scheduled pull', async () => {
    await pullNow();
    start();
    emitChange({ table: 'list_items', eventType: 'UPDATE', new: item() });
    queries.length = 0;

    stop!();
    stop = null;
    await settle();

    expect(openChannels()).toEqual([]);
    expect(supabase.removeChannel).toHaveBeenCalledTimes(3);
    expect(queries).toEqual([]);
  });
});

describe('events pull what they touched', () => {
  beforeEach(async () => {
    memberships = [H1, H2];
    await pullNow();
    start();
    queries.length = 0;
  });

  test('a remote check comes down through the pull path within the batch window', async () => {
    expect(db.select().from(listItems).where(eq(listItems.id, 'i1')).get()!.checkedAt).toBeNull();
    const checked = item({ checked_at: ts(10), checked_by: 'u2', field_clock: { display_name: OLD, checked_at: NEW }, updated_at: ts(10) });
    server.list_items = [checked];

    emitChange({ table: 'list_items', eventType: 'UPDATE', new: checked });
    await jest.advanceTimersByTimeAsync(REALTIME_BATCH_MS - 1);
    expect(queries).toEqual([]);
    await settle();

    // Only that household's tables, from their cursors: no membership lookup, no other household.
    expect(tablesQueried()).toEqual([...HOUSEHOLD_TABLES]);
    expect(queries.find((q) => q.table === 'list_items')!.ops).toContainEqual(['eq', 'household_id', H1]);
    expect(db.select().from(listItems).where(eq(listItems.id, 'i1')).get()).toMatchObject({
      checkedAt: new Date(ts(10)),
      checkedBy: 'u2',
    });
  });

  test('events within the window share one pull; events for two households pull both', async () => {
    emitChange({ table: 'list_items', eventType: 'INSERT', new: item({ id: 'i2' }) });
    emitChange({ table: 'list_item_contributions', eventType: 'INSERT', new: { id: 'c1', household_id: H1 } });
    emitChange({ table: 'lists', eventType: 'UPDATE', new: { id: 'l2', household_id: H2 } });
    await settle();

    expect(tablesQueried()).toEqual([...HOUSEHOLD_TABLES, ...HOUSEHOLD_TABLES]);
    expect(queries.filter((q) => q.table === 'lists').map((q) => q.ops[1])).toEqual([
      ['eq', 'household_id', H1],
      ['eq', 'household_id', H2],
    ]);

    queries.length = 0;
    emitChange({ table: 'list_items', eventType: 'UPDATE', new: item() });
    await settle();
    expect(tablesQueried()).toEqual([...HOUSEHOLD_TABLES]);
  });

  test("a change to another household's row doesn't reach this user's channels", async () => {
    emitChange({ table: 'list_items', eventType: 'UPDATE', new: item({ household_id: H3 }) });
    await settle();
    expect(queries).toEqual([]);
  });

  test("the user's own tables pull just those", async () => {
    emitChange({ table: 'user_settings', eventType: 'UPDATE', new: { user_id: 'u1' } });
    await settle();
    expect(tablesQueried()).toEqual(['categories', 'user_category_order', 'user_category_overrides', 'user_settings']);
  });

  test('a catalog change pulls just the catalog', async () => {
    emitChange({ table: 'ingredients', eventType: 'UPDATE', new: { normalized_name: 'milk' } });
    await settle();
    expect(tablesQueried()).toEqual(['ingredients']);
  });

  test("a deleted override is applied from the event's key, without a pull", async () => {
    db.insert(categories).values({ id: 'cat-snacks', name: 'Snacks', ownerUserId: 'u1' }).run();
    db.insert(userCategoryOverrides).values({ userId: 'u1', ingredientName: 'chips', categoryId: 'cat-snacks' }).run();

    // Deletes can't be filtered: another user's arrives too and is ignored.
    emitChange({ table: 'user_category_overrides', eventType: 'DELETE', old: { user_id: 'u2', ingredient_name: 'chips' } });
    expect(db.select().from(userCategoryOverrides).all()).toHaveLength(1);

    emitChange({ table: 'user_category_overrides', eventType: 'DELETE', old: { user_id: 'u1', ingredient_name: 'chips' } });
    expect(db.select().from(userCategoryOverrides).all()).toEqual([]);
    await settle();
    expect(queries).toEqual([]);
  });

  test('a channel that (re)subscribes catches up on its scope', async () => {
    setChannelStatus('SUBSCRIBED', channelNamed(`household:${H2}`));
    await settle();
    expect(tablesQueried()).toEqual([...HOUSEHOLD_TABLES]);
    expect(queries[1].ops[1]).toEqual(['eq', 'household_id', H2]);

    queries.length = 0;
    setChannelStatus('SUBSCRIBED');
    await settle();
    expect(tablesQueried()).toEqual([
      ...HOUSEHOLD_TABLES,
      ...HOUSEHOLD_TABLES,
      'categories',
      'user_category_order',
      'user_category_overrides',
      'user_settings',
      'ingredients',
    ]);
  });

  test('a channel error just waits for the rejoin', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    setChannelStatus('CHANNEL_ERROR', channelNamed('catalog'));
    await settle();
    expect(queries).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('membership changes', () => {
  beforeEach(async () => {
    memberships = [H1, H2];
    await pullNow();
    start();
    queries.length = 0;
  });

  test('joining a household does a full pull and opens its channel', async () => {
    memberships = [H1, H2, H3];
    server.households = [household(H1), household(H3)];

    emitChange({ table: 'household_members', eventType: 'INSERT', new: { household_id: H3, user_id: 'u1' } });
    await settle();

    expect(tablesQueried()[0]).toBe('household_members');
    expect(channelNamed(`household:${H3}`)).toBeDefined();
    expect(openChannels()).toHaveLength(5);
  });

  test("losing one closes its channel and leaves the others' open", async () => {
    const h1 = channelNamed(`household:${H1}`)!;
    const h2 = channelNamed(`household:${H2}`)!;
    memberships = [H1];

    emitChange({ table: 'household_members', eventType: 'DELETE', old: { household_id: H2, user_id: 'u1' } });
    await settle();

    expect(h2.removed).toBe(true);
    expect(h1.removed).toBe(false);
    expect(openChannels().map((c) => c.name.split(':').slice(1, -1).join(':'))).toEqual([
      'user',
      'catalog',
      `household:${H1}`,
    ]);
  });

  test("losing one removes its data from this device and keeps the others'", async () => {
    server.households = [household(H1), household(H2)];
    server.lists = [list(), { ...list(), id: 'cabin-list', household_id: H2 }];
    await pullNow();
    expect(db.select({ id: households.id }).from(households).all()).toHaveLength(2);
    server.households = [household(H1)];
    server.lists = [list()];
    memberships = [H1];

    emitChange({ table: 'household_members', eventType: 'DELETE', old: { household_id: H2, user_id: 'u1' } });
    await settle();

    expect(db.select({ id: households.id }).from(households).all()).toEqual([{ id: H1 }]);
    expect(db.select({ id: lists.id }).from(lists).all()).toEqual([{ id: L }]);
    expect(db.select({ id: listItems.id }).from(listItems).all()).toHaveLength(1);
  });

  test("another member's removal is ignored", async () => {
    emitChange({ table: 'household_members', eventType: 'DELETE', old: { household_id: H1, user_id: 'u2' } });
    await settle();
    expect(queries).toEqual([]);
  });
});

describe('foreground and network', () => {
  beforeEach(async () => {
    await pullNow();
    start();
  });

  test('going to the background closes every channel; coming back opens new ones', () => {
    const first = openChannels();
    expect(first).toHaveLength(3);

    mockApp.listener!('background');
    expect(openChannels()).toEqual([]);
    expect(first.every((c) => c.removed)).toBe(true);

    mockApp.listener!('active');
    expect(openChannels().map((c) => c.name)).toEqual(['sync:user:4', 'sync:catalog:5', `sync:household:${H1}:6`]);
  });

  test("starting in the background opens nothing until it's active", () => {
    stop!();
    setCurrentState('background');
    realtimeChannels.length = 0;
    start();
    expect(realtimeChannels).toEqual([]);

    mockApp.listener!('active');
    expect(openChannels()).toHaveLength(3);
  });

  test('offline closes the channels and a reconnect opens new ones; staying online keeps them', () => {
    const first = openChannels();
    mockNetwork.listener!({ isConnected: true, isInternetReachable: true });
    expect(openChannels()).toEqual(first);

    mockNetwork.listener!({ isConnected: false, isInternetReachable: false });
    expect(openChannels()).toEqual([]);

    mockNetwork.listener!({ isConnected: true, isInternetReachable: true });
    const second = openChannels();
    expect(second).toHaveLength(3);
    expect(second.some((c) => first.includes(c))).toBe(false);
  });

  test('events on a closed channel do nothing', async () => {
    const before = openChannels();
    mockApp.listener!('background');
    queries.length = 0;
    for (const ch of before) for (const b of ch.bindings) b.callback({ eventType: 'UPDATE', new: {}, old: {} });
    // Closed channels aren't delivered to.
    emitChange({ table: 'list_items', eventType: 'UPDATE', new: item() });
    await settle();
    expect(queries).toEqual([]);
  });
});
