// Sign-out (spec 4.8): the device keeps nothing of the user's, so the next account to sign in
// doesn't see the last one's households; and data synced for another user is wiped before a new
// user becomes ready.
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { db, deviceSettings, households, lists } from '@/db';
import { addItem } from '@/features/lists/items';
import { ensureStarterData, getDefaultListId } from '@/features/lists/lists';
import { resetDb } from '@/test/db';
import { resetSupabase, supabase } from '@/test/fake-supabase';

import { signOutAndWipe, wipeIfOtherUser } from '../sign-out';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('expo-file-system', () => require('@/test/fake-file-system'));
jest.mock('@/lib/google-sign-in', () => ({ getGoogleIdToken: jest.fn(), signOutOfGoogle: async () => {} }));

const mockOrder: string[] = [];
jest.mock('@/sync/push', () => ({
  pushNow: async () => {
    mockOrder.push('push');
    return { pushed: 0, rejected: 0, failed: false };
  },
}));

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
    expect(mockOrder).toEqual(['push', 'signOut']);
    expect(db.select().from(households).all()).toEqual([]);
    expect(db.select().from(lists).all()).toEqual([]);
  });

  it('keeps everything when the sign-out fails', async () => {
    signOut.mockImplementation(async () => ({ error: new Error('network') }));
    await expect(signOutAndWipe({ pushTimeoutMs: 10 })).rejects.toThrow('network');
    expect(db.select().from(households).all()).toHaveLength(1);
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
