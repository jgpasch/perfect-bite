import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { db, households } from '@/db';
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

import { fetchHouseholdMembers, householdsQuery, registerHouseholds } from '../households';

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
