import type { SupabaseClient } from '@supabase/supabase-js';
import { assertEquals, assertRejects } from '@std/assert';

import { CommitConflictError } from './commit.ts';
import { LeaseLostError } from './handler.ts';
import {
  createSharePageStorage,
  createShareImportCommitStore,
  createShareImportWorkerStore,
  isObjectMissing,
  recipeUrlLookupKey,
} from './store.ts';

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

Deno.test('recipeUrlLookupKey: the canonical URL host and path, trailing slashes dropped; null when it does not parse', () => {
  assertEquals(recipeUrlLookupKey('https://example.com/garlic-pasta'), 'example.com/garlic-pasta');
  assertEquals(recipeUrlLookupKey('https://example.com:8443/a/b?id=3'), 'example.com/a/b');
  assertEquals(recipeUrlLookupKey('http://example.com'), 'example.com');
  // A canonical URL has had one `www.` dropped already: a second one stays.
  assertEquals(recipeUrlLookupKey('https://www.example.com/x'), 'www.example.com/x');
  assertEquals(recipeUrlLookupKey('not a url'), null);
});

Deno.test('reuseCandidates asks share_import_reuse_candidates for the URL key and maps the rows', async () => {
  const row = { id: TARGET.recipe_id, name: 'Pasta', household_id: TARGET.household_id, source_url: 'https://Example.com/pasta/', deleted_at: null };
  const c = commitClient({ data: [row], error: null });
  assertEquals(await c.store.reuseCandidates(TARGET.household_id, ID, 'https://example.com/pasta'), [
    { id: TARGET.recipe_id, name: 'Pasta', householdId: TARGET.household_id, sourceUrl: 'https://Example.com/pasta/', deletedAt: null },
  ]);
  assertEquals(c.calls, [{
    fn: 'share_import_reuse_candidates',
    args: { p_household_id: TARGET.household_id, p_import_recipe_id: ID, p_url_key: 'example.com/pasta' },
  }]);

  // A photo import has no URL: only its own earlier run.
  const photo = commitClient({ data: null, error: null });
  assertEquals(await photo.store.reuseCandidates(TARGET.household_id, ID, null), []);
  assertEquals((photo.calls[0].args as { p_url_key: unknown }).p_url_key, null);

  const other = { code: '42501', message: 'permission denied' };
  assertEquals(await assertRejects(() => commitClient({ data: null, error: other }).store.reuseCandidates(TARGET.household_id, ID, null)), other);
});

Deno.test('queueRecipePageDeletion passes the prefix; an error is thrown as is', async () => {
  const prefix = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/f0000000-0000-4000-8000-000000000002/';
  const ok = client({ data: null, error: null });
  await ok.store.queueRecipePageDeletion(prefix);
  assertEquals(ok.calls, [{ fn: 'queue_recipe_page_prefix_deletion', args: { p_prefix: prefix } }]);

  const invalid = { code: '22023', message: 'invalid prefix' };
  assertEquals(await assertRejects(() => client({ data: null, error: invalid }).store.queueRecipePageDeletion('x/')), invalid);
});

/** A client whose storage answers each bucket's download and upload, recording the calls. */
function storageClient(download: { data: Blob | null; error: unknown }, upload: { error: unknown } = { error: null }) {
  const calls: unknown[][] = [];
  const admin = {
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          calls.push(['download', bucket, path]);
          return download;
        },
        upload: async (path: string, bytes: Uint8Array, options: unknown) => {
          calls.push(['upload', bucket, path, bytes, options]);
          return upload;
        },
      }),
    },
  } as unknown as SupabaseClient;
  return { pages: createSharePageStorage(admin), calls };
}

Deno.test('the page storage reads share-images and writes recipe-pages with replace', async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 7]);
  const read = storageClient({ data: new Blob([bytes]), error: null });
  assertEquals(await read.pages.downloadShareImage('u/op/1.jpg'), bytes);
  assertEquals(read.calls, [['download', 'share-images', 'u/op/1.jpg']]);

  await read.pages.uploadRecipePage('h/r/p.jpg', bytes);
  assertEquals(read.calls[1], ['upload', 'recipe-pages', 'h/r/p.jpg', bytes, { contentType: 'image/jpeg', upsert: true }]);
});

Deno.test('a share image that is gone reads as null; any other storage error throws', async () => {
  const missing = storageClient({ data: null, error: { status: 400, statusCode: '404', message: 'Object not found' } });
  assertEquals(await missing.pages.downloadShareImage('u/op/1.jpg'), null);

  const down = storageClient({ data: null, error: { status: 503, statusCode: '503', message: 'Service Unavailable' } });
  await assertRejects(() => down.pages.downloadShareImage('u/op/1.jpg'), Error, 'share-images download failed: Service Unavailable');

  const refused = storageClient({ data: null, error: null }, { error: { message: 'mime type not supported' } });
  await assertRejects(() => refused.pages.uploadRecipePage('h/r/p.jpg', new Uint8Array([1])), Error, 'recipe-pages upload failed: mime type not supported');
});

Deno.test('isObjectMissing: a 404 by status, statusCode or message, and nothing else', () => {
  assertEquals(isObjectMissing({ status: 404 }), true);
  assertEquals(isObjectMissing({ status: 400, statusCode: '404' }), true);
  assertEquals(isObjectMissing({ message: 'Object not found' }), true);
  assertEquals(isObjectMissing({ status: 400, statusCode: '400', message: 'Bad request' }), false);
  assertEquals(isObjectMissing({ status: 500 }), false);
  assertEquals(isObjectMissing(null), false);
});
