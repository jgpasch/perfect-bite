import { beforeEach, expect, test } from '@jest/globals';

import {
  onRpc,
  respondToRpc,
  resetSupabase,
  rpcCalls,
  rpcCallsFor,
  setSupabaseConfigured,
  supabase,
} from '../fake-supabase';
import * as fake from '../fake-supabase';

beforeEach(() => resetSupabase());

test('rpc records each call with its function and args', async () => {
  await supabase.rpc('create_household', { p_id: 'h1', p_name: 'Home' });
  await supabase.rpc('get_household_members', { p_household_id: 'h1' });
  expect(rpcCalls).toEqual([
    { fn: 'create_household', args: { p_id: 'h1', p_name: 'Home' } },
    { fn: 'get_household_members', args: { p_household_id: 'h1' } },
  ]);
  expect(rpcCallsFor('create_household')).toEqual([{ fn: 'create_household', args: { p_id: 'h1', p_name: 'Home' } }]);
  expect(supabase.rpc).toHaveBeenCalledTimes(2);
});

test('rpc resolves with no data and no error by default', async () => {
  await expect(supabase.rpc('anything')).resolves.toEqual({ data: null, error: null });
  expect(rpcCalls).toEqual([{ fn: 'anything', args: undefined }]);
});

test('respondToRpc queues results per function, in order, ahead of onRpc', async () => {
  respondToRpc('f', { data: 1 }, { error: { message: 'boom' } });
  onRpc((call) => ({ data: `handled ${call.fn}` }));
  await expect(supabase.rpc('f')).resolves.toEqual({ data: 1, error: null });
  await expect(supabase.rpc('g')).resolves.toEqual({ data: 'handled g', error: null });
  await expect(supabase.rpc('f')).resolves.toEqual({ data: null, error: { message: 'boom' } });
  await expect(supabase.rpc('f')).resolves.toEqual({ data: 'handled f', error: null });
});

test('onRpc sees the args and can fall through to the default', async () => {
  onRpc((call) => (call.args?.p_id === 'bad' ? { error: { message: 'nope' } } : undefined));
  await expect(supabase.rpc('f', { p_id: 'bad' })).resolves.toEqual({ data: null, error: { message: 'nope' } });
  await expect(supabase.rpc('f', { p_id: 'ok' })).resolves.toEqual({ data: null, error: null });
});

test('rpc calls are separate from table queries', async () => {
  await supabase.rpc('f');
  expect(fake.queries).toEqual([]);
});

test('resetSupabase clears calls, queued results, handlers and configured state', async () => {
  respondToRpc('f', { data: 1 });
  onRpc(() => ({ data: 2 }));
  supabase.rpc.mockRejectedValue(new Error('offline'));
  setSupabaseConfigured(false);
  expect(fake.isSupabaseConfigured).toBe(false);

  resetSupabase();
  expect(rpcCalls).toEqual([]);
  expect(fake.isSupabaseConfigured).toBe(true);
  await expect(supabase.rpc('f')).resolves.toEqual({ data: null, error: null });
  expect(rpcCalls).toHaveLength(1);
});
