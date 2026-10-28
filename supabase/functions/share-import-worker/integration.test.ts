// One share end to end against local Supabase (plan §9): share-ingest accepts the envelope, the
// worker extracts it (mock models) and commits it through commit_share_import, and the receipt,
// the recipe and the list items are in the database. Everything but the models is real: the
// stores, the RPCs, the triggers.
//
// Skipped unless SHARE_IMPORT_INTEGRATION=1. Run with local Supabase started and migrated:
//   SHARE_IMPORT_INTEGRATION=1 SUPABASE_SERVICE_ROLE_KEY=<SECRET_KEY from `supabase status`> \
//     deno test -A integration.test.ts
// (SUPABASE_URL defaults to http://127.0.0.1:55321.) It makes its own user and household and
// deletes them afterwards. It claims whatever share import is due, so run it on a quiet database.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { assert, assertEquals } from '@std/assert';

import { categorize } from '../categorize-ingredients/handler.ts';
import { createCategorizeStore } from '../categorize-ingredients/store.ts';
import { createRecipeImportStore } from '../import-recipe/store.ts';
import { createShareIngestStore } from '../share-ingest/handler.ts';
import { handleRequest, type ShareImageStorage } from '../share-ingest/request.ts';
import { uuidV5 } from './commit.ts';
import { runWorker } from './handler.ts';
import {
  createSharePageStorage,
  createShareImportCommitStore,
  createShareImportWorkerStore,
  RECIPE_PAGES_BUCKET,
  SHARE_IMAGES_BUCKET,
} from './store.ts';

const enabled = Deno.env.get('SHARE_IMPORT_INTEGRATION') === '1';
const NAMESPACE = '6f3b2a91-4c7e-4d1a-9b8e-2a5c7d0e4f13';

/** This test shares a link, so share-ingest never touches share-images. */
const noImages: ShareImageStorage = {
  upload: () => Promise.reject(new Error('a link share uploads no images')),
  remove: () => Promise.reject(new Error('a link share removes no images')),
};

const PAGE = {
  title: 'Garlic Pasta | Example',
  jsonLd: [
    JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Recipe',
      name: 'Garlic Pasta',
      recipeYield: '4 servings',
      recipeIngredient: ['2 cloves garlic, minced', '1 lb spaghetti'],
    }),
  ],
  text: 'Our favourite weeknight dinner.',
};

/** One worker run over the real stores, extracting then committing, with the mock models. */
function runOnce(admin: SupabaseClient) {
  return runWorker({
    store: createShareImportWorkerStore(admin),
    commitStore: createShareImportCommitStore(admin),
    pages: createSharePageStorage(admin),
    importDeps: (job) => {
      const categorizeStore = createCategorizeStore(admin, { userId: job.user_id });
      return {
        store: createRecipeImportStore(admin, { userId: job.user_id }),
        categorize: (names, caller) => categorize(names, categorizeStore, undefined, caller),
        fetchPage: () => Promise.reject(new Error('The captured page is used')),
        caller: { userId: job.user_id, householdId: null },
      };
    },
  });
}

function uuidv7(): string {
  const ms = Date.now().toString(16).padStart(12, '0');
  const hex = [...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const variant = ((parseInt(hex[3], 16) & 0x3) | 0x8).toString(16);
  return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7${hex.slice(0, 3)}-${variant}${hex.slice(4, 7)}-${hex.slice(7, 19)}`;
}

Deno.test({
  name: 'one share end to end against local Supabase: ingest, extract, commit, receipt',
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    assert(key, 'SUPABASE_SERVICE_ROLE_KEY must be set');
    const admin = createClient(Deno.env.get('SUPABASE_URL') ?? 'http://127.0.0.1:55321', key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const saved = Object.fromEntries(['AI_MODEL_RECIPE', 'AI_MODEL_CATEGORIZE'].map((k) => [k, Deno.env.get(k)]));
    Deno.env.set('AI_MODEL_RECIPE', 'mock');
    Deno.env.set('AI_MODEL_CATEGORIZE', 'mock');

    const { data: created, error: userError } = await admin.auth.admin.createUser({
      email: `share-it-${crypto.randomUUID()}@test.local`,
      email_confirm: true,
    });
    if (userError) throw userError;
    const userId = created.user.id;
    const householdId = crypto.randomUUID();
    const listId = crypto.randomUUID();
    const opId = uuidv7();

    try {
      const check = (r: { error: unknown }) => {
        if (r.error) throw r.error;
      };
      check(await admin.from('households').insert({ id: householdId, name: 'Share IT' }));
      check(await admin.from('household_members').insert({ household_id: householdId, user_id: userId, role: 'owner', position: 1 }));
      check(await admin.from('household_plans').upsert({ household_id: householdId, plan_id: 'unlimited' }));
      check(await admin.from('lists').insert({ id: listId, household_id: householdId, name: 'Groceries', position: 1 }));

      // The extension's upload (here with a session; the user always comes from authentication).
      const envelope = {
        v: 2,
        id: opId,
        userId,
        url: 'https://www.example.com/garlic-pasta/?utm_source=pin',
        listId,
        householdId,
        addToList: true,
        page: PAGE,
        createdAt: new Date().toISOString(),
        appVersion: '1.0.0',
        source: 'share',
      };
      const ingest = await handleRequest(
        new Request('http://localhost/functions/v1/share-ingest', {
          method: 'POST',
          headers: { authorization: 'Bearer a.session.jwt', 'idempotency-key': opId, 'content-type': 'application/json' },
          body: JSON.stringify(envelope),
        }),
        { authenticate: async () => ({ userId, credentialId: null }), store: createShareIngestStore(admin), images: noImages, env: () => undefined },
      );
      assertEquals(ingest.status, 202);
      assertEquals(await ingest.json(), { id: opId, status: 'received' });

      // One worker run: extracting, then committing.
      const run = await runOnce(admin);
      assert(run.extracted >= 1 && run.committed >= 1, `the run extracted and committed: ${JSON.stringify(run)}`);

      const recipeId = await uuidV5(opId, NAMESPACE);
      const { data: job } = await admin
        .from('share_imports')
        .select('status, page, lease_token, recipe_id, applied_list_id, list_gone, items_added, items_combined, committed_at, metered_at')
        .eq('id', opId)
        .single();
      assertEquals(
        { ...job, committed_at: typeof job?.committed_at, metered_at: typeof job?.metered_at },
        {
          status: 'done',
          page: null,
          lease_token: null,
          recipe_id: recipeId,
          applied_list_id: listId,
          list_gone: false,
          items_added: 2,
          items_combined: 0,
          committed_at: 'string',
          metered_at: 'string',
        },
      );

      const { data: recipe } = await admin.from('recipes').select('name, household_id, added_by, source_url, field_clock').eq('id', recipeId).single();
      assertEquals(recipe?.name, 'Garlic Pasta');
      assertEquals(recipe?.household_id, householdId);
      assertEquals(recipe?.added_by, userId);
      assertEquals(recipe?.source_url, 'https://example.com/garlic-pasta');
      assert(/^\d{13}-[0-9a-f]{4}-srv$/.test(recipe?.field_clock.name), 'written with the server\'s HLC');

      const { data: items } = await admin
        .from('list_items')
        .select('id, ingredient_name, added_by, checked_at, list_item_contributions(quantity, unit, source, recipe_id, added_by)')
        .eq('list_id', listId)
        .is('deleted_at', null)
        .order('ingredient_name');
      assertEquals(items, [
        {
          id: await uuidV5(`${opId}:item:0`, NAMESPACE),
          ingredient_name: 'garlic',
          added_by: userId,
          checked_at: null,
          list_item_contributions: [{ quantity: 2, unit: 'clove', source: 'recipe', recipe_id: recipeId, added_by: userId }],
        },
        {
          id: await uuidV5(`${opId}:item:1`, NAMESPACE),
          ingredient_name: 'spaghetti',
          added_by: userId,
          checked_at: null,
          list_item_contributions: [{ quantity: 1, unit: 'lb', source: 'recipe', recipe_id: recipeId, added_by: userId }],
        },
      ]);

      // A retry after the commit (a lost answer) gets the receipt and adds nothing.
      const { data: receipt, error: retryError } = await admin.rpc('commit_share_import', {
        p_id: opId,
        p_lease: crypto.randomUUID(),
        p_target: {},
        p_writes: [],
        p_preconditions: [],
      });
      if (retryError) throw retryError;
      assertEquals(receipt.recipe_id, recipeId);
      assertEquals(receipt.items_added, 2);
      const { count } = await admin.from('list_item_contributions').select('id', { count: 'exact', head: true }).eq('household_id', householdId);
      assertEquals(count, 2);

      // A second share of the same page into the same list Combines, reusing the recipe.
      const secondId = uuidv7();
      const second = await handleRequest(
        new Request('http://localhost/functions/v1/share-ingest', {
          method: 'POST',
          headers: { authorization: 'Bearer a.session.jwt', 'idempotency-key': secondId, 'content-type': 'application/json' },
          body: JSON.stringify({ ...envelope, id: secondId }),
        }),
        { authenticate: async () => ({ userId, credentialId: null }), store: createShareIngestStore(admin), images: noImages, env: () => undefined },
      );
      assertEquals(second.status, 202);
      await runOnce(admin);
      const { data: again } = await admin.from('share_imports').select('status, recipe_id, items_added, items_combined').eq('id', secondId).single();
      assertEquals(again, { status: 'done', recipe_id: recipeId, items_added: 2, items_combined: 2 });
      const { count: openItems } = await admin
        .from('list_items')
        .select('id', { count: 'exact', head: true })
        .eq('list_id', listId)
        .is('deleted_at', null);
      assertEquals(openItems, 2);
    } finally {
      await admin.from('households').delete().eq('id', householdId);
      await admin.auth.admin.deleteUser(userId);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
    }
  },
});

/** A JPEG-looking page of `size` bytes; over MOCK_PHOTO_MIN_BYTES the photo mock reads a recipe. */
function jpeg(size: number, fill: number): Uint8Array {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

Deno.test({
  name: 'one photo share end to end against local Supabase: ingest, extract, copy the pages, commit',
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    assert(key, 'SUPABASE_SERVICE_ROLE_KEY must be set');
    const admin = createClient(Deno.env.get('SUPABASE_URL') ?? 'http://127.0.0.1:55321', key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const envKeys = ['AI_MODEL_RECIPE', 'AI_MODEL_CATEGORIZE', 'AI_MODEL_RECIPE_PHOTO'];
    const saved = Object.fromEntries(envKeys.map((k) => [k, Deno.env.get(k)]));
    Deno.env.set('AI_MODEL_RECIPE', 'mock');
    Deno.env.set('AI_MODEL_CATEGORIZE', 'mock');
    Deno.env.set('AI_MODEL_RECIPE_PHOTO', 'mock');

    const { data: created, error: userError } = await admin.auth.admin.createUser({
      email: `share-photo-it-${crypto.randomUUID()}@test.local`,
      email_confirm: true,
    });
    if (userError) throw userError;
    const userId = created.user.id;
    const householdId = crypto.randomUUID();
    const listId = crypto.randomUUID();
    const opId = uuidv7();
    const recipeId = await uuidV5(opId, NAMESPACE);
    const shareImages = [`${userId}/${opId}/1.jpg`, `${userId}/${opId}/2.jpg`];
    const pages = [
      `${householdId}/${recipeId}/${await uuidV5(`${opId}:page:1`, NAMESPACE)}.jpg`,
      `${householdId}/${recipeId}/${await uuidV5(`${opId}:page:2`, NAMESPACE)}.jpg`,
    ];
    const bytes = [jpeg(2048, 0x11), jpeg(3072, 0x22)];
    const claimed: number[] = [];

    const bucket = admin.storage.from(SHARE_IMAGES_BUCKET);
    const images: ShareImageStorage = {
      async upload(path, data) {
        const { error } = await bucket.upload(path, data, { contentType: 'image/jpeg', upsert: true });
        if (error) throw error;
      },
      async remove(paths) {
        const { error } = await bucket.remove(paths);
        if (error) throw error;
      },
    };

    try {
      const check = (r: { error: unknown }) => {
        if (r.error) throw r.error;
      };
      check(await admin.from('households').insert({ id: householdId, name: 'Share photo IT' }));
      check(await admin.from('household_members').insert({ household_id: householdId, user_id: userId, role: 'owner', position: 1 }));
      check(await admin.from('household_plans').upsert({ household_id: householdId, plan_id: 'unlimited' }));
      check(await admin.from('lists').insert({ id: listId, household_id: householdId, name: 'Groceries', position: 1 }));

      const envelope = {
        v: 3,
        id: opId,
        userId,
        images: bytes.map((b) => ({ mediaType: 'image/jpeg', data: base64(b) })),
        listId,
        householdId,
        addToList: true,
        createdAt: new Date().toISOString(),
        appVersion: '1.0.0',
        source: 'share',
      };
      const ingest = await handleRequest(
        new Request('http://localhost/functions/v1/share-ingest', {
          method: 'POST',
          headers: { authorization: 'Bearer a.session.jwt', 'idempotency-key': opId, 'content-type': 'application/json' },
          body: JSON.stringify(envelope),
        }),
        { authenticate: async () => ({ userId, credentialId: null }), store: createShareIngestStore(admin), images, env: () => undefined },
      );
      assertEquals(ingest.status, 202);
      const { data: received } = await admin.from('share_imports').select('status, kind, images').eq('id', opId).single();
      assertEquals(received, { status: 'received', kind: 'photo', images: shareImages });

      const run = await runOnce(admin);
      assert(run.extracted >= 1 && run.committed >= 1, `the run extracted and committed: ${JSON.stringify(run)}`);

      const { data: job } = await admin
        .from('share_imports')
        .select('status, kind, url, images, recipe_id, applied_list_id, items_added, error_code, metered_at')
        .eq('id', opId)
        .single();
      assertEquals(
        { ...job, metered_at: typeof job?.metered_at },
        {
          status: 'done',
          kind: 'photo',
          url: null,
          images: null,
          recipe_id: recipeId,
          applied_list_id: listId,
          items_added: 3,
          error_code: null,
          metered_at: 'string',
        },
      );

      const { data: recipe } = await admin
        .from('recipes')
        .select('name, household_id, added_by, source_url, image_url, source_pages')
        .eq('id', recipeId)
        .single();
      assertEquals(recipe, {
        name: 'Mock photo recipe',
        household_id: householdId,
        added_by: userId,
        source_url: null,
        image_url: null,
        source_pages: pages,
      });

      // The pages, byte for byte, in recipe-pages.
      for (const [i, path] of pages.entries()) {
        const { data, error } = await admin.storage.from(RECIPE_PAGES_BUCKET).download(path);
        if (error) throw error;
        assertEquals(new Uint8Array(await data.arrayBuffer()), bytes[i]);
      }

      // Done, so the share's images are queued for deletion: claiming the queue now lists them.
      const { data: due, error: claimError } = await admin.rpc('claim_share_image_deletions', { p_limit: 1000, p_min_age: '0 seconds' });
      if (claimError) throw claimError;
      const ours = (due as { queue_id: number; name: string }[]).filter((d) => d.name.startsWith(`${userId}/${opId}/`));
      claimed.push(...new Set(ours.map((d) => d.queue_id)));
      assertEquals(ours.map((d) => d.name).sort(), shareImages);

      // A page that's gone reads as missing, not as an error.
      assertEquals(await createSharePageStorage(admin).downloadShareImage(`${userId}/${opId}/9.jpg`), null);
    } finally {
      await admin.storage.from(SHARE_IMAGES_BUCKET).remove(shareImages);
      await admin.storage.from(RECIPE_PAGES_BUCKET).remove(pages);
      if (claimed.length > 0) await admin.rpc('complete_share_image_deletions', { p_ids: claimed });
      await admin.from('households').delete().eq('id', householdId);
      await admin.auth.admin.deleteUser(userId);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
    }
  },
});
