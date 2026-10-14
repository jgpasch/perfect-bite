import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { and, eq, isNull } from 'drizzle-orm';

import { db, failedImports, households, lists, outbox, recipes } from '@/db';
import { listItemsQuery } from '@/features/lists/items';
import { createList, deleteList, ensureStarterData, getDefaultListId, getList } from '@/features/lists/lists';
import { SHARE_PENDING_DIR } from '@/features/siri/app-group';
import { normalizeIngredientName, SYSTEM_CATEGORIES } from '@/shared';
import type { RecipeImportResponse } from '@/shared/schemas/recipe-import';
import { resetDb } from '@/test/db';
import { seedCatalog } from '@/test/seed';
import { setAppGroupRoot } from '@/test/fake-file-system';
import { makeSession, resetSupabase, supabase } from '@/test/fake-supabase';

import {
  dismissFailedImport,
  failedImportName,
  failedImportReason,
  failedImportsQuery,
  recordFailedImport,
  retryFailedImport,
} from '../failed-imports';
import { drainShareQueue } from '../share-drain';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('expo-file-system', () => require('@/test/fake-file-system'));
jest.mock('expo-network', () => ({ addNetworkStateListener: () => ({ remove: () => {} }) }));

const USER = 'user-1';
const invoke = supabase.functions.invoke;
const TIKKA_URL = 'https://www.example.com/tikka';

const TIKKA: RecipeImportResponse = {
  name: 'Chicken tikka masala',
  sourceUrl: TIKKA_URL,
  servings: null,
  ingredients: ['garlic', 'onion'].map((displayName) => ({
    ingredientName: normalizeIngredientName(displayName),
    displayName,
    quantity: null,
    unit: null,
    note: '',
    categoryId: SYSTEM_CATEGORIES.find((c) => c.slug === 'produce')!.id,
    status: 'categorized' as const,
  })),
  tags: null,
  totalMinutes: null,
  steps: [],
  imageUrl: null,
};

const httpError = (status: number, error: string) => ({
  data: null,
  error: {
    name: 'FunctionsHttpError',
    message: 'Edge Function returned a non-2xx status code',
    context: { status, json: () => Promise.resolve({ error }) },
  },
});

let groceries: string;
let costco: string;

beforeEach(() => {
  resetDb();
  resetSupabase();
  seedCatalog();
  ensureStarterData(USER);
  groceries = getDefaultListId(USER)!;
  costco = createList('Costco');
  supabase.auth.getSession.mockResolvedValue({ data: { session: makeSession(USER) }, error: null });
  invoke.mockResolvedValue({ data: TIKKA, error: null });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

const rows = () => failedImportsQuery().all();
const liveRecipes = () => db.select({ name: recipes.name }).from(recipes).where(isNull(recipes.deletedAt)).all();
const itemNames = (listId: string) =>
  listItemsQuery(listId)
    .all()
    .map((i) => i.displayName)
    .sort();

describe('the failed_imports table', () => {
  test('recordFailedImport stores the url, title, reason and when', () => {
    const before = Date.now();
    const id = recordFailedImport({ url: TIKKA_URL, title: 'Tikka | Example', reason: 'rate_limited' });
    const [row] = rows();
    expect(row).toMatchObject({ id, url: TIKKA_URL, title: 'Tikka | Example', reason: 'rate_limited' });
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test('a share with no title is stored with a null title', () => {
    recordFailedImport({ url: TIKKA_URL, title: null, reason: 'not_a_recipe' });
    expect(rows()[0].title).toBeNull();
  });

  test('the query lists the newest first', () => {
    const a = recordFailedImport({ url: 'https://a.example/1', title: null, reason: 'failed' });
    const b = recordFailedImport({ url: 'https://b.example/2', title: null, reason: 'failed' });
    const c = recordFailedImport({ url: 'https://c.example/3', title: null, reason: 'failed' });
    expect(rows().map((r) => r.id)).toEqual([c, b, a]);
  });

  test('dismiss removes only that import; an unknown id is a no-op', () => {
    const a = recordFailedImport({ url: 'https://a.example/1', title: null, reason: 'failed' });
    const b = recordFailedImport({ url: 'https://b.example/2', title: null, reason: 'failed' });
    dismissFailedImport(a);
    expect(rows().map((r) => r.id)).toEqual([b]);
    dismissFailedImport('nope');
    expect(rows().map((r) => r.id)).toEqual([b]);
  });

  test('it writes nothing to the outbox: failed imports never sync', () => {
    const outboxSize = () => db.select().from(outbox).all().length;
    const before = outboxSize();
    recordFailedImport({ url: TIKKA_URL, title: null, reason: 'failed' });
    expect(outboxSize()).toBe(before);
  });

  test('the share drain records a not-a-recipe share in the table by default', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failed-imports-'));
    try {
      fs.mkdirSync(path.join(root, SHARE_PENDING_DIR), { recursive: true });
      setAppGroupRoot(root);
      const envelope = {
        id: '019a4c2e-7d3b-7a10-8f2e-3b9d1c0e5a71',
        url: TIKKA_URL,
        listId: costco,
        createdAt: '2026-10-08T17:42:05.123-05:00',
        appVersion: '1.0.0',
        source: 'share',
        page: { title: '  Tikka | Example ' },
      };
      fs.writeFileSync(path.join(root, SHARE_PENDING_DIR, `${envelope.id}.json`), JSON.stringify(envelope));
      invoke.mockResolvedValue(httpError(422, 'not_a_recipe'));

      const result = await drainShareQueue(USER);

      expect(result.failed).toBe(1);
      expect(rows().map((r) => [r.url, r.title, r.reason])).toEqual([[TIKKA_URL, 'Tikka | Example', 'not_a_recipe']]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('retryFailedImport', () => {
  test('success imports into the default list and removes the failed import', async () => {
    const id = recordFailedImport({ url: TIKKA_URL, title: 'Tikka', reason: 'rate_limited' });

    const result = await retryFailedImport(id, USER);

    expect(result).toMatchObject({ ok: true, recipeName: 'Chicken tikka masala', listId: groceries, added: 2 });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('import-recipe', { body: { url: TIKKA_URL } });
    expect(rows()).toEqual([]);
    expect(liveRecipes()).toEqual([{ name: 'Chicken tikka masala' }]);
    expect(itemNames(groceries)).toEqual(['garlic', 'onion']);
    expect(itemNames(costco)).toEqual([]);
  });

  test('another failure keeps it, with the new reason', async () => {
    const id = recordFailedImport({ url: TIKKA_URL, title: 'Tikka', reason: 'not_a_recipe' });
    invoke.mockResolvedValue(httpError(429, 'rate_limited'));

    const result = await retryFailedImport(id, USER);

    expect(result).toEqual({ ok: false, error: 'rate_limited' });
    expect(rows().map((r) => [r.id, r.title, r.reason])).toEqual([[id, 'Tikka', 'rate_limited']]);
    expect(liveRecipes()).toEqual([]);
  });

  test('not in the plan keeps it, and the card says so', async () => {
    const id = recordFailedImport({ url: TIKKA_URL, title: 'Tikka', reason: 'rate_limited' });
    invoke.mockResolvedValue(httpError(403, 'not_entitled'));

    expect(await retryFailedImport(id, USER)).toEqual({ ok: false, error: 'not_entitled' });
    const [row] = rows();
    expect([row.id, row.reason]).toEqual([id, 'not_entitled']);
    expect(failedImportReason(row.reason)).toBe("Recipe import isn't included in your plan.");
    expect(liveRecipes()).toEqual([]);
  });

  test('signed out (no session) keeps it as offline and calls nothing', async () => {
    const id = recordFailedImport({ url: TIKKA_URL, title: null, reason: 'failed' });
    supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });

    expect(await retryFailedImport(id, USER)).toEqual({ ok: false, error: 'offline' });
    expect(invoke).not.toHaveBeenCalled();
    expect(rows().map((r) => r.reason)).toEqual(['offline']);
  });

  test('with no list to import into, nothing is tried and it stays as it was', async () => {
    const id = recordFailedImport({ url: TIKKA_URL, title: null, reason: 'rate_limited' });
    for (const list of db.select({ id: lists.id }).from(lists).all()) deleteList(list.id);

    expect(await retryFailedImport(id, USER)).toEqual({ ok: false, error: 'failed' });
    expect(invoke).not.toHaveBeenCalled();
    expect(rows().map((r) => r.reason)).toEqual(['rate_limited']);
  });

  test('a dismissed or unknown import gives null and calls nothing', async () => {
    const id = recordFailedImport({ url: TIKKA_URL, title: null, reason: 'failed' });
    dismissFailedImport(id);
    expect(await retryFailedImport(id, USER)).toBeNull();
    expect(await retryFailedImport('nope', USER)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  test('two taps at once import once', async () => {
    const id = recordFailedImport({ url: TIKKA_URL, title: null, reason: 'failed' });

    const [first, second] = await Promise.all([retryFailedImport(id, USER), retryFailedImport(id, USER)]);

    expect(first).toMatchObject({ ok: true });
    expect(second).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(liveRecipes()).toEqual([{ name: 'Chicken tikka masala' }]);
    expect(rows()).toEqual([]);
  });

  describe('where it goes', () => {
    const CABIN = '019a4c0f-0000-7000-8000-0000000000b1';
    let personal: string;
    const recipesIn = (householdId: string) =>
      db
        .select({ name: recipes.name })
        .from(recipes)
        .where(and(eq(recipes.householdId, householdId), isNull(recipes.deletedAt)))
        .all();

    beforeEach(() => {
      personal = getList(groceries)!.householdId;
      db.insert(households).values({ id: CABIN, name: 'Lake cabin' }).run();
    });

    test('stores the household and list it was going to', () => {
      recordFailedImport({ url: TIKKA_URL, title: null, reason: 'failed', householdId: CABIN, listId: null });
      recordFailedImport({ url: TIKKA_URL, title: null, reason: 'failed', householdId: personal, listId: costco });
      recordFailedImport({ url: TIKKA_URL, title: null, reason: 'failed' });
      expect(rows().map((r) => [r.householdId, r.listId])).toEqual([
        [null, null],
        [personal, costco],
        [CABIN, null],
      ]);
    });

    test('a recipe-only failure stays recipe-only: saved to its household, nothing on a list', async () => {
      const id = recordFailedImport({ url: TIKKA_URL, title: null, reason: 'rate_limited', householdId: CABIN, listId: null });
      const result = await retryFailedImport(id, USER);
      expect(result).toMatchObject({ ok: true, listId: null, added: 0, created: true });
      expect(recipesIn(CABIN)).toEqual([{ name: 'Chicken tikka masala' }]);
      expect(recipesIn(personal)).toEqual([]);
      expect(itemNames(groceries)).toEqual([]);
      expect(itemNames(costco)).toEqual([]);
      expect(rows()).toEqual([]);
    });

    test('a recipe-only failure whose household is gone goes to the default list’s household', async () => {
      const id = recordFailedImport({ url: TIKKA_URL, title: null, reason: 'rate_limited', householdId: CABIN, listId: null });
      db.delete(households).where(eq(households.id, CABIN)).run();
      expect(await retryFailedImport(id, USER)).toMatchObject({ ok: true, listId: null, added: 0 });
      expect(recipesIn(personal)).toEqual([{ name: 'Chicken tikka masala' }]);
      expect(itemNames(groceries)).toEqual([]);
    });

    test('a list failure goes back onto the same list', async () => {
      const id = recordFailedImport({ url: TIKKA_URL, title: null, reason: 'failed', householdId: personal, listId: costco });
      expect(await retryFailedImport(id, USER)).toMatchObject({ ok: true, listId: costco, added: 2 });
      expect(itemNames(costco)).toEqual(['garlic', 'onion']);
      expect(itemNames(groceries)).toEqual([]);
    });

    test('a list failure whose list is gone goes to the default list', async () => {
      const id = recordFailedImport({ url: TIKKA_URL, title: null, reason: 'failed', householdId: personal, listId: costco });
      deleteList(costco);
      expect(await retryFailedImport(id, USER)).toMatchObject({ ok: true, listId: groceries });
      expect(itemNames(groceries)).toEqual(['garlic', 'onion']);
    });

    test('a recipe-only share that fails in the drain retries recipe-only', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failed-imports-'));
      try {
        fs.mkdirSync(path.join(root, SHARE_PENDING_DIR), { recursive: true });
        setAppGroupRoot(root);
        const envelope = {
          id: '019a4c2e-7d3b-7a10-8f2e-3b9d1c0e5a71',
          url: TIKKA_URL,
          listId: null,
          householdId: CABIN,
          addToList: false,
          createdAt: '2026-10-12T08:30:11.204-05:00',
          appVersion: '1.1.0',
          source: 'share',
        };
        fs.writeFileSync(path.join(root, SHARE_PENDING_DIR, `${envelope.id}.json`), JSON.stringify(envelope));
        invoke.mockResolvedValueOnce(httpError(422, 'not_a_recipe'));
        expect((await drainShareQueue(USER)).failed).toBe(1);
        const [row] = rows();
        expect([row.householdId, row.listId, row.reason]).toEqual([CABIN, null, 'not_a_recipe']);

        expect(await retryFailedImport(row.id, USER)).toMatchObject({ ok: true, listId: null, added: 0 });
        expect(recipesIn(CABIN)).toEqual([{ name: 'Chicken tikka masala' }]);
        expect(itemNames(groceries)).toEqual([]);
        expect(itemNames(costco)).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  test('a retry after a failed one runs again', async () => {
    const id = recordFailedImport({ url: TIKKA_URL, title: null, reason: 'failed' });
    invoke.mockResolvedValueOnce(httpError(429, 'rate_limited'));
    expect(await retryFailedImport(id, USER)).toEqual({ ok: false, error: 'rate_limited' });
    expect(await retryFailedImport(id, USER)).toMatchObject({ ok: true });
    expect(rows()).toEqual([]);
    expect(db.select().from(failedImports).where(eq(failedImports.id, id)).get()).toBeUndefined();
  });
});

describe('copy', () => {
  test('a row shows the title, else the host without www, else the link', () => {
    expect(failedImportName({ url: TIKKA_URL, title: ' Tikka | Example ' })).toBe('Tikka | Example');
    expect(failedImportName({ url: TIKKA_URL, title: null })).toBe('example.com');
    expect(failedImportName({ url: TIKKA_URL, title: '   ' })).toBe('example.com');
    expect(failedImportName({ url: 'https://smittenkitchen.com/2008/09/cake', title: null })).toBe('smittenkitchen.com');
    expect(failedImportName({ url: 'not a link', title: null })).toBe('not a link');
  });

  test('each reason reads in plain words', () => {
    expect(failedImportReason('not_a_recipe')).toBe("That page doesn't look like a recipe");
    expect(failedImportReason('blocked')).toBe('The site blocked the import');
    expect(failedImportReason('rate_limited')).toBe('The import service was busy');
    expect(failedImportReason('offline')).toBe("Couldn't connect");
    expect(failedImportReason('failed')).toBe("Couldn't read that page");
    expect(failedImportReason('not_entitled')).toBe("Recipe import isn't included in your plan.");
  });
});
