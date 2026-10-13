import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, households, lists, recipes } from '@/db';
import { resetDb } from '@/test/db';
import { respondToRpc, resetSupabase, rpcCalls, supabase } from '@/test/fake-supabase';

import {
  avatarInitial,
  earliestJoinedOther,
  fetchHouseholdMembers,
  HouseholdActionError,
  householdActionAlert,
  householdCountsLabel,
  householdsQuery,
  householdsWithCountsQuery,
  leaveConfirmation,
  leaveHousehold,
  memberLabel,
  MEMBERS_ERROR_MESSAGE,
  removeMember,
  removeMemberConfirmation,
  removeMemberSheet,
  renameHousehold,
  roleLabel,
  toHouseholdActionError,
  type HouseholdMember,
} from '../households';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));

// What the list snapshot would say each time it's rewritten (the App Group isn't there in tests).
const mockSnapshots: { userId: string; households: { id: string; name: string }[] }[] = [];
jest.mock('@/features/siri/list-snapshot', () => {
  const actual = jest.requireActual('@/features/siri/list-snapshot') as typeof import('@/features/siri/list-snapshot');
  return {
    ...actual,
    syncListSnapshot: (userId: string) =>
      mockSnapshots.push({ userId, households: actual.currentListSnapshot(userId).households }),
  };
});

const mockNetwork: { state: { isConnected: boolean; isInternetReachable: boolean | null } | Error } = {
  state: { isConnected: true, isInternetReachable: true },
};
jest.mock('expo-network', () => ({
  getNetworkStateAsync: async () => {
    if (mockNetwork.state instanceof Error) throw mockNetwork.state;
    return mockNetwork.state;
  },
  addNetworkStateListener: () => ({ remove: () => {} }),
}));

const mockPull = { calls: [] as string[], rpcCountAtPull: [] as number[] };
jest.mock('@/sync/pull', () => ({
  pullNow: async () => {
    const { rpcCalls: calls } = require('@/test/fake-supabase');
    mockPull.calls.push('pull');
    mockPull.rpcCountAtPull.push(calls.length);
    return { pulled: 0, households: [], error: null };
  },
}));

let warn: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  resetDb();
  resetSupabase();
  mockNetwork.state = { isConnected: true, isInternetReachable: true };
  mockPull.calls = [];
  mockPull.rpcCountAtPull = [];
  mockSnapshots.length = 0;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  db.insert(households).values({ id: 'h1', name: 'Personal', createdAt: new Date('2026-10-01T00:00:00Z') }).run();
});

afterEach(() => warn.mockRestore());

describe('householdsQuery', () => {
  test('returns local households oldest first', () => {
    db.insert(households).values({ id: 'h2', name: 'Work', createdAt: new Date('2026-10-05T00:00:00Z') }).run();
    db.insert(households).values({ id: 'h0', name: 'Cabin', createdAt: new Date('2026-09-01T00:00:00Z') }).run();
    expect(householdsQuery().all()).toEqual([
      { id: 'h0', name: 'Cabin', createdAt: new Date('2026-09-01T00:00:00Z') },
      { id: 'h1', name: 'Personal', createdAt: new Date('2026-10-01T00:00:00Z') },
      { id: 'h2', name: 'Work', createdAt: new Date('2026-10-05T00:00:00Z') },
    ]);
  });

  test('breaks a created_at tie by id', () => {
    db.insert(households).values({ id: 'h0', name: 'Cabin', createdAt: new Date('2026-10-01T00:00:00Z') }).run();
    expect(householdsQuery().all().map((h) => h.id)).toEqual(['h0', 'h1']);
  });

  test('returns [] with no local households', () => {
    resetDb();
    expect(householdsQuery().all()).toEqual([]);
  });
});

describe('householdsWithCountsQuery', () => {
  const list = (id: string, householdId: string, extra: { archivedAt?: Date; deletedAt?: Date } = {}) =>
    db.insert(lists).values({ id, householdId, name: id, position: 1, ...extra }).run();
  const recipe = (id: string, householdId: string, extra: { deletedAt?: Date } = {}) =>
    db.insert(recipes).values({ id, householdId, name: id, ...extra }).run();

  test('counts live, unarchived lists and live recipes per household, oldest household first', () => {
    db.insert(households).values({ id: 'h2', name: 'Lake house', createdAt: new Date('2026-10-05T00:00:00Z') }).run();
    list('groceries', 'h1');
    list('costco', 'h1');
    list('old', 'h1', { archivedAt: new Date('2026-10-02T00:00:00Z') });
    list('gone', 'h1', { deletedAt: new Date('2026-10-02T00:00:00Z') });
    list('cabin', 'h2');
    recipe('dal', 'h1');
    recipe('deleted', 'h1', { deletedAt: new Date('2026-10-02T00:00:00Z') });
    recipe('chili', 'h2');
    recipe('smores', 'h2');

    expect(householdsWithCountsQuery().all()).toEqual([
      { id: 'h1', name: 'Personal', listCount: 2, recipeCount: 1 },
      { id: 'h2', name: 'Lake house', listCount: 1, recipeCount: 2 },
    ]);
  });

  test('gives 0 for a household with no lists or recipes', () => {
    expect(householdsWithCountsQuery().all()).toEqual([{ id: 'h1', name: 'Personal', listCount: 0, recipeCount: 0 }]);
  });

  test('returns [] with no local households', () => {
    resetDb();
    expect(householdsWithCountsQuery().all()).toEqual([]);
  });
});

describe('householdCountsLabel', () => {
  test('pluralises each count on its own', () => {
    expect(householdCountsLabel(3, 4)).toBe('3 lists · 4 recipes');
    expect(householdCountsLabel(1, 1)).toBe('1 list · 1 recipe');
    expect(householdCountsLabel(1, 0)).toBe('1 list · 0 recipes');
    expect(householdCountsLabel(0, 2)).toBe('0 lists · 2 recipes');
  });
});

describe('avatarInitial', () => {
  test('is the first letter, upper-cased', () => {
    expect(avatarInitial('john')).toBe('J');
    expect(avatarInitial('Sam')).toBe('S');
    expect(avatarInitial('jgpasch@gmail.com')).toBe('J');
  });

  test('skips leading spaces and symbols, and takes digits and non-Latin letters', () => {
    expect(avatarInitial('  _pat')).toBe('P');
    expect(avatarInitial('"émile"')).toBe('É');
    expect(avatarInitial('9lives@example.com')).toBe('9');
    expect(avatarInitial('Øystein')).toBe('Ø');
  });

  test('is "?" with nothing to show', () => {
    expect(avatarInitial('')).toBe('?');
    expect(avatarInitial('   ')).toBe('?');
    expect(avatarInitial('@.')).toBe('?');
    expect(avatarInitial(null)).toBe('?');
    expect(avatarInitial(undefined)).toBe('?');
  });
});

describe('fetchHouseholdMembers', () => {
  const alex = {
    user_id: 'u1',
    display_name: 'Alex',
    avatar_url: 'https://example.com/a.png',
    role: 'owner',
    joined_at: '2026-10-01T00:00:00+00:00',
  };
  const sam = { user_id: 'u2', display_name: 'Sam', avatar_url: null, role: 'member', joined_at: '2026-10-02T00:00:00+00:00' };

  test('calls get_household_members with the household id', async () => {
    respondToRpc('get_household_members', { data: [alex] });
    await fetchHouseholdMembers('h1', 'u1');
    expect(rpcCalls).toEqual([{ fn: 'get_household_members', args: { p_household_id: 'h1' } }]);
  });

  test("maps rows in the server's order and marks the caller's row", async () => {
    respondToRpc('get_household_members', { data: [alex, sam] });
    await expect(fetchHouseholdMembers('h1', 'u2')).resolves.toEqual([
      {
        userId: 'u1',
        displayName: 'Alex',
        avatarUrl: 'https://example.com/a.png',
        role: 'owner',
        joinedAt: '2026-10-01T00:00:00+00:00',
        isYou: false,
      },
      { userId: 'u2', displayName: 'Sam', avatarUrl: null, role: 'member', joinedAt: '2026-10-02T00:00:00+00:00', isYou: true },
    ]);
  });

  test("keeps the server's order rather than re-sorting", async () => {
    const zoe = { ...alex, user_id: 'u3', display_name: 'Zoe' };
    respondToRpc('get_household_members', { data: [zoe, alex, sam] });
    const members = await fetchHouseholdMembers('h1', 'u1');
    expect(members.map((m) => m.displayName)).toEqual(['Zoe', 'Alex', 'Sam']);
    expect(members.map((m) => m.isYou)).toEqual([false, true, false]);
  });

  test("no row is marked as you when the caller isn't in the result", async () => {
    respondToRpc('get_household_members', { data: [alex, sam] });
    const members = await fetchHouseholdMembers('h1', 'u9');
    expect(members.map((m) => m.isYou)).toEqual([false, false]);
  });

  test('an empty result returns []', async () => {
    respondToRpc('get_household_members', { data: [] });
    await expect(fetchHouseholdMembers('h1', 'u1')).resolves.toEqual([]);
  });

  test('null data returns []', async () => {
    respondToRpc('get_household_members', { data: null });
    await expect(fetchHouseholdMembers('h1', 'u1')).resolves.toEqual([]);
  });

  test("an RPC error is thrown as an Error with the server's message", async () => {
    respondToRpc('get_household_members', { error: { message: 'not a member of household h1', code: '42501' } });
    const result = fetchHouseholdMembers('h1', 'u1');
    await expect(result).rejects.toBeInstanceOf(Error);
    await expect(result).rejects.toThrow('not a member of household h1');
  });

  test('an error without a message still throws an Error', async () => {
    respondToRpc('get_household_members', { error: { code: '500' } });
    await expect(fetchHouseholdMembers('h1', 'u1')).rejects.toThrow("Couldn't load members");
  });

  test('a rejected call (offline) propagates', async () => {
    supabase.rpc.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(fetchHouseholdMembers('h1', 'u1')).rejects.toThrow('Network request failed');
  });
});

describe('member row labels', () => {
  test('memberLabel is the display name, with "(You)" on your own row', () => {
    expect(memberLabel({ displayName: 'Sam', isYou: false })).toBe('Sam');
    expect(memberLabel({ displayName: 'Alex', isYou: true })).toBe('Alex (You)');
  });

  test('memberLabel trims the name and falls back to "Unnamed" for a blank one', () => {
    expect(memberLabel({ displayName: '  Pat  ', isYou: false })).toBe('Pat');
    expect(memberLabel({ displayName: '', isYou: false })).toBe('Unnamed');
    expect(memberLabel({ displayName: '   ', isYou: true })).toBe('Unnamed (You)');
  });

  test('roleLabel', () => {
    expect(roleLabel('owner')).toBe('Owner');
    expect(roleLabel('member')).toBe('Member');
  });

  test('labels for fetched members, in server order', async () => {
    respondToRpc('get_household_members', {
      data: [
        { user_id: 'u1', display_name: 'Alex', avatar_url: null, role: 'owner', joined_at: '2026-10-01T00:00:00Z' },
        { user_id: 'u2', display_name: 'Sam', avatar_url: null, role: 'member', joined_at: '2026-10-02T00:00:00Z' },
      ],
    });
    const members = await fetchHouseholdMembers('h1', 'u2');
    expect(members.map((m) => [memberLabel(m), roleLabel(m.role)])).toEqual([
      ['Alex', 'Owner'],
      ['Sam (You)', 'Member'],
    ]);
  });

  test('the error message', () => {
    expect(MEMBERS_ERROR_MESSAGE).toBe("Couldn't load members. Check your connection.");
  });
});

const member = (userId: string, overrides: Partial<HouseholdMember> = {}): HouseholdMember => ({
  userId,
  displayName: userId,
  avatarUrl: null,
  role: 'member',
  joinedAt: '2026-10-01T00:00:00+00:00',
  isYou: false,
  ...overrides,
});

describe('leaveConfirmation (spec 4.7)', () => {
  const base = { householdName: 'Cabin', listCount: 3, recipeCount: 1, onlyHousehold: false };
  const PLAIN = "You'll lose access to its lists and recipes. They stay with the household.";

  test('a plain member', () => {
    const members = [member('a', { role: 'owner', displayName: 'Alex' }), member('me', { isYou: true })];
    expect(leaveConfirmation({ ...base, members })).toEqual({ title: 'Leave Cabin?', message: PLAIN, confirmLabel: 'Leave' });
  });

  test('one of several owners: nobody is promoted', () => {
    const members = [member('a', { role: 'owner' }), member('me', { role: 'owner', isYou: true }), member('b')];
    expect(leaveConfirmation({ ...base, members })).toEqual({ title: 'Leave Cabin?', message: PLAIN, confirmLabel: 'Leave' });
  });

  test('the last owner with other members names the earliest-joined, who becomes the owner', () => {
    const members = [
      member('me', { role: 'owner', isYou: true, joinedAt: '2026-01-01T00:00:00Z' }),
      member('late', { displayName: 'Sam', joinedAt: '2026-10-05T00:00:00Z' }),
      member('early', { displayName: 'Jamie', joinedAt: '2026-10-02T00:00:00Z' }),
    ];
    expect(leaveConfirmation({ ...base, members })).toEqual({
      title: 'Leave Cabin?',
      message: `${PLAIN} Jamie will become the owner.`,
      confirmLabel: 'Leave',
    });
  });

  test('the last member is told the household and its lists and recipes will be deleted', () => {
    const members = [member('me', { role: 'owner', isYou: true })];
    expect(leaveConfirmation({ ...base, members })).toEqual({
      title: 'Leave and delete Cabin?',
      message: "You're the only member, so its 3 lists and 1 recipe will be deleted.",
      confirmLabel: 'Leave and Delete',
    });
  });

  test('the last member with one list and no recipes uses the singular and plural correctly', () => {
    const members = [member('me', { role: 'owner', isYou: true })];
    expect(leaveConfirmation({ ...base, listCount: 1, recipeCount: 0, members }).message).toBe(
      "You're the only member, so its 1 list and 0 recipes will be deleted.",
    );
  });

  test('only household: every case adds the new empty household', () => {
    const only = { ...base, onlyHousehold: true };
    const NEW = " You'll get a new empty household.";
    expect(leaveConfirmation({ ...only, members: [member('a', { role: 'owner' }), member('me', { isYou: true })] }).message).toBe(
      PLAIN + NEW,
    );
    expect(
      leaveConfirmation({
        ...only,
        members: [member('me', { role: 'owner', isYou: true }), member('b', { displayName: 'Bo' })],
      }).message,
    ).toBe(`${PLAIN} Bo will become the owner.${NEW}`);
    expect(leaveConfirmation({ ...only, members: [member('me', { role: 'owner', isYou: true })] })).toEqual({
      title: 'Leave and delete Cabin?',
      message: `You're the only member, so its 3 lists and 1 recipe will be deleted.${NEW}`,
      confirmLabel: 'Leave and Delete',
    });
  });

  test('a blank household name and a blank heir name fall back', () => {
    const members = [member('me', { role: 'owner', isYou: true }), member('b', { displayName: '  ' })];
    expect(leaveConfirmation({ ...base, householdName: '  ', members })).toEqual({
      title: 'Leave this household?',
      message: `${PLAIN} The earliest member will become the owner.`,
      confirmLabel: 'Leave',
    });
  });

  test("the household name is trimmed", () => {
    const members = [member('me', { isYou: true }), member('a', { role: 'owner' })];
    expect(leaveConfirmation({ ...base, householdName: ' Cabin ', members }).title).toBe('Leave Cabin?');
  });
});

describe('earliestJoinedOther', () => {
  test('skips you, takes the earliest join, and breaks ties by user id like the server', () => {
    const members = [
      member('me', { isYou: true, joinedAt: '2020-01-01T00:00:00Z' }),
      member('zed', { joinedAt: '2026-10-02T00:00:00Z' }),
      member('amy', { joinedAt: '2026-10-02T00:00:00Z' }),
      member('later', { joinedAt: '2026-10-03T00:00:00Z' }),
    ];
    expect(earliestJoinedOther(members)?.userId).toBe('amy');
  });

  test('compares times, not text: an offset timestamp sorts by its instant', () => {
    const members = [member('a', { joinedAt: '2026-10-02T01:00:00+02:00' }), member('b', { joinedAt: '2026-10-02T00:30:00+00:00' })];
    expect(earliestJoinedOther(members)?.userId).toBe('a');
  });

  test('undefined when you are alone, or the list is empty', () => {
    expect(earliestJoinedOther([member('me', { isYou: true })])).toBeUndefined();
    expect(earliestJoinedOther([])).toBeUndefined();
  });
});

describe('remove member texts', () => {
  test('the action sheet: Remove from <household> (destructive), then Cancel', () => {
    expect(removeMemberSheet('Cabin')).toEqual({
      options: ['Remove from Cabin', 'Cancel'],
      destructiveButtonIndex: 0,
      cancelButtonIndex: 1,
    });
    expect(removeMemberSheet(' ').options[0]).toBe('Remove from this household');
  });

  test('the confirm names the member and the household', () => {
    expect(removeMemberConfirmation('Sam', 'Cabin')).toEqual({
      title: 'Remove Sam?',
      message: "They'll lose access to Cabin's lists and recipes.",
    });
    expect(removeMemberConfirmation(' ', '')).toEqual({
      title: 'Remove this member?',
      message: "They'll lose access to this household's lists and recipes.",
    });
  });
});

describe('toHouseholdActionError and householdActionAlert', () => {
  test.each([
    ['not an owner', 'not-owner'],
    ['not a member', 'not-member'],
    ['TypeError: Network request failed', 'offline'],
    ['Failed to fetch', 'offline'],
    ['cannot remove yourself; use leave_household', 'failed'],
    ['not authenticated', 'failed'],
    ['household name cannot be blank', 'blank'],
    ['household name is too long', 'too-long'],
  ])('%s maps to %s', (message, kind) => {
    const error = toHouseholdActionError({ message });
    expect(error).toBeInstanceOf(HouseholdActionError);
    expect(error.kind).toBe(kind);
    expect(error.message).toBe(message);
  });

  test('no message maps to failed with a fallback', () => {
    expect(toHouseholdActionError(null)).toMatchObject({ kind: 'failed', message: 'Request failed' });
    expect(toHouseholdActionError({ message: 42 })).toMatchObject({ kind: 'failed', message: 'Request failed' });
  });

  test('a HouseholdActionError passes through unchanged', () => {
    const error = new HouseholdActionError('offline', 'offline');
    expect(toHouseholdActionError(error)).toBe(error);
  });

  test('alerts per kind and action', () => {
    const names = { householdName: 'Cabin', memberName: 'Sam' };
    expect(householdActionAlert('leave', new HouseholdActionError('offline', ''), names)).toEqual({
      title: "You're offline",
      message: 'Connect to the internet and try again.',
    });
    expect(householdActionAlert('remove', { message: 'Network request failed' }, names).title).toBe("You're offline");
    expect(householdActionAlert('leave', { message: 'not a member' }, names)).toEqual({
      title: "Couldn't leave Cabin",
      message: "You're no longer in Cabin.",
    });
    expect(householdActionAlert('remove', { message: 'not a member' }, names)).toEqual({
      title: "Couldn't remove Sam",
      message: "They're no longer in Cabin.",
    });
    expect(householdActionAlert('remove', { message: 'not an owner' }, names)).toEqual({
      title: "Couldn't remove Sam",
      message: 'Only owners can remove members.',
    });
    expect(householdActionAlert('leave', { message: 'boom' }, {})).toEqual({
      title: "Couldn't leave this household",
      message: 'Something went wrong. Try again.',
    });
    expect(householdActionAlert('remove', { message: 'boom' })).toEqual({
      title: "Couldn't remove them",
      message: 'Something went wrong. Try again.',
    });
  });
});

describe('leaveHousehold', () => {
  test('calls leave_household, then pulls, and returns the outcome', async () => {
    respondToRpc('leave_household', { data: { outcome: 'deleted', new_household_id: 'h-new' } });
    await expect(leaveHousehold('h1')).resolves.toEqual({ outcome: 'deleted', newHouseholdId: 'h-new' });
    expect(rpcCalls).toEqual([{ fn: 'leave_household', args: { p_household_id: 'h1' } }]);
    // The pull ran once, after the server call.
    expect(mockPull.calls).toEqual(['pull']);
    expect(mockPull.rpcCountAtPull).toEqual([1]);
  });

  test('a plain leave has no new household', async () => {
    respondToRpc('leave_household', { data: { outcome: 'left', new_household_id: null } });
    await expect(leaveHousehold('h1')).resolves.toEqual({ outcome: 'left', newHouseholdId: null });
  });

  test("doesn't make a starter household itself: the local households are untouched until the pull", async () => {
    respondToRpc('leave_household', { data: { outcome: 'deleted', new_household_id: 'h-new' } });
    await leaveHousehold('h1');
    expect(db.select({ id: households.id }).from(households).all()).toEqual([{ id: 'h1' }]);
  });

  test('a server error is thrown typed and nothing is pulled', async () => {
    respondToRpc('leave_household', { error: { message: 'not a member', code: '42501' } });
    const result = leaveHousehold('h1');
    await expect(result).rejects.toBeInstanceOf(HouseholdActionError);
    await expect(result).rejects.toMatchObject({ kind: 'not-member' });
    expect(mockPull.calls).toEqual([]);
  });

  test('offline: says so without asking the server or pulling', async () => {
    mockNetwork.state = { isConnected: false, isInternetReachable: false };
    await expect(leaveHousehold('h1')).rejects.toMatchObject({ kind: 'offline' });
    expect(rpcCalls).toEqual([]);
    expect(mockPull.calls).toEqual([]);
  });

  test('connected but the internet unreachable counts as offline', async () => {
    mockNetwork.state = { isConnected: true, isInternetReachable: false };
    await expect(leaveHousehold('h1')).rejects.toMatchObject({ kind: 'offline' });
    expect(rpcCalls).toEqual([]);
  });

  test("when the network state can't be read, the call goes ahead", async () => {
    mockNetwork.state = new Error('no module');
    respondToRpc('leave_household', { data: { outcome: 'left', new_household_id: null } });
    await expect(leaveHousehold('h1')).resolves.toEqual({ outcome: 'left', newHouseholdId: null });
  });

  test('a rejected call (lost connection mid-call) maps to offline', async () => {
    supabase.rpc.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(leaveHousehold('h1')).rejects.toMatchObject({ kind: 'offline' });
    expect(mockPull.calls).toEqual([]);
  });
});

describe('removeMember', () => {
  test('calls remove_member with the household and the user, and does not pull', async () => {
    respondToRpc('remove_member', { data: { outcome: 'left', new_household_id: null } });
    await expect(removeMember('h1', 'u2')).resolves.toBeUndefined();
    expect(rpcCalls).toEqual([{ fn: 'remove_member', args: { p_household_id: 'h1', p_user_id: 'u2' } }]);
    expect(mockPull.calls).toEqual([]);
  });

  test('not an owner is thrown typed', async () => {
    respondToRpc('remove_member', { error: { message: 'not an owner', code: '42501' } });
    await expect(removeMember('h1', 'u2')).rejects.toMatchObject({ kind: 'not-owner' });
  });

  test('removing yourself is a plain failure', async () => {
    respondToRpc('remove_member', { error: { message: 'cannot remove yourself; use leave_household', code: '22023' } });
    await expect(removeMember('h1', 'u1')).rejects.toMatchObject({ kind: 'failed' });
  });

  test('a rejected call maps to offline', async () => {
    supabase.rpc.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(removeMember('h1', 'u2')).rejects.toMatchObject({ kind: 'offline' });
  });

  test('offline: says so without asking the server', async () => {
    mockNetwork.state = { isConnected: false, isInternetReachable: null };
    await expect(removeMember('h1', 'u2')).rejects.toMatchObject({ kind: 'offline' });
    expect(rpcCalls).toEqual([]);
  });
});

describe('renameHousehold', () => {
  const localNames = () => db.select({ id: households.id, name: households.name }).from(households).all();

  test('calls rename_household with the trimmed name, updates the local row and rewrites the snapshot', async () => {
    db.insert(households).values({ id: 'h2', name: 'Work', createdAt: new Date('2026-10-05T00:00:00Z') }).run();
    const before = db.select().from(households).where(eq(households.id, 'h1')).get()!;
    respondToRpc('rename_household', { data: null });
    await expect(renameHousehold('h1', '  Smith home  ', 'u1')).resolves.toBeUndefined();
    expect(rpcCalls).toEqual([{ fn: 'rename_household', args: { p_household_id: 'h1', p_name: 'Smith home' } }]);
    expect(localNames()).toEqual([
      { id: 'h1', name: 'Smith home' },
      { id: 'h2', name: 'Work' },
    ]);
    const after = db.select().from(households).where(eq(households.id, 'h1')).get()!;
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
    expect(mockSnapshots).toEqual([
      {
        userId: 'u1',
        households: [
          { id: 'h1', name: 'Smith home' },
          { id: 'h2', name: 'Work' },
        ],
      },
    ]);
    // Nothing else: no pull, the row is already right.
    expect(mockPull.calls).toEqual([]);
  });

  test('the snapshot carries the new household name on its lists', async () => {
    db.insert(lists).values({ id: 'l1', householdId: 'h1', name: 'Groceries', position: 1 }).run();
    respondToRpc('rename_household', { data: null });
    await renameHousehold('h1', 'Cabin', 'u1');
    const { currentListSnapshot } = jest.requireActual(
      '@/features/siri/list-snapshot',
    ) as typeof import('@/features/siri/list-snapshot');
    expect(currentListSnapshot('u1').lists.map((l) => [l.id, l.householdName])).toEqual([['l1', 'Cabin']]);
  });

  test('without a user it renames but leaves the snapshot alone', async () => {
    respondToRpc('rename_household', { data: null });
    await renameHousehold('h1', 'Cabin', null);
    expect(localNames()).toEqual([{ id: 'h1', name: 'Cabin' }]);
    expect(mockSnapshots).toEqual([]);
  });

  test.each(['', '   ', '\n\t'])('a blank name (%j) throws without asking the server', async (name) => {
    await expect(renameHousehold('h1', name, 'u1')).rejects.toMatchObject({ kind: 'blank' });
    expect(rpcCalls).toEqual([]);
    expect(localNames()).toEqual([{ id: 'h1', name: 'Personal' }]);
    expect(mockSnapshots).toEqual([]);
  });

  test('50 characters is fine; 51 throws too-long without asking the server', async () => {
    await expect(renameHousehold('h1', 'x'.repeat(51), 'u1')).rejects.toMatchObject({ kind: 'too-long' });
    expect(rpcCalls).toEqual([]);
    respondToRpc('rename_household', { data: null });
    await renameHousehold('h1', ` ${'x'.repeat(50)} `, 'u1');
    expect(rpcCalls).toHaveLength(1);
    expect(localNames()).toEqual([{ id: 'h1', name: 'x'.repeat(50) }]);
  });

  test('counts characters, not UTF-16 units, as the server does', async () => {
    respondToRpc('rename_household', { data: null });
    const name = '🍕'.repeat(50); // 100 UTF-16 units, 50 characters
    await renameHousehold('h1', name, 'u1');
    expect(localNames()).toEqual([{ id: 'h1', name }]);
  });

  test.each([
    ['not an owner', 'not-owner'],
    ['not a member', 'not-member'],
    ['household name is too long', 'too-long'],
    ['household name cannot be blank', 'blank'],
    ['boom', 'failed'],
  ])('a server error %j is thrown as %s and changes nothing', async (message, kind) => {
    respondToRpc('rename_household', { error: { message, code: '42501' } });
    const result = renameHousehold('h1', 'Cabin', 'u1');
    await expect(result).rejects.toBeInstanceOf(HouseholdActionError);
    await expect(result).rejects.toMatchObject({ kind });
    expect(localNames()).toEqual([{ id: 'h1', name: 'Personal' }]);
    expect(mockSnapshots).toEqual([]);
  });

  test('offline: says so without asking the server and changes nothing', async () => {
    mockNetwork.state = { isConnected: false, isInternetReachable: false };
    await expect(renameHousehold('h1', 'Cabin', 'u1')).rejects.toMatchObject({ kind: 'offline' });
    expect(rpcCalls).toEqual([]);
    expect(localNames()).toEqual([{ id: 'h1', name: 'Personal' }]);
    expect(mockSnapshots).toEqual([]);
  });

  test('a rejected call (lost connection mid-call) maps to offline and changes nothing', async () => {
    supabase.rpc.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(renameHousehold('h1', 'Cabin', 'u1')).rejects.toMatchObject({ kind: 'offline' });
    expect(localNames()).toEqual([{ id: 'h1', name: 'Personal' }]);
  });

  test('the rename alerts', () => {
    const names = { householdName: 'Cabin' };
    expect(householdActionAlert('rename', new HouseholdActionError('offline', ''), names)).toEqual({
      title: "You're offline",
      message: 'Connect to the internet and try again.',
    });
    expect(householdActionAlert('rename', { message: 'not an owner' }, names)).toEqual({
      title: "Couldn't rename Cabin",
      message: 'Only owners can rename a household.',
    });
    expect(householdActionAlert('rename', { message: 'not a member' }, names)).toEqual({
      title: "Couldn't rename Cabin",
      message: "You're no longer in Cabin.",
    });
    expect(householdActionAlert('rename', { message: 'household name is too long' }, names)).toEqual({
      title: "Couldn't rename Cabin",
      message: 'Use a shorter name (up to 50 characters).',
    });
    expect(householdActionAlert('rename', { message: 'household name cannot be blank' }, names)).toEqual({
      title: "Couldn't rename Cabin",
      message: 'Enter a name.',
    });
    expect(householdActionAlert('rename', { message: 'boom' }, {})).toEqual({
      title: "Couldn't rename this household",
      message: 'Something went wrong. Try again.',
    });
  });
});
