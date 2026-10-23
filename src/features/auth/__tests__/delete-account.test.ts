// Delete account (spec 4.8): the confirm's wording, and the deletion itself: offline it never asks
// the server; it pushes first, then `delete_account`, then wipes and signs out, in that order; a
// server error changes nothing on the device.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { db, households, listItems } from '@/db';
import { addItem } from '@/features/lists/items';
import { ensureStarterData, getDefaultListId } from '@/features/lists/lists';
import { resetDb } from '@/test/db';
import { onRpc, resetSupabase, respondToRpc, rpcCalls, rpcCallsFor, supabase } from '@/test/fake-supabase';

import {
  ACCOUNT_DELETED_TOAST,
  DELETE_ACCOUNT_FAILED,
  DELETE_ACCOUNT_OFFLINE,
  DELETE_ACCOUNT_SECOND_CONFIRM,
  DeleteAccountError,
  deleteAccount,
  deleteAccountConfirmation,
  householdsForDeletion,
  takeAccountDeletedNotice,
} from '../delete-account';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('expo-file-system', () => require('@/test/fake-file-system'));

const mockOrder: string[] = [];
const mockNetwork: { state: unknown } = { state: { isConnected: true, isInternetReachable: true } };
jest.mock('expo-network', () => ({
  getNetworkStateAsync: async () => {
    if (mockNetwork.state instanceof Error) throw mockNetwork.state;
    return mockNetwork.state;
  },
  addNetworkStateListener: () => ({ remove: () => {} }),
}));

const mockPush: { impl: () => Promise<unknown> } = { impl: async () => ({ pushed: 0, rejected: 0, failed: false }) };
jest.mock('@/sync/push', () => ({
  pushNow: () => {
    mockOrder.push('push');
    return mockPush.impl();
  },
}));
const mockWipe: { error: Error | null } = { error: null };
jest.mock('@/features/auth/local-wipe', () => {
  const actual = jest.requireActual<typeof import('@/features/auth/local-wipe')>('@/features/auth/local-wipe');
  return {
    wipeLocalData: () => {
      mockOrder.push('wipe');
      if (mockWipe.error) throw mockWipe.error;
      actual.wipeLocalData();
    },
  };
});
const mockReportError = jest.fn();
jest.mock('@/lib/sentry', () => ({ reportError: (...args: unknown[]) => mockReportError(...args) }));
const mockGoogleSignOut = jest.fn(async () => {
  mockOrder.push('google');
});
jest.mock('@/lib/google-sign-in', () => ({ getGoogleIdToken: jest.fn(), signOutOfGoogle: () => mockGoogleSignOut() }));

const USER = 'u1';
const signOut = supabase.auth.signOut as jest.Mock<(...args: unknown[]) => Promise<unknown>>;

beforeEach(() => {
  resetDb();
  resetSupabase();
  mockOrder.length = 0;
  mockReportError.mockClear();
  mockNetwork.state = { isConnected: true, isInternetReachable: true };
  mockPush.impl = async () => ({ pushed: 0, rejected: 0, failed: false });
  mockGoogleSignOut.mockClear();
  signOut.mockReset();
  signOut.mockImplementation(async () => {
    mockOrder.push('signOut');
    return { error: null };
  });
  takeAccountDeletedNotice();
  ensureStarterData(USER);
  addItem(getDefaultListId(USER)!, 'milk', USER);
});

afterEach(() => {
  jest.useRealTimers();
});

const BASE = "This can't be undone. Your account, your aisle order and your settings will be deleted.";

describe('deleteAccountConfirmation', () => {
  it('names a personal household the user is alone in, with its counts', () => {
    expect(deleteAccountConfirmation([{ name: 'Personal', listCount: 1, recipeCount: 0, memberCount: 1 }])).toEqual({
      title: 'Delete your account?',
      message: `${BASE}\n\nPersonal and its 1 list and 0 recipes will be deleted, because you're its only member.`,
    });
  });

  it('says a shared household keeps its lists, even when the user is its last owner', () => {
    expect(deleteAccountConfirmation([{ name: 'Home', listCount: 3, recipeCount: 2, memberCount: 2 }]).message).toBe(
      `${BASE}\n\nYour lists and recipes in Home stay with its other members.`,
    );
  });

  it('mixes: one line per sole household, then the shared ones joined on one line', () => {
    expect(
      deleteAccountConfirmation([
        { name: 'Personal', listCount: 2, recipeCount: 1, memberCount: 1 },
        { name: 'Home', listCount: 3, recipeCount: 4, memberCount: 3 },
        { name: 'Cabin', listCount: 1, recipeCount: 1, memberCount: 1 },
        { name: 'Office', listCount: 1, recipeCount: 0, memberCount: 2 },
      ]).message,
    ).toBe(
      [
        BASE,
        "Personal and its 2 lists and 1 recipe will be deleted, because you're its only member.",
        "Cabin and its 1 list and 1 recipe will be deleted, because you're its only member.",
        'Your lists and recipes in Home, Office stay with their other members.',
      ].join('\n\n'),
    );
  });

  it('falls back to the general wording when the members could not be fetched', () => {
    expect(deleteAccountConfirmation(null)).toEqual({ title: 'Delete your account?', message: BASE });
  });

  it('says only the general line for a user in no household', () => {
    expect(deleteAccountConfirmation([]).message).toBe(BASE);
  });

  it('has the second confirm, offline, failure and toast wording', () => {
    expect(DELETE_ACCOUNT_SECOND_CONFIRM).toEqual({ title: 'Are you sure?', message: 'Your account will be deleted now.' });
    expect(DELETE_ACCOUNT_OFFLINE).toEqual({ title: "You're offline", message: 'Connect to the internet to delete your account.' });
    expect(DELETE_ACCOUNT_FAILED).toEqual({ title: "Couldn't delete your account", message: 'Nothing was deleted. Try again later.' });
    expect(ACCOUNT_DELETED_TOAST).toBe('Your account was deleted.');
  });
});

describe('householdsForDeletion', () => {
  it('reads local counts and the member count from the server', async () => {
    const member = (id: string) => ({ user_id: id, first_name: id, last_name: null, avatar_url: null, role: 'member', joined_at: '' });
    respondToRpc('get_household_members', { data: [member(USER), member('u2')] });
    const home = db.select().from(households).get()!;
    expect(await householdsForDeletion(USER)).toEqual([{ name: home.name, listCount: 1, recipeCount: 0, memberCount: 2 }]);
    expect(rpcCallsFor('get_household_members')[0].args).toEqual({ p_household_id: home.id });
  });

  it('is null when the members cannot be fetched', async () => {
    respondToRpc('get_household_members', { error: { message: 'not a member' } });
    expect(await householdsForDeletion(USER)).toBeNull();
  });
});

describe('deleteAccount', () => {
  it('offline: throws without pushing, calling the server or touching the device', async () => {
    mockNetwork.state = { isConnected: false, isInternetReachable: false };
    await expect(deleteAccount()).rejects.toEqual(new DeleteAccountError('offline', 'offline'));
    expect(rpcCalls).toEqual([]);
    expect(mockOrder).toEqual([]);
    expect(db.select().from(listItems).all()).toHaveLength(1);
    expect(takeAccountDeletedNotice()).toBe(false);
  });

  it('pushes, calls delete_account, wipes, then signs out locally and of Google, in that order', async () => {
    onRpc((call) => {
      mockOrder.push(call.fn);
      return { data: { households: [] } };
    });
    await deleteAccount();
    expect(mockOrder).toEqual(['push', 'delete_account', 'wipe', 'signOut', 'google']);
    expect(rpcCallsFor('delete_account')[0].args).toBeUndefined();
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(db.select().from(households).all()).toEqual([]);
    expect(db.select().from(listItems).all()).toEqual([]);
    expect(takeAccountDeletedNotice()).toBe(true);
    expect(takeAccountDeletedNotice()).toBe(false);
  });

  it('a failed wipe is reported to Sentry, and the device still signs out', async () => {
    onRpc(() => ({ data: { households: [] } }));
    const error = new Error('database is locked');
    mockWipe.error = error;
    try {
      await deleteAccount();
    } finally {
      mockWipe.error = null;
    }
    expect(mockReportError).toHaveBeenCalledWith(error, { area: 'account', event: 'delete_wipe_failed' });
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it("doesn't fail when the server says the session is already gone on sign-out", async () => {
    signOut.mockImplementation(async () => {
      throw new Error('session not found');
    });
    await expect(deleteAccount()).resolves.toBeUndefined();
    expect(mockGoogleSignOut).toHaveBeenCalledTimes(1);
  });

  it('a server error leaves the device untouched and signed in', async () => {
    respondToRpc('delete_account', { error: { message: 'boom' } });
    await expect(deleteAccount()).rejects.toEqual(new DeleteAccountError('failed', 'boom'));
    expect(mockOrder).toEqual(['push']);
    expect(signOut).not.toHaveBeenCalled();
    expect(db.select().from(households).all()).toHaveLength(1);
    expect(db.select().from(listItems).all()).toHaveLength(1);
    expect(takeAccountDeletedNotice()).toBe(false);
  });

  it('a lost connection during the call is a failure too', async () => {
    onRpc(() => {
      throw new Error('Network request failed');
    });
    await expect(deleteAccount()).rejects.toMatchObject({ kind: 'failed', message: 'Network request failed' });
    expect(db.select().from(listItems).all()).toHaveLength(1);
  });

  it("doesn't wait on a push that hangs past the timeout", async () => {
    mockPush.impl = () => new Promise(() => {});
    await deleteAccount({ pushTimeoutMs: 10 });
    expect(rpcCallsFor('delete_account')).toHaveLength(1);
  });

  it('goes ahead when the push fails', async () => {
    mockPush.impl = async () => {
      throw new Error('push crashed');
    };
    await deleteAccount();
    expect(rpcCallsFor('delete_account')).toHaveLength(1);
  });

  it('an unknown network state counts as online', async () => {
    mockNetwork.state = new Error('no network module');
    await deleteAccount();
    expect(rpcCallsFor('delete_account')).toHaveLength(1);
  });
});
