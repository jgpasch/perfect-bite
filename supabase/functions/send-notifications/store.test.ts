import { assertEquals, assertRejects } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createNotificationStore } from './store.ts';

function fakeAdmin(error: unknown = null) {
  const calls: [string, Record<string, unknown>][] = [];
  const admin = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push([fn, args]);
      return Promise.resolve({ data: null, error });
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

Deno.test('archive without a group archives only', async () => {
  const { admin, calls } = fakeAdmin();
  await createNotificationStore(admin).archive([1, 2]);
  assertEquals(calls, [['archive_household_events', { p_msg_ids: [1, 2] }]]);
});

Deno.test('archive with a sent group archives and records it in one call', async () => {
  const { admin, calls } = fakeAdmin();
  await createNotificationStore(admin).archive([3], { householdId: 'h', actor: 'a', listId: 'l', kind: 'shopping' });
  assertEquals(calls, [
    ['archive_sent_household_events', { p_msg_ids: [3], p_household_id: 'h', p_actor: 'a', p_list_id: 'l', p_kind: 'shopping' }],
  ]);
});

Deno.test('an RPC error rejects', async () => {
  const { admin } = fakeAdmin({ message: 'boom', code: '08006' });
  await assertRejects(() => createNotificationStore(admin).archive([1], { householdId: 'h', actor: 'a', listId: 'l', kind: 'items_added' }));
});
