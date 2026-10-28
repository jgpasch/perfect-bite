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

Deno.test("recipeImport maps the job's row, its kind included, and is null when the job is gone", async () => {
  const row = {
    status: 'failed',
    kind: 'photo',
    user_id: 'u',
    recipe_id: null,
    recipe_name: null,
    applied_list_id: null,
    list_name: null,
    household_name: 'Smith home',
    list_gone: false,
    error_code: 'not_a_recipe',
    resets_at: null,
  };
  const calls: [string, Record<string, unknown>][] = [];
  const admin = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push([fn, args]);
      return Promise.resolve({ data: calls.length === 1 ? row : null, error: null });
    },
  } as unknown as SupabaseClient;
  const store = createNotificationStore(admin);
  assertEquals(await store.recipeImport('j'), {
    status: 'failed',
    kind: 'photo',
    recipeId: null,
    recipeName: null,
    appliedListId: null,
    listName: null,
    householdName: 'Smith home',
    listGone: false,
    errorCode: 'not_a_recipe',
    resetsAt: null,
  });
  assertEquals(await store.recipeImport('gone'), null);
  assertEquals(calls, [
    ['recipe_import_notification', { p_id: 'j' }],
    ['recipe_import_notification', { p_id: 'gone' }],
  ]);
});
