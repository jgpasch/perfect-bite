import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { db, households, lists, recipes } from '@/db';
import { getDeviceSetting } from '@/features/settings/device-settings';
import { resetDb } from '@/test/db';
import {
  onRpc,
  respondToRpc,
  resetSupabase,
  rpcCalls,
  setSupabaseConfigured,
  supabase,
} from '@/test/fake-supabase';

import {
  avatarInitial,
  fetchHouseholdMembers,
  householdCountsLabel,
  householdsQuery,
  householdsWithCountsQuery,
  memberLabel,
  MEMBERS_ERROR_MESSAGE,
  registerHouseholds,
  roleLabel,
} from '../households';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));

let warn: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  resetDb();
  resetSupabase();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  db.insert(households).values({ id: 'h1', name: 'Personal', createdAt: new Date('2026-10-01T00:00:00Z') }).run();
});

afterEach(() => warn.mockRestore());

const create = (id: string, name: string) => ({ fn: 'create_household', args: { p_id: id, p_name: name } });

test("sends the local household's id and name and remembers it for the user", async () => {
  await registerHouseholds('u1');
  expect(rpcCalls).toEqual([create('h1', 'Personal')]);
  expect(getDeviceSetting('household.h1.registeredFor', null)).toBe('u1');
  expect(warn).not.toHaveBeenCalled();
});

test('sends every local household, oldest first', async () => {
  db.insert(households).values({ id: 'h0', name: 'Cabin', createdAt: new Date('2026-09-01T00:00:00Z') }).run();
  await registerHouseholds('u1');
  expect(rpcCalls).toEqual([create('h0', 'Cabin'), create('h1', 'Personal')]);
});

test("doesn't resend after success", async () => {
  await registerHouseholds('u1');
  await registerHouseholds('u1');
  expect(rpcCalls).toHaveLength(1);
});

test('only sends households added since the last success', async () => {
  await registerHouseholds('u1');
  db.insert(households).values({ id: 'h2', name: 'Work' }).run();
  await registerHouseholds('u1');
  expect(rpcCalls).toEqual([create('h1', 'Personal'), create('h2', 'Work')]);
});

test('resends after a server error, and stops once it succeeds', async () => {
  respondToRpc('create_household', { error: { message: 'Household already exists', code: '42501' } });
  await registerHouseholds('u1');
  expect(getDeviceSetting('household.h1.registeredFor', null)).toBeNull();
  expect(warn).toHaveBeenCalledTimes(1);

  await registerHouseholds('u1');
  await registerHouseholds('u1');
  expect(rpcCalls).toEqual([create('h1', 'Personal'), create('h1', 'Personal')]);
  expect(getDeviceSetting('household.h1.registeredFor', null)).toBe('u1');
});

test('an rpc that rejects (offline) is logged, not thrown, and retried', async () => {
  supabase.rpc.mockRejectedValueOnce(new TypeError('Network request failed'));
  await expect(registerHouseholds('u1')).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledWith(
    "Couldn't register household h1; will retry next launch",
    new TypeError('Network request failed'),
  );
  expect(getDeviceSetting('household.h1.registeredFor', null)).toBeNull();

  await registerHouseholds('u1');
  expect(supabase.rpc).toHaveBeenCalledTimes(2);
  expect(getDeviceSetting('household.h1.registeredFor', null)).toBe('u1');
});

test('one failing household still lets the others register', async () => {
  db.insert(households).values({ id: 'h2', name: 'Work', createdAt: new Date('2026-10-02T00:00:00Z') }).run();
  onRpc((call) => (call.args?.p_id === 'h1' ? { error: { message: 'boom' } } : undefined));
  await registerHouseholds('u1');
  expect(rpcCalls).toEqual([create('h1', 'Personal'), create('h2', 'Work')]);
  expect(getDeviceSetting('household.h1.registeredFor', null)).toBeNull();
  expect(getDeviceSetting('household.h2.registeredFor', null)).toBe('u1');
});

test('a different user on the same device registers again', async () => {
  await registerHouseholds('u1');
  await registerHouseholds('u2');
  expect(rpcCalls).toEqual([create('h1', 'Personal'), create('h1', 'Personal')]);
  expect(getDeviceSetting('household.h1.registeredFor', null)).toBe('u2');
});

test('does nothing when Supabase is not configured', async () => {
  setSupabaseConfigured(false);
  await registerHouseholds('u1');
  expect(supabase.rpc).not.toHaveBeenCalled();
  expect(getDeviceSetting('household.h1.registeredFor', null)).toBeNull();
  expect(warn).not.toHaveBeenCalled();
});

test('does nothing with no local households', async () => {
  resetDb();
  await registerHouseholds('u1');
  expect(supabase.rpc).not.toHaveBeenCalled();
});

test('a local database error is logged, not thrown', async () => {
  const select = jest.spyOn(db, 'select').mockImplementation(() => {
    throw new Error('disk I/O error');
  });
  try {
    await expect(registerHouseholds('u1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("Couldn't register households", new Error('disk I/O error'));
    expect(supabase.rpc).not.toHaveBeenCalled();
  } finally {
    select.mockRestore();
  }
});

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
      { userId: 'u1', displayName: 'Alex', avatarUrl: 'https://example.com/a.png', role: 'owner', isYou: false },
      { userId: 'u2', displayName: 'Sam', avatarUrl: null, role: 'member', isYou: true },
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
