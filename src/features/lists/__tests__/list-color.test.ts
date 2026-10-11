// List colours (spec 4.1): stored on the list, shared by the household through sync (spec 7).
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { AppState } from 'react-native';

import { db, lists } from '@/db';
import { listHue } from '@/domain/aisle-color';
import { emitChange, onQuery, onRpc, resetSupabase, rpcCallsFor, type RecordedQuery } from '@/test/fake-supabase';
import { resetDb } from '@/test/db';
import { clearOutbox, outboxPatches } from '@/test/outbox';
import { pullNow, type ServerRow } from '@/sync/pull';
import { pushNow } from '@/sync/push';
import { REALTIME_BATCH_MS, startRealtime } from '@/sync/realtime';
import type { Mutation } from '@/sync/mutation';

import { renameList, setListColor } from '../lists';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));

// jest.mock is hoisted above the imports; the factories read these lazily.
const mockAuth: { account: { userId: string } | null } = { account: { userId: 'alex' } };
jest.mock('@/features/auth/account', () => ({ getAccount: () => mockAuth.account }));
jest.mock('expo-network', () => ({ addNetworkStateListener: () => ({ remove: () => {} }) }));

Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true, writable: true });
jest.spyOn(AppState, 'addEventListener').mockImplementation(() => ({ remove: () => {} }));

const H = 'household-1';
const L = 'list-1';
const OLD = '1000000000000-0000-remote';
const NEW = '9000000000000-0000-remote';

// --- A tiny server: the household's rows, read like PostgREST and written like apply_mutations. --

let server: Record<string, ServerRow[]>;
let tick: number;
const nextUpdatedAt = () => new Date(Date.UTC(2026, 9, 10, 12, 0, ++tick)).toISOString();

function serve(query: RecordedQuery) {
  if (query.table === 'household_members') return { data: [{ household_id: H }], status: 200 };
  let rows = [...(server[query.table] ?? [])];
  for (const [op, column, value] of query.ops) {
    if (op === 'eq') rows = rows.filter((r) => String(r[column as string]) === value);
    if (op === 'gt') rows = rows.filter((r) => Date.parse(r[column as string] as string) > Date.parse(value as string));
  }
  return { data: rows, status: 200 };
}

/** Field-level LWW by HLC, as `apply_mutations` does it (7.3). Only existing rows, which is all these tests need. */
function apply(mutation: Mutation) {
  const row = server[mutation.table]?.find((r) => r.id === mutation.id);
  if (!row) return { status: 'rejected', code: '23503', message: 'no such row' };
  const clock = row.field_clock as Record<string, string>;
  let changed = false;
  for (const [field, value] of Object.entries(mutation.fields ?? {})) {
    if (clock[field] && clock[field] >= mutation.hlc) continue;
    row[field] = value;
    clock[field] = mutation.hlc;
    changed = true;
  }
  if (changed) row.updated_at = nextUpdatedAt();
  return { status: changed ? 'applied' : 'unchanged' };
}

const remoteList = (extra: Partial<ServerRow> = {}): ServerRow => ({
  id: L,
  household_id: H,
  name: 'Groceries',
  emoji: null,
  color: null,
  position: 1,
  archived_at: null,
  deleted_at: null,
  field_clock: { household_id: OLD, name: OLD, position: OLD },
  created_at: '2026-10-10T12:00:00.000000+00:00',
  updated_at: nextUpdatedAt(),
  ...extra,
});

const serverList = () => server.lists.find((r) => r.id === L)!;
const localList = () => db.select().from(lists).where(eq(lists.id, L)).get();

/** Starts this test as a fresh device for `userId`, with the household pulled once. */
async function signInOnNewDevice(userId: string) {
  resetDb();
  mockAuth.account = { userId };
  await pullNow();
  clearOutbox();
}

beforeEach(async () => {
  resetSupabase();
  tick = 0;
  server = { households: [{ id: H, name: 'Home', created_by: 'alex', created_at: nextUpdatedAt(), updated_at: nextUpdatedAt() }], lists: [] };
  server.lists.push(remoteList());
  onQuery(serve);
  onRpc((call) =>
    call.fn === 'apply_mutations'
      ? { data: (call.args as { mutations: Mutation[] }).mutations.map(apply), status: 200 }
      : undefined,
  );
  await signInOnNewDevice('alex');
});

describe('setListColor', () => {
  test('a list starts as Default', () => {
    expect(localList()!.color).toBeNull();
    expect(listHue(localList()!.color)).toBeNull();
  });

  test('sets a hue, changes it, and clears it back to Default', () => {
    setListColor(L, 'rose');
    expect(localList()!.color).toBe('rose');
    expect(listHue(localList()!.color)).toBe('rose');
    setListColor(L, 'grey');
    expect(localList()!.color).toBe('grey');
    setListColor(L, null);
    expect(localList()!.color).toBeNull();
  });

  test('queues one field-level patch per change, like a rename', () => {
    setListColor(L, 'blue');
    setListColor(L, null);
    renameList(L, 'Weekly');
    expect(outboxPatches()).toEqual([
      { table: 'lists', id: L, fields: { color: 'blue' } },
      { table: 'lists', id: L, fields: { color: null } },
      { table: 'lists', id: L, fields: { name: 'Weekly' } },
    ]);
    expect(localList()!.fieldClock).toMatchObject({ color: expect.any(String), name: expect.any(String) });
  });

  test('leaves the other fields alone', () => {
    setListColor(L, 'amber');
    expect(localList()).toMatchObject({ name: 'Groceries', position: 1, archivedAt: null, deletedAt: null });
  });

  test('an unknown id writes nothing', () => {
    setListColor('nope', 'green');
    expect(outboxPatches()).toEqual([]);
  });
});

describe('sync', () => {
  test('push sends the colour to the server', async () => {
    setListColor(L, 'green');
    await pushNow({ force: true });
    expect(rpcCallsFor('apply_mutations')).toHaveLength(1);
    expect(serverList().color).toBe('green');
    expect(outboxPatches()).toEqual([]);
  });

  test("a colour set by one member reaches another member's device", async () => {
    setListColor(L, 'blue');
    await pushNow({ force: true });

    await signInOnNewDevice('jo');
    expect(localList()!.color).toBe('blue');

    // Jo clears it, and Alex sees Default again.
    setListColor(L, null);
    await pushNow({ force: true });
    expect(serverList().color).toBeNull();
    await signInOnNewDevice('alex');
    expect(localList()!.color).toBeNull();
  });

  test("a pull brings down another member's later change", async () => {
    setListColor(L, 'rose');
    await pushNow({ force: true });
    Object.assign(serverList(), {
      color: 'amber',
      field_clock: { ...(serverList().field_clock as object), color: NEW },
      updated_at: nextUpdatedAt(),
    });
    await pullNow();
    expect(localList()!.color).toBe('amber');
  });

  test("an unpushed local colour isn't overwritten by an older remote one", async () => {
    setListColor(L, 'rose');
    Object.assign(serverList(), {
      color: 'green',
      field_clock: { ...(serverList().field_clock as object), color: OLD },
      updated_at: nextUpdatedAt(),
    });
    await pullNow();
    expect(localList()!.color).toBe('rose');
  });

  test('a hue from a newer app version is kept as is but reads as Default', async () => {
    Object.assign(serverList(), {
      color: 'purple',
      field_clock: { ...(serverList().field_clock as object), color: NEW },
      updated_at: nextUpdatedAt(),
    });
    await pullNow();
    expect(localList()!.color).toBe('purple');
    expect(listHue(localList()!.color)).toBeNull();
  });

  test('rows from a server without the column leave the local colour alone', async () => {
    setListColor(L, 'blue');
    await pushNow({ force: true });
    const { color: _color, ...withoutColor } = serverList();
    server.lists = [{ ...withoutColor, name: 'Renamed', updated_at: nextUpdatedAt() }];
    await pullNow();
    expect(localList()).toMatchObject({ name: 'Renamed', color: 'blue' });
  });

  describe('realtime', () => {
    let stop: (() => void) | null = null;
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    });
    afterEach(() => {
      stop?.();
      stop = null;
      jest.useRealTimers();
    });

    test("another member's colour change arrives through a Realtime event", async () => {
      stop = startRealtime('alex');
      const changed = Object.assign(serverList(), {
        color: 'grey',
        field_clock: { ...(serverList().field_clock as object), color: NEW },
        updated_at: nextUpdatedAt(),
      });
      emitChange({ table: 'lists', eventType: 'UPDATE', new: changed });
      await jest.advanceTimersByTimeAsync(REALTIME_BATCH_MS);
      await new Promise((resolve) => setImmediate(resolve));
      expect(localList()!.color).toBe('grey');
    });
  });
});
