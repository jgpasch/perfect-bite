import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, households, lists, outbox } from '@/db';
import { setDeviceSetting } from '@/features/settings/device-settings';
import { onRpc, onQuery, resetSupabase, rpcCalls } from '@/test/fake-supabase';
import { resetDb } from '@/test/db';
import { clearOutbox } from '@/test/outbox';

import { getSyncActivity, reportSyncActivity, resetSyncActivity, subscribeSyncActivity, type SyncActivity } from '../activity';
import { insertRow } from '../mutate';
import type { Mutation } from '../mutation';
import { pullNow } from '../pull';
import { pushNow } from '../push';
import { formatLastSync, outboxCounts, readSyncInputs, syncNow, syncStatus, type SyncInputs } from '../status';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));

const mockAuth: { account: { userId: string } | null } = { account: { userId: 'u1' } };
jest.mock('@/features/auth/account', () => ({ getAccount: () => mockAuth.account }));

const IDLE: SyncActivity = { pushing: false, pulling: false, online: true };
const T1 = '2026-10-10T12:00:00.000Z';
const T2 = '2026-10-10T12:05:00.000Z';

/** A signed-in, idle, online device whose last push and pull went through. */
function inputs(patch: Partial<SyncInputs> = {}): SyncInputs {
  return {
    signedIn: true,
    pending: 0,
    rejected: 0,
    push: { lastSuccessAt: T1, lastError: null },
    pull: { lastSuccessAt: T2, lastError: null },
    activity: IDLE,
    ...patch,
  };
}

beforeEach(() => {
  resetDb();
  resetSupabase();
  resetSyncActivity();
  mockAuth.account = { userId: 'u1' };
});

afterEach(() => {
  resetSyncActivity();
});

describe('syncStatus', () => {
  test('an empty outbox after a push and pull that got through is Synced', () => {
    expect(syncStatus(inputs())).toEqual({
      state: 'synced',
      label: 'Synced',
      tone: 'positive',
      pending: 0,
      rejected: 0,
      quarantined: 0,
      lastSuccessAt: T2,
      lastError: null,
      canSyncNow: true,
    });
  });

  test("skipped server changes are counted but don't change the state", () => {
    expect(syncStatus(inputs({ quarantined: 2 }))).toMatchObject({ state: 'synced', tone: 'positive', quarantined: 2 });
    expect(syncStatus(inputs({ quarantined: -1 })).quarantined).toBe(0);
  });

  test('connectivity not reported yet still counts as online', () => {
    const s = syncStatus(inputs({ activity: { ...IDLE, online: null } }));
    expect(s.state).toBe('synced');
    expect(s.canSyncNow).toBe(true);
  });

  test('pending mutations show Syncing… with the count', () => {
    const s = syncStatus(inputs({ pending: 3 }));
    expect(s).toMatchObject({ state: 'syncing', label: 'Syncing…', tone: 'pending', pending: 3, canSyncNow: true });
  });

  test('a running push or pull is Syncing… and Sync now waits for it', () => {
    for (const activity of [
      { ...IDLE, pushing: true },
      { ...IDLE, pulling: true },
    ]) {
      expect(syncStatus(inputs({ activity }))).toMatchObject({ state: 'syncing', label: 'Syncing…', canSyncNow: false });
    }
  });

  test('a push error is shown with the push first, and is a danger badge', () => {
    const s = syncStatus(
      inputs({
        pending: 2,
        push: { lastSuccessAt: T1, lastError: 'HTTP 503' },
        pull: { lastSuccessAt: T2, lastError: 'timeout' },
      }),
    );
    expect(s).toMatchObject({ state: 'error', label: 'Sync error', tone: 'danger', lastError: 'Sending: HTTP 503', canSyncNow: true });
  });

  test('a pull error alone is shown as Receiving', () => {
    const s = syncStatus(inputs({ pull: { lastSuccessAt: T1, lastError: 'Network request failed' } }));
    expect(s.state).toBe('error');
    expect(s.lastError).toBe('Receiving: Network request failed');
  });

  test('a retry in progress after an error shows Syncing… but keeps the error', () => {
    const s = syncStatus(inputs({ push: { lastSuccessAt: null, lastError: 'HTTP 500' }, activity: { ...IDLE, pushing: true } }));
    expect(s.state).toBe('syncing');
    expect(s.lastError).toBe('Sending: HTTP 500');
  });

  test('offline wins over pending, errors and running work, and disables Sync now', () => {
    const s = syncStatus(
      inputs({
        pending: 5,
        push: { lastSuccessAt: T1, lastError: 'HTTP 0' },
        activity: { pushing: true, pulling: false, online: false },
      }),
    );
    expect(s).toMatchObject({ state: 'offline', label: 'Offline', tone: 'pending', pending: 5, canSyncNow: false });
  });

  test('signed out is Not syncing whatever else is true', () => {
    const s = syncStatus(inputs({ signedIn: false, pending: 4, activity: { ...IDLE, online: false } }));
    expect(s).toMatchObject({ state: 'off', label: 'Not syncing', tone: 'pending', canSyncNow: false });
  });

  test('nothing ever got through is Not synced yet', () => {
    const s = syncStatus(inputs({ push: { lastSuccessAt: null, lastError: null }, pull: { lastSuccessAt: null, lastError: null } }));
    expect(s).toMatchObject({ state: 'never', label: 'Not synced yet', lastSuccessAt: null, canSyncNow: true });
  });

  test('one side having succeeded is enough for Synced', () => {
    const s = syncStatus(inputs({ push: { lastSuccessAt: null, lastError: null } }));
    expect(s.state).toBe('synced');
    expect(s.lastSuccessAt).toBe(T2);
  });

  test('the last success is the later of push and pull', () => {
    expect(syncStatus(inputs({ push: { lastSuccessAt: T2, lastError: null }, pull: { lastSuccessAt: T1, lastError: null } })).lastSuccessAt).toBe(T2);
    expect(syncStatus(inputs({ pull: { lastSuccessAt: null, lastError: null } })).lastSuccessAt).toBe(T1);
  });

  test('rejected mutations are counted but do not stop Synced', () => {
    const s = syncStatus(inputs({ rejected: 2 }));
    expect(s.state).toBe('synced');
    expect(s.rejected).toBe(2);
  });

  test('negative counts read as zero', () => {
    const s = syncStatus(inputs({ pending: -1, rejected: -3 }));
    expect(s.pending).toBe(0);
    expect(s.rejected).toBe(0);
    expect(s.state).toBe('synced');
  });
});

describe('formatLastSync', () => {
  const now = new Date('2026-10-10T12:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  test('never synced', () => {
    expect(formatLastSync(null, now)).toBe('Never');
    expect(formatLastSync('not a date', now)).toBe('Never');
  });

  test('under a minute (and a clock that ran back) is Just now', () => {
    expect(formatLastSync(ago(0), now)).toBe('Just now');
    expect(formatLastSync(ago(59_999), now)).toBe('Just now');
    expect(formatLastSync(ago(-30_000), now)).toBe('Just now');
  });

  test('minutes, then hours', () => {
    expect(formatLastSync(ago(60_000), now)).toBe('1 min ago');
    expect(formatLastSync(ago(59 * 60_000 + 59_999), now)).toBe('59 min ago');
    expect(formatLastSync(ago(60 * 60_000), now)).toBe('1 h ago');
    expect(formatLastSync(ago(23 * 3_600_000 + 59 * 60_000), now)).toBe('23 h ago');
  });

  test('a day or more shows the date and time', () => {
    const iso = ago(24 * 3_600_000);
    const expected = new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    expect(formatLastSync(iso, now)).toBe(expected);
    expect(formatLastSync(iso, now)).not.toMatch(/ago/);
  });
});

describe('activity', () => {
  test('listeners hear real changes only, and the snapshot is stable between them', () => {
    const heard: SyncActivity[] = [];
    const stop = subscribeSyncActivity(() => heard.push(getSyncActivity()));
    const before = getSyncActivity();
    reportSyncActivity({ pushing: false });
    expect(getSyncActivity()).toBe(before);
    reportSyncActivity({ pushing: true });
    reportSyncActivity({ online: false });
    reportSyncActivity({ online: false });
    stop();
    reportSyncActivity({ pulling: true });
    expect(heard).toEqual([
      { pushing: true, pulling: false, online: null },
      { pushing: true, pulling: false, online: false },
    ]);
    expect(getSyncActivity()).toEqual({ pushing: true, pulling: true, online: false });
  });

  test('push reports pushing while it runs', async () => {
    insertRow(db, households, { id: 'h1', name: 'Home' });
    clearOutbox();
    insertRow(db, lists, { id: 'l1', householdId: 'h1', name: 'Groceries', position: 1 });
    let seen: SyncActivity | null = null;
    onRpc((call) => {
      seen = getSyncActivity();
      return call.fn === 'apply_mutations'
        ? { data: (call.args as { mutations: Mutation[] }).mutations.map(() => ({ status: 'applied' })), status: 200 }
        : undefined;
    });
    const run = pushNow();
    expect(getSyncActivity().pushing).toBe(true);
    await run;
    expect(seen).toMatchObject({ pushing: true });
    expect(getSyncActivity().pushing).toBe(false);
  });

  test('pull reports pulling while it runs, and stops even when it fails', async () => {
    onQuery(() => ({ data: null, error: { message: 'boom' }, status: 500 }));
    const run = pullNow();
    expect(getSyncActivity().pulling).toBe(true);
    const result = await run;
    expect(result).toMatchObject({ error: expect.stringContaining('boom') });
    expect(getSyncActivity().pulling).toBe(false);
  });
});

describe('reading the inputs', () => {
  test('outbox counts split pending from rejected', () => {
    expect(outboxCounts()).toEqual({ pending: 0, rejected: 0 });
    insertRow(db, households, { id: 'h1', name: 'Home' });
    insertRow(db, lists, { id: 'l1', householdId: 'h1', name: 'A', position: 1 });
    insertRow(db, lists, { id: 'l2', householdId: 'h1', name: 'B', position: 2 });
    const first = db.select().from(outbox).all()[0];
    db.update(outbox)
      .set({ rejectedAt: new Date(T1), error: { code: '42501', message: 'not a member' } })
      .where(eq(outbox.id, first.id))
      .run();
    expect(outboxCounts()).toEqual({ pending: 2, rejected: 1 });
  });

  test('readSyncInputs takes the push and pull states and the activity', () => {
    setDeviceSetting('sync.push', { attempts: 2, nextAttemptAt: T2, lastError: 'HTTP 503', lastSuccessAt: T1 });
    setDeviceSetting('sync.pull', { userId: 'u1', cursors: {}, memberships: null, lastSuccessAt: T2, lastError: null });
    reportSyncActivity({ online: false });
    const read = readSyncInputs(true);
    expect(read).toEqual({
      signedIn: true,
      pending: 0,
      rejected: 0,
      quarantined: 0,
      push: { attempts: 2, nextAttemptAt: T2, lastError: 'HTTP 503', lastSuccessAt: T1 },
      pull: expect.objectContaining({ lastSuccessAt: T2, lastError: null }),
      activity: { pushing: false, pulling: false, online: false },
    });
    expect(syncStatus(read).state).toBe('offline');
  });

  test('readSyncInputs counts the quarantined rows', () => {
    const row = { table: 'list_items', cursor: 'household:h:list_items', updatedAt: T1, error: 'FOREIGN KEY constraint failed', at: T2 };
    setDeviceSetting('sync.quarantine', { failures: { x: 1 }, rows: [{ ...row, key: 'a' }, { ...row, key: 'b' }] });
    expect(readSyncInputs(true).quarantined).toBe(2);
  });

  test('a fresh device has never synced', () => {
    expect(syncStatus(readSyncInputs(true))).toMatchObject({ state: 'never', lastSuccessAt: null, lastError: null });
  });
});

describe('syncNow', () => {
  test('pushes even while backing off, then pulls, and the status becomes Synced', async () => {
    insertRow(db, households, { id: 'h1', name: 'Home' });
    clearOutbox();
    insertRow(db, lists, { id: 'l1', householdId: 'h1', name: 'Groceries', position: 1 });
    setDeviceSetting('sync.push', {
      attempts: 3,
      nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString(),
      lastError: 'HTTP 503',
      lastSuccessAt: null,
    });
    const order: string[] = [];
    onRpc((call) => {
      order.push(`rpc:${call.fn}`);
      return call.fn === 'apply_mutations'
        ? { data: (call.args as { mutations: Mutation[] }).mutations.map(() => ({ status: 'applied' })), status: 200 }
        : undefined;
    });
    onQuery((q) => {
      order.push(`query:${q.table}`);
      return q.table === 'household_members' ? { data: [{ household_id: 'h1' }], status: 200 } : { data: [], status: 200 };
    });

    expect(syncStatus(readSyncInputs(true)).state).toBe('error');
    const result = await syncNow();

    expect(result.push).toEqual({ pushed: 1, rejected: 0, failed: false });
    expect(result.pull).toMatchObject({ households: ['h1'], error: null });
    expect(order[0]).toBe('rpc:apply_mutations');
    expect(order[1]).toBe('query:household_members');
    expect(rpcCalls.filter((c) => c.fn === 'apply_mutations')).toHaveLength(1);
    expect(syncStatus(readSyncInputs(true))).toMatchObject({ state: 'synced', pending: 0, lastError: null });
  });

  test('signed out does nothing and stays Not syncing', async () => {
    mockAuth.account = null;
    const result = await syncNow();
    expect(result).toEqual({ push: { skipped: 'no-session' }, pull: { skipped: 'no-session' } });
    expect(rpcCalls).toHaveLength(0);
    expect(syncStatus(readSyncInputs(false)).state).toBe('off');
  });
});
