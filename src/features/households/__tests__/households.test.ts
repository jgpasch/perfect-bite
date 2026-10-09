import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';

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

import { registerHouseholds } from '../households';

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
