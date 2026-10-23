import type { SupabaseClient } from '@supabase/supabase-js';
import { assertEquals, assertRejects } from '@std/assert';

import { CommitConflictError } from './commit.ts';
import { LeaseLostError } from './handler.ts';
import { createShareImportCommitStore, createShareImportWorkerStore } from './store.ts';

type Answer = { data: unknown; error: { code?: string; message?: string } | null };

/** A client whose rpc records each call and answers `answer`. */
function client(answer: Answer) {
  const calls: { fn: string; args: unknown }[] = [];
  const admin = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return answer;
    },
  } as unknown as SupabaseClient;
  return { store: createShareImportWorkerStore(admin), calls };
}

const ID = 'f0000000-0000-4000-8000-000000000001';
const LEASE = 'f0000000-0000-4000-8000-0000000000aa';

Deno.test('claim asks for the kinds and returns the first row, or null when none is due', async () => {
  const job = { id: ID, lease_token: LEASE, status: 'extracting' };
  const some = client({ data: [job], error: null });
  assertEquals(await some.store.claim(['extracting']), job);
  assertEquals(some.calls, [{ fn: 'claim_share_import', args: { p_kinds: ['extracting'] } }]);
  assertEquals(await client({ data: [], error: null }).store.claim(['extracting']), null);
});

Deno.test('reserve, save and release pass the lease and the outcome', async () => {
  const reserve = client({ data: 'daily_limit', error: null });
  assertEquals(await reserve.store.reserve(ID, LEASE), 'daily_limit');
  assertEquals(reserve.calls, [{ fn: 'reserve_share_import', args: { p_id: ID, p_lease: LEASE } }]);

  const save = client({ data: null, error: null });
  await save.store.saveExtraction(ID, LEASE, { name: 'Pasta' } as never);
  assertEquals(save.calls, [{ fn: 'save_share_extraction', args: { p_id: ID, p_lease: LEASE, p_extraction: { name: 'Pasta' } } }]);

  const release = client({ data: 'failed', error: null });
  assertEquals(await release.store.release(ID, LEASE, { kind: 'permanent', code: 'limit_reached', resetsAt: '2026-11-01T00:00:00.000Z' }), 'failed');
  assertEquals(release.calls[0].args, {
    p_id: ID, p_lease: LEASE, p_kind: 'permanent', p_code: 'limit_reached', p_next_attempt_at: null, p_resets_at: '2026-11-01T00:00:00.000Z',
  });
  const transient = client({ data: 'received', error: null });
  await transient.store.release(ID, LEASE, { kind: 'transient', code: 'fetch_failed' });
  assertEquals((transient.calls[0].args as { p_resets_at: unknown }).p_resets_at, null);
});

Deno.test('lease_lost (55000) is a LeaseLostError; any other error is thrown as is', async () => {
  const lost = client({ data: null, error: { code: '55000', message: 'lease_lost' } }).store;
  await assertRejects(() => lost.reserve(ID, LEASE), LeaseLostError);
  await assertRejects(() => lost.saveExtraction(ID, LEASE, {} as never), LeaseLostError);
  await assertRejects(() => lost.release(ID, LEASE, { kind: 'transient', code: 'internal' }), LeaseLostError);

  const other = { code: '42501', message: 'permission denied' };
  const failing = client({ data: null, error: other }).store;
  const err = await assertRejects(() => failing.claim(['extracting']));
  assertEquals(err, other);
});

const TARGET = {
  household_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  list_id: null,
  list_gone: true,
  recipe_id: 'c0000000-0000-4000-8000-000000000001',
  items_added: 0,
  items_combined: 0,
};

/** A commit store whose rpc answers `answer`. */
function commitClient(answer: Answer) {
  const calls: { fn: string; args: unknown }[] = [];
  const admin = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return answer;
    },
  } as unknown as SupabaseClient;
  return { store: createShareImportCommitStore(admin), calls };
}

Deno.test('commit passes the lease and the plan and returns the receipt', async () => {
  const receipt = { ...TARGET, applied_list_id: null, committed_at: '2026-10-23T10:00:00Z' };
  const c = commitClient({ data: receipt, error: null });
  const writes = [{ op: 'insert' as const, table: 'recipes' as const, id: TARGET.recipe_id, fields: { name: 'Pasta' } }];
  const preconditions = [{ kind: 'recipeAbsent' as const, recipeId: TARGET.recipe_id }];
  assertEquals(await c.store.commit(ID, LEASE, TARGET, writes, preconditions), receipt);
  assertEquals(c.calls, [{
    fn: 'commit_share_import',
    args: { p_id: ID, p_lease: LEASE, p_target: TARGET, p_writes: writes, p_preconditions: preconditions },
  }]);
});

Deno.test('commit: plan_conflict and destination_changed (40001) are CommitConflictErrors, lease_lost a LeaseLostError', async () => {
  for (const code of ['plan_conflict', 'destination_changed'] as const) {
    const err = await assertRejects(
      () => commitClient({ data: null, error: { code: '40001', message: code } }).store.commit(ID, LEASE, TARGET, [], []),
      CommitConflictError,
    );
    assertEquals(err.code, code);
  }
  await assertRejects(
    () => commitClient({ data: null, error: { code: '55000', message: 'lease_lost' } }).store.commit(ID, LEASE, TARGET, [], []),
    LeaseLostError,
  );
  // Another serialization failure isn't a plan conflict.
  const other = { code: '40001', message: 'could not serialize access' };
  assertEquals(await assertRejects(() => commitClient({ data: null, error: other }).store.commit(ID, LEASE, TARGET, [], [])), other);
});
