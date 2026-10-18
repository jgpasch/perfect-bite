import { assertEquals, assertRejects } from '@std/assert';

import {
  bucketStores,
  CLEANUP_BUCKETS,
  cleanUpBuckets,
  cleanUpPhotos,
  handleRequest,
  REMOVE_BATCH,
  type CleanupClient,
  type CleanupStore,
} from './handler.ts';

const H = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const photo = (n: number) => `${H}/a3000000-0000-7000-8000-000000000001/c0000000-0000-7000-8000-${String(n).padStart(12, '0')}.jpg`;

function fakeStore(rows: { queue_id: number; name: string }[], failRemove = false) {
  const calls = { claim: [] as number[], remove: [] as string[][], complete: [] as number[][] };
  const store: CleanupStore = {
    claim: async (limit) => {
      calls.claim.push(limit);
      return rows;
    },
    remove: async (names) => {
      calls.remove.push(names);
      if (failRemove) throw new Error('storage down');
    },
    complete: async (ids) => {
      calls.complete.push(ids);
    },
  };
  return { store, calls };
}

Deno.test('removes the claimed objects, then completes their entries', async () => {
  const { store, calls } = fakeStore([
    { queue_id: 1, name: photo(1) },
    { queue_id: 2, name: photo(2) },
    { queue_id: 2, name: photo(3) },
  ]);
  assertEquals(await cleanUpPhotos(store), { removed: 3, completed: 2 });
  assertEquals(calls.claim, [100]);
  assertEquals(calls.remove, [[photo(1), photo(2), photo(3)]]);
  assertEquals(calls.complete, [[1, 2]]);
});

Deno.test('nothing due: no remove and no complete', async () => {
  const { store, calls } = fakeStore([]);
  assertEquals(await cleanUpPhotos(store), { removed: 0, completed: 0 });
  assertEquals(calls.remove, []);
  assertEquals(calls.complete, []);
});

Deno.test('an object named twice (its own entry and its household prefix) is removed once', async () => {
  const { store, calls } = fakeStore([
    { queue_id: 1, name: photo(1) },
    { queue_id: 2, name: photo(1) },
  ]);
  assertEquals(await cleanUpPhotos(store), { removed: 1, completed: 2 });
  assertEquals(calls.remove, [[photo(1)]]);
});

Deno.test('removes in batches of 1,000', async () => {
  const rows = Array.from({ length: REMOVE_BATCH + 1 }, (_, i) => ({ queue_id: 7, name: photo(i) }));
  const { store, calls } = fakeStore(rows);
  assertEquals(await cleanUpPhotos(store), { removed: 1001, completed: 1 });
  assertEquals(calls.remove.map((b) => b.length), [1000, 1]);
});

Deno.test('a failed remove completes nothing, so the entries stay queued', async () => {
  const { store, calls } = fakeStore([{ queue_id: 1, name: photo(1) }], true);
  await assertRejects(() => cleanUpPhotos(store), Error, 'storage down');
  assertEquals(calls.complete, []);
});

Deno.test('POST → 200 with the counts', async () => {
  const res = await handleRequest(new Request('http://localhost/', { method: 'POST' }), async () => ({ removed: 2, completed: 1 }));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { removed: 2, completed: 1 });
});

Deno.test('only POST', async () => {
  const res = await handleRequest(new Request('http://localhost/', { method: 'GET' }), async () => ({ removed: 0, completed: 0 }));
  assertEquals(res.status, 405);
});

Deno.test('a failure → 500', async () => {
  const res = await handleRequest(new Request('http://localhost/', { method: 'POST' }), () => Promise.reject(new Error('x')));
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error, 'internal');
});

Deno.test('sweeps every bucket and adds up the counts', async () => {
  const recipes = fakeStore([{ queue_id: 1, name: photo(1) }]);
  const items = fakeStore([
    { queue_id: 4, name: photo(2) },
    { queue_id: 5, name: photo(3) },
  ]);
  assertEquals(await cleanUpBuckets([recipes.store, items.store]), { removed: 3, completed: 3 });
  assertEquals(recipes.calls.claim, [100]);
  assertEquals(items.calls.claim, [100]);
  assertEquals(recipes.calls.remove, [[photo(1)]]);
  assertEquals(items.calls.remove, [[photo(2), photo(3)]]);
  assertEquals(recipes.calls.complete, [[1]]);
  assertEquals(items.calls.complete, [[4, 5]]);
});

Deno.test('the same queue id in two buckets completes in each (they are separate queues)', async () => {
  const recipes = fakeStore([{ queue_id: 1, name: photo(1) }]);
  const items = fakeStore([{ queue_id: 1, name: photo(1) }]);
  assertEquals(await cleanUpBuckets([recipes.store, items.store]), { removed: 2, completed: 2 });
  assertEquals(recipes.calls.complete, [[1]]);
  assertEquals(items.calls.complete, [[1]]);
});

Deno.test('a failing bucket still lets the next one run, then throws', async () => {
  const recipes = fakeStore([{ queue_id: 1, name: photo(1) }], true);
  const items = fakeStore([{ queue_id: 2, name: photo(2) }]);
  await assertRejects(() => cleanUpBuckets([recipes.store, items.store]), Error, 'storage down');
  assertEquals(recipes.calls.complete, []);
  assertEquals(items.calls.complete, [[2]]);
});

Deno.test('no buckets: nothing to do', async () => {
  assertEquals(await cleanUpBuckets([]), { removed: 0, completed: 0 });
});

/** A service-role client whose queues hold `queued` (per claim RPC) and that records removes. */
function fakeClient(queued: Record<string, { queue_id: number; name: string }[]>, failClaim?: string) {
  const calls = { rpc: [] as [string, Record<string, unknown>][], remove: [] as [string, string[]][] };
  const client: CleanupClient = {
    rpc: async (fn, args) => {
      calls.rpc.push([fn, args]);
      if (fn === failClaim) return { data: null, error: new Error('db down') };
      return { data: fn.startsWith('claim_') ? (queued[fn] ?? []) : null, error: null };
    },
    storage: {
      from: (bucket) => ({
        remove: async (names) => {
          calls.remove.push([bucket, names]);
          return { error: null };
        },
      }),
    },
  };
  return { client, calls };
}

const page = (n: number) => `${H}/a3000000-0000-7000-8000-000000000001/e0000000-0000-7000-8000-${String(n).padStart(12, '0')}.jpg`;

Deno.test('the buckets swept: recipe-photos, item-photos, then recipe-pages', () => {
  assertEquals(
    CLEANUP_BUCKETS.map((b) => [b.bucket, b.claim, b.complete]),
    [
      ['recipe-photos', 'claim_recipe_photo_deletions', 'complete_recipe_photo_deletions'],
      ['item-photos', 'claim_item_photo_deletions', 'complete_item_photo_deletions'],
      ['recipe-pages', 'claim_recipe_page_deletions', 'complete_recipe_page_deletions'],
    ],
  );
});

Deno.test('removes queued recipe-pages objects from recipe-pages, then completes their entries', async () => {
  const { client, calls } = fakeClient({
    claim_recipe_page_deletions: [
      { queue_id: 3, name: page(1) },
      { queue_id: 4, name: page(2) },
      { queue_id: 4, name: page(3) },
    ],
  });
  assertEquals(await cleanUpBuckets(bucketStores(client)), { removed: 3, completed: 2 });
  assertEquals(calls.remove, [['recipe-pages', [page(1), page(2), page(3)]]]);
  assertEquals(calls.rpc, [
    ['claim_recipe_photo_deletions', { p_limit: 100 }],
    ['claim_item_photo_deletions', { p_limit: 100 }],
    ['claim_recipe_page_deletions', { p_limit: 100 }],
    ['complete_recipe_page_deletions', { p_ids: [3, 4] }],
  ]);
});

Deno.test("each bucket removes only its own queue's objects", async () => {
  const { client, calls } = fakeClient({
    claim_recipe_photo_deletions: [{ queue_id: 1, name: photo(1) }],
    claim_recipe_page_deletions: [{ queue_id: 1, name: page(1) }],
  });
  assertEquals(await cleanUpBuckets(bucketStores(client)), { removed: 2, completed: 2 });
  assertEquals(calls.remove, [
    ['recipe-photos', [photo(1)]],
    ['recipe-pages', [page(1)]],
  ]);
});

Deno.test('a failed recipe-pages claim throws and completes nothing there', async () => {
  const { client, calls } = fakeClient(
    { claim_recipe_photo_deletions: [{ queue_id: 1, name: photo(1) }] },
    'claim_recipe_page_deletions',
  );
  await assertRejects(() => cleanUpBuckets(bucketStores(client)), Error, 'db down');
  assertEquals(
    calls.rpc.filter(([fn]) => fn.startsWith('complete_')).map(([fn]) => fn),
    ['complete_recipe_photo_deletions'],
  );
});
