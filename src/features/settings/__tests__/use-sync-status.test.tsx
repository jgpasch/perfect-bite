import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { db, households, lists } from '@/db';
import type { AccountState } from '@/features/auth/account';
import { reportSyncActivity, resetSyncActivity } from '@/sync/activity';
import { insertRow } from '@/sync/mutate';
import type { SyncStatus } from '@/sync/status';
import { resetDb } from '@/test/db';
import { resetSupabase, setSupabaseConfigured } from '@/test/fake-supabase';
import { clearOutbox } from '@/test/outbox';

import { setDeviceSetting } from '../device-settings';
import { useSyncStatus } from '../use-sync-status';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));

const mockAccount: { state: AccountState } = { state: { status: 'signedOut' } };
jest.mock('@/features/auth/account', () => ({ useAccountState: () => mockAccount.state }));

// Real writes go to better-sqlite3, which has no change hook: tests announce changes by hand.
type ChangeListener = (event: { tableName: string }) => void;
const mockChangeListeners = new Set<ChangeListener>();
jest.mock('expo-sqlite', () => ({
  addDatabaseChangeListener: (l: ChangeListener) => {
    mockChangeListeners.add(l);
    return { remove: () => mockChangeListeners.delete(l) };
  },
}));
const changed = (tableName: string) => act(() => mockChangeListeners.forEach((l) => l({ tableName })));

const T1 = '2026-10-10T12:00:00.000Z';
const READY: AccountState = { status: 'ready', account: { userId: 'u1' } };

const statusRef: { current?: SyncStatus } = {};
const report = (status: SyncStatus) => {
  statusRef.current = status;
};
function Probe() {
  report(useSyncStatus());
  return null;
}

const mounted: ReactTestRenderer[] = [];

function render(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<Probe />);
  });
  mounted.push(tree);
  return tree;
}

beforeEach(() => {
  resetDb();
  resetSupabase();
  resetSyncActivity();
  mockAccount.state = READY;
  insertRow(db, households, { id: 'h1', name: 'Home' });
  clearOutbox();
});

afterEach(() => {
  act(() => mounted.splice(0).forEach((t) => t.unmount()));
  resetSyncActivity();
});

describe('useSyncStatus', () => {
  test('signed out is Not syncing', () => {
    mockAccount.state = { status: 'signedOut' };
    render();
    expect(statusRef.current!).toMatchObject({ state: 'off', canSyncNow: false });
  });

  test('signed in but Supabase not configured is Not syncing', () => {
    setSupabaseConfigured(false);
    render();
    expect(statusRef.current!.state).toBe('off');
  });

  test('a fresh signed-in device has not synced yet', () => {
    render();
    expect(statusRef.current!).toMatchObject({ state: 'never', pending: 0, canSyncNow: true });
  });

  test('re-reads the outbox when it changes', () => {
    render();
    insertRow(db, lists, { id: 'l1', householdId: 'h1', name: 'Groceries', position: 1 });
    changed('outbox');
    expect(statusRef.current!).toMatchObject({ state: 'syncing', pending: 1 });

    clearOutbox();
    changed('outbox');
    expect(statusRef.current!).toMatchObject({ state: 'never', pending: 0 });
  });

  test('re-reads push and pull state when device settings change', () => {
    render();
    setDeviceSetting('sync.push', { attempts: 1, nextAttemptAt: null, lastError: 'HTTP 503', lastSuccessAt: T1 });
    changed('device_settings');
    expect(statusRef.current!).toMatchObject({ state: 'error', lastError: 'Sending: HTTP 503', lastSuccessAt: T1 });
  });

  test('changes to other tables do not re-read', () => {
    render();
    insertRow(db, lists, { id: 'l1', householdId: 'h1', name: 'Groceries', position: 1 });
    changed('lists');
    expect(statusRef.current!.pending).toBe(0);
  });

  test('follows push/pull activity and connectivity', () => {
    render();
    act(() => reportSyncActivity({ pulling: true }));
    expect(statusRef.current!).toMatchObject({ state: 'syncing', canSyncNow: false });
    act(() => reportSyncActivity({ pulling: false, online: false }));
    expect(statusRef.current!).toMatchObject({ state: 'offline', canSyncNow: false });
  });

  test('follows sign-in', () => {
    mockAccount.state = { status: 'signedOut' };
    const tree = render();
    expect(statusRef.current!.state).toBe('off');
    mockAccount.state = READY;
    act(() => tree.update(<Probe />));
    expect(statusRef.current!.state).toBe('never');
  });

  test('stops listening for database changes on unmount', () => {
    const tree = render();
    expect(mockChangeListeners.size).toBe(1);
    act(() => tree.unmount());
    expect(mockChangeListeners.size).toBe(0);
  });
});
