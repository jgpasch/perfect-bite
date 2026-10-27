// Sign-out (spec 4.8): the device keeps nothing of the user's, so the next account to sign in
// doesn't see the last one's households; and data synced for another user is wiped before a new
// user becomes ready.
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { db, deviceSettings, households, lists } from '@/db';
import { addItem } from '@/features/lists/items';
import { ensureStarterData, getDefaultListId } from '@/features/lists/lists';
import { resetDb } from '@/test/db';
import { getPushRegistration, setPushRegistration } from '@/features/push/stored-registration';
import { onRpc, resetSupabase, respondToRpc, rpcCallsFor, supabase } from '@/test/fake-supabase';

import { signOutAndWipe, wipeIfOtherUser } from '../sign-out';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('expo-file-system', () => require('@/test/fake-file-system'));
jest.mock('@/lib/google-sign-in', () => ({ getGoogleIdToken: jest.fn(), signOutOfGoogle: async () => {} }));

const mockOrder: string[] = [];
/** What the sync `whenIdle`s wait on; resolved by default. */
const mockIdle: { push: Promise<void>; pull: Promise<void> } = { push: Promise.resolve(), pull: Promise.resolve() };
jest.mock('@/sync/push', () => ({
  pushNow: async () => {
    mockOrder.push('push');
    return { pushed: 0, rejected: 0, failed: false };
  },
  whenIdle: () => mockIdle.push.then(() => void mockOrder.push('push idle')),
}));
jest.mock('@/sync/pull', () => ({
  ...jest.requireActual<object>('@/sync/pull'),
  whenIdle: () => mockIdle.pull.then(() => void mockOrder.push('pull idle')),
}));
jest.mock('@/sync/realtime', () => ({ stopRealtime: () => void mockOrder.push('stopRealtime') }));

/** A promise with its `resolve`, for holding a push or pull in flight. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const USER = 'u1';
const signOut = supabase.auth.signOut as jest.Mock<(...args: unknown[]) => Promise<unknown>>;

function syncedFor(userId: string) {
  db.insert(deviceSettings)
    .values({ key: 'sync.pull', value: { userId, cursors: {}, memberships: [] } })
    .onConflictDoUpdate({ target: deviceSettings.key, set: { value: { userId, cursors: {}, memberships: [] } } })
    .run();
}

beforeEach(() => {
  resetDb();
  resetSupabase();
  mockOrder.length = 0;
  mockIdle.push = Promise.resolve();
  mockIdle.pull = Promise.resolve();
  signOut.mockReset();
  signOut.mockImplementation(async () => {
    mockOrder.push('signOut');
    return { error: null };
  });
  ensureStarterData(USER);
  addItem(getDefaultListId(USER)!, 'milk', USER);
  syncedFor(USER);
});

describe('signOutAndWipe', () => {
  it('pushes, signs out, then removes the households and lists from the device', async () => {
    await signOutAndWipe({ pushTimeoutMs: 10 });
    expect(mockOrder).toEqual(['push', 'signOut', 'stopRealtime', 'push idle', 'pull idle']);
    expect(db.select().from(households).all()).toEqual([]);
    expect(db.select().from(lists).all()).toEqual([]);
  });

  it('waits for an in-flight push before wiping, even past the push timeout', async () => {
    const push = deferred();
    mockIdle.push = push.promise;
    const done = signOutAndWipe({ pushTimeoutMs: 10 });
    await new Promise((r) => setTimeout(r, 30));
    expect(mockOrder).toEqual(['push', 'signOut', 'stopRealtime', 'pull idle']);
    expect(db.select().from(households).all()).toHaveLength(1);

    push.resolve();
    await done;
    expect(mockOrder).toEqual(['push', 'signOut', 'stopRealtime', 'pull idle', 'push idle']);
    expect(db.select().from(households).all()).toEqual([]);
  });

  it('waits for an in-flight pull before wiping', async () => {
    const pull = deferred();
    mockIdle.pull = pull.promise;
    const done = signOutAndWipe({ pushTimeoutMs: 10 });
    await new Promise((r) => setTimeout(r, 30));
    expect(db.select().from(lists).all()).toHaveLength(1);

    pull.resolve();
    await done;
    expect(db.select().from(lists).all()).toEqual([]);
  });

  it('keeps everything when the sign-out fails, and leaves sync running', async () => {
    signOut.mockImplementation(async () => ({ error: new Error('network') }));
    await expect(signOutAndWipe({ pushTimeoutMs: 10 })).rejects.toThrow('network');
    expect(db.select().from(households).all()).toHaveLength(1);
    expect(mockOrder).toEqual(['push']);
  });

  it("unregisters the device's push token before signing out, and forgets it (spec 4.13)", async () => {
    setPushRegistration({ token: 'ExponentPushToken[abc]', userId: USER, at: '2026-10-17T12:00:00.000Z' });
    onRpc((call) => {
      mockOrder.push(call.fn);
      return undefined;
    });
    await signOutAndWipe({ pushTimeoutMs: 10 });
    expect(mockOrder).toEqual(['push', 'unregister_push_token', 'signOut', 'stopRealtime', 'push idle', 'pull idle']);
    expect(rpcCallsFor('unregister_push_token')).toEqual([{ fn: 'unregister_push_token', args: { p_token: 'ExponentPushToken[abc]' } }]);
    expect(getPushRegistration()).toBeNull();
  });

  it('still signs out when unregistering the push token fails', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    setPushRegistration({ token: 'ExponentPushToken[abc]', userId: USER, at: '2026-10-17T12:00:00.000Z' });
    respondToRpc('unregister_push_token', { error: { message: 'network' } });
    await signOutAndWipe({ pushTimeoutMs: 10 });
    expect(mockOrder).toEqual(['push', 'signOut', 'stopRealtime', 'push idle', 'pull idle']);
    expect(getPushRegistration()).toBeNull();
    expect(db.select().from(households).all()).toEqual([]);
  });

  it('calls no push RPC when this device never registered', async () => {
    await signOutAndWipe({ pushTimeoutMs: 10 });
    expect(rpcCallsFor('unregister_push_token')).toEqual([]);
  });
});

describe('wipeIfOtherUser', () => {
  it("wipes another user's data", () => {
    wipeIfOtherUser('u2');
    expect(db.select().from(households).all()).toEqual([]);
  });

  it("keeps the same user's data", () => {
    wipeIfOtherUser(USER);
    expect(db.select().from(households).all()).toHaveLength(1);
  });

  it('keeps data never synced for anyone', () => {
    db.delete(deviceSettings).run();
    wipeIfOtherUser('u2');
    expect(db.select().from(households).all()).toHaveLength(1);
  });
});
