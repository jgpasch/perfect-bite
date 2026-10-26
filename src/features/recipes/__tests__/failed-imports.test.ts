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
import { setAppGroupRoot, setDocumentRoot } from '@/test/fake-file-system';
import { makeSession, resetSupabase, storageUploads, supabase } from '@/test/fake-supabase';

import {
  dismissFailedImport,
  failedImportBanner,
  failedImportDestination,
  failedImportEntry,
  failedImportName,
  failedImportPageUris,
  failedImportReason,
  failedImportRetryOn,
  failedImportRowReason,
  failedImportsQuery,
  failedPhotoDetail,
  getFailedImport,
  needsOtherPhotos,
  photosKeptReason,
  pruneFailedPhotoImports,
  retryingPhotoDetail,
  tryAgainOnLabel,
  recordFailedImport,
  recordFailedPhotoImport,
  retryFailedImport,
  updateFailedPhotoImport,
} from '../failed-imports';
import { importRecipeFromPhotos } from '../import';
import { reconcileShares } from '../share-reconcile';

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
  stepIngredients: null,
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

  test('a share is never recorded here: reconciling submits it to the server and writes no row', async () => {
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
      invoke.mockResolvedValue({ data: { id: envelope.id, status: 'received' }, error: null });

      const result = await reconcileShares(USER);

      expect(result.submitted).toEqual([envelope.id]);
      expect(invoke.mock.calls.map(([fn]) => fn)).toEqual(['share-ingest']);
      expect(rows()).toEqual([]);
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
    // The household the recipe is saved to: the default list's.
    expect(invoke).toHaveBeenCalledWith('import-recipe', { body: { url: TIKKA_URL, householdId: getList(groceries)!.householdId } });
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

  test("past the plan's monthly imports, it keeps it, and the card gives the import sheet's wording", async () => {
    const id = recordFailedImport({ url: TIKKA_URL, title: 'Tikka', reason: 'rate_limited' });
    invoke.mockResolvedValue({
      data: null,
      error: {
        name: 'FunctionsHttpError',
        message: 'Edge Function returned a non-2xx status code',
        context: {
          status: 429,
          json: () => Promise.resolve({ error: 'limit_reached', message: 'Used up', resets_at: '2026-11-01T00:00:00.000Z' }),
        },
      },
    });

    expect(await retryFailedImport(id, USER)).toEqual({ ok: false, error: 'limit_reached', resetsAt: '2026-11-01T00:00:00.000Z' });
    const [row] = rows();
    expect([row.id, row.reason]).toEqual([id, 'limit_reached']);
    expect(failedImportReason(row.reason, Date.parse('2026-10-18T12:00:00Z'))).toBe(
      "You've used this month's recipe imports. They reset on Nov 1.",
    );
    expect(liveRecipes()).toEqual([]);
  });

  test("past the user's imports today, it keeps it, and the card says try tomorrow", async () => {
    const id = recordFailedImport({ url: TIKKA_URL, title: 'Tikka', reason: 'rate_limited' });
    invoke.mockResolvedValue({
      data: null,
      error: {
        name: 'FunctionsHttpError',
        message: 'Edge Function returned a non-2xx status code',
        context: {
          status: 429,
          json: () => Promise.resolve({ error: 'daily_limit', message: 'Daily limit', resets_at: '2026-10-22T00:00:00.000Z' }),
        },
      },
    });

    expect(await retryFailedImport(id, USER)).toEqual({ ok: false, error: 'daily_limit' });
    const [row] = rows();
    expect([row.id, row.reason]).toEqual([id, 'daily_limit']);
    expect(failedImportReason(row.reason)).toBe("You've reached today's limit. Try again tomorrow.");
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

    test('a recipe-only failure recorded with its household retries recipe-only', async () => {
      const id = recordFailedImport({ url: TIKKA_URL, title: null, reason: 'not_a_recipe', householdId: CABIN, listId: null });
      const [row] = rows();
      expect([row.id, row.householdId, row.listId, row.reason]).toEqual([id, CABIN, null, 'not_a_recipe']);

      expect(await retryFailedImport(row.id, USER)).toMatchObject({ ok: true, listId: null, added: 0 });
      expect(recipesIn(CABIN)).toEqual([{ name: 'Chicken tikka masala' }]);
      expect(itemNames(groceries)).toEqual([]);
      expect(itemNames(costco)).toEqual([]);
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

  test('a photo row is "From a photo", and its reasons use the photo wording', () => {
    expect(failedImportName({ kind: 'photo', url: null, title: null })).toBe('From a photo');
    expect(failedImportName({ url: null, title: null })).toBe('From a photo');
    expect(failedImportName({ kind: 'link', url: TIKKA_URL, title: null })).toBe('example.com');
    const photo = (reason: Parameters<typeof failedImportReason>[0]) =>
      failedImportReason(reason, Date.parse('2026-10-18T12:00:00Z'), 'photo');
    expect(photo('not_a_recipe')).toBe("That photo doesn't look like a recipe");
    expect(photo('rate_limited')).toBe('Try again in a minute');
    expect(photo('daily_limit')).toBe("You've reached today's limit. Try again tomorrow.");
    expect(photo('limit_reached')).toBe("You've used this month's recipe imports. They reset on Nov 1.");
    expect(photo('offline')).toBe("You're offline");
    expect(photo('failed')).toBe("Couldn't import that recipe. Try again.");
    expect(photo('not_entitled')).toBe("Photo import isn't in your plan");
  });
});

describe("the card's and review sheet's words for a photo row (spec 4.10 boards A–E)", () => {
  // Local time, so "today" and "yesterday" are this phone's days.
  const at = (y: number, m: number, d: number, h = 18, min = 42) => new Date(y, m - 1, d, h, min);
  const row = (over: Partial<{ kind: 'link' | 'photo'; reason: Parameters<typeof failedImportReason>[0]; createdAt: Date }> = {}) => ({
    kind: 'photo' as const,
    reason: 'rate_limited' as const,
    createdAt: at(2026, 10, 24),
    ...over,
  });
  let household: string;

  beforeEach(() => {
    household = getList(groceries)!.householdId;
  });

  test('a photo row over the monthly limit resets on the 1st after it failed, not after now', () => {
    const late = row({ reason: 'limit_reached', createdAt: new Date('2026-10-31T23:30:00Z') });
    expect(failedImportRowReason(late, Date.parse('2026-12-15T00:00:00Z'))).toBe(
      "You've used this month's recipe imports. They reset on Nov 1.",
    );
    // A link row keeps the old rule: the month after now.
    expect(failedImportRowReason({ ...late, kind: 'link' }, Date.parse('2026-12-15T00:00:00Z'))).toBe(
      "You've used this month's recipe imports. They reset on Jan 1.",
    );
    expect(failedImportRowReason(row())).toBe('Try again in a minute');
    expect(failedImportRowReason(row({ kind: 'link' }))).toBe('The import service was busy');
  });

  test('"Your photos are kept." follows the reason as its own sentence', () => {
    expect(photosKeptReason(row())).toBe('Try again in a minute. Your photos are kept.');
    expect(photosKeptReason(row({ reason: 'failed' }))).toBe("Couldn't import that recipe. Try again. Your photos are kept.");
  });

  test('Try again waits for the 1st of the month after a limit_reached failure (UTC), then comes back', () => {
    const limited = row({ reason: 'limit_reached', createdAt: new Date('2026-10-18T12:00:00Z') });
    expect(failedImportRetryOn(limited, Date.parse('2026-10-25T00:00:00Z'))).toBe('2026-11-01T00:00:00.000Z');
    expect(failedImportRetryOn(limited, Date.parse('2026-10-31T23:59:59Z'))).toBe('2026-11-01T00:00:00.000Z');
    expect(failedImportRetryOn(limited, Date.parse('2026-11-01T00:00:00Z'))).toBeNull();
    expect(tryAgainOnLabel('2026-11-01T00:00:00.000Z')).toBe('Try again Nov 1');
    // December's failure waits for January.
    expect(failedImportRetryOn(row({ reason: 'limit_reached', createdAt: new Date('2026-12-31T23:00:00Z') }), Date.parse('2026-12-31T23:30:00Z'))).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    // Other reasons, and link rows, never wait.
    expect(failedImportRetryOn(row({ reason: 'daily_limit' }), Date.parse('2026-10-25T00:00:00Z'))).toBeNull();
    expect(failedImportRetryOn({ ...limited, kind: 'link' }, Date.parse('2026-10-25T00:00:00Z'))).toBeNull();
  });

  test('only a photo that is not a recipe asks for other photos', () => {
    expect(needsOtherPhotos({ kind: 'photo', reason: 'not_a_recipe' })).toBe(true);
    expect(needsOtherPhotos({ kind: 'link', reason: 'not_a_recipe' })).toBe(false);
    expect(needsOtherPhotos({ kind: 'photo', reason: 'rate_limited' })).toBe(false);
    expect(needsOtherPhotos({ kind: 'photo', reason: 'limit_reached' })).toBe(false);
  });

  test('the banner says when on this phone (today, yesterday, a date) and why, as sentences', () => {
    const now = at(2026, 10, 25, 9, 5).getTime();
    expect(failedImportBanner(row({ createdAt: at(2026, 10, 24) }), now)).toMatch(
      /^Couldn't import this yesterday at 6:42\sPM\. Try again in a minute\.$/,
    );
    expect(failedImportBanner(row({ createdAt: at(2026, 10, 25, 0, 10) }), now)).toMatch(
      /^Couldn't import this today at 12:10\sAM\. Try again in a minute\.$/,
    );
    expect(failedImportBanner(row({ createdAt: at(2026, 10, 3), reason: 'not_a_recipe' }), now)).toMatch(
      /^Couldn't import this on Oct 3 at 6:42\sPM\. That photo doesn't look like a recipe\.$/,
    );
    // A reason that is a sentence already gets no second full stop.
    expect(failedImportBanner(row({ createdAt: at(2026, 10, 24), reason: 'daily_limit' }), now)).toMatch(
      /yesterday at 6:42\sPM\. You've reached today's limit\. Try again tomorrow\.$/,
    );
  });

  test("where Try again goes: the row's list, its household when recipe-only, with Try again's fallbacks", () => {
    const householdName = db.select().from(households).where(eq(households.id, household)).get()!.name;
    expect(failedImportDestination({ householdId: household, listId: costco }, USER)).toBe('Costco');
    expect(failedImportDestination({ householdId: household, listId: null }, USER)).toBe(householdName);
    // Gone: the default list, as Try again does.
    expect(failedImportDestination({ householdId: household, listId: 'gone' }, USER)).toBe(getList(groceries)!.name);
    expect(failedImportDestination({ householdId: household, listId: costco }, null)).toBeNull();

    expect(failedPhotoDetail({ householdId: household, listId: costco, pages: ['1.jpg', '2.jpg'] }, USER)).toBe('2 pages · to Costco');
    expect(failedPhotoDetail({ householdId: household, listId: null, pages: ['1.jpg'] }, USER)).toBe(`1 page · to ${householdName}`);
    expect(failedPhotoDetail({ householdId: household, listId: costco, pages: ['1.jpg'] }, null)).toBe('1 page');
    expect(retryingPhotoDetail({ householdId: household, listId: costco }, USER)).toBe('From a photo · to Costco');
    expect(retryingPhotoDetail({ householdId: household, listId: costco }, null)).toBe('From a photo');
  });

  test("the review sheet starts where the row was going, or Try again's fallback", () => {
    expect(failedImportEntry({ householdId: household, listId: costco }, USER)).toEqual({
      from: 'retry',
      householdId: household,
      addToList: true,
      listId: costco,
    });
    expect(failedImportEntry({ householdId: household, listId: null }, USER)).toEqual({
      from: 'retry',
      householdId: household,
      addToList: false,
      listId: null,
    });
    deleteList(costco);
    expect(failedImportEntry({ householdId: household, listId: costco }, USER)).toEqual({
      from: 'retry',
      householdId: household,
      addToList: true,
      listId: groceries,
    });
  });

  test('getFailedImport gives the row, or undefined once it has gone', () => {
    const id = recordFailedImport({ url: TIKKA_URL, title: null, reason: 'blocked' });
    expect(getFailedImport(id)).toMatchObject({ id, url: TIKKA_URL, reason: 'blocked', kind: 'link' });
    dismissFailedImport(id);
    expect(getFailedImport(id)).toBeUndefined();
  });
});

describe('failed photo imports (spec 4.10)', () => {
  const PHOTO_RECIPE: RecipeImportResponse = { ...TIKKA, sourceUrl: null };
  let documents: string;
  let cache: string;
  let household: string;

  /** A downscaled page in the cache, as the photo import sheet leaves it. */
  const cachePage = (name: string, bytes = `jpeg:${name}`) => {
    const file = path.join(cache, name);
    fs.writeFileSync(file, bytes);
    return `file://${file}`;
  };
  const folder = (id: string) => path.join(documents, 'failed-imports', id);
  const filesIn = (id: string) => (fs.existsSync(folder(id)) ? fs.readdirSync(folder(id)).sort() : null);
  const read = (id: string, name: string) => fs.readFileSync(path.join(folder(id), name), 'utf8');
  const sentPages = () =>
    (invoke.mock.calls.at(-1)![1] as { body: { images: { data: string }[] } }).body.images.map((i) =>
      Buffer.from(i.data, 'base64').toString('utf8'),
    );
  const record = (names: string[], target: { householdId: string | null; listId: string | null } = { householdId: household, listId: costco }) =>
    recordFailedPhotoImport(
      names.map((n) => cachePage(n)),
      'not_a_recipe',
      target,
    )!;

  beforeEach(() => {
    documents = fs.mkdtempSync(path.join(os.tmpdir(), 'documents-'));
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-'));
    setDocumentRoot(documents);
    household = getList(groceries)!.householdId;
  });

  afterEach(() => {
    fs.rmSync(documents, { recursive: true, force: true });
    fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('recording', () => {
    test('moves the pages out of the cache into failed-imports/<id>/<n>.jpg, in order, with a photo row', () => {
      const uris = ['a.jpg', 'b.jpg'].map((n) => cachePage(n));
      const id = recordFailedPhotoImport(uris, 'rate_limited', { householdId: household, listId: costco })!;
      expect(filesIn(id)).toEqual(['1.jpg', '2.jpg']);
      expect(read(id, '1.jpg')).toBe('jpeg:a.jpg');
      expect(read(id, '2.jpg')).toBe('jpeg:b.jpg');
      expect(fs.readdirSync(cache)).toEqual([]);
      expect(rows()).toEqual([
        {
          id,
          kind: 'photo',
          url: null,
          title: null,
          reason: 'rate_limited',
          householdId: household,
          listId: costco,
          pages: ['1.jpg', '2.jpg'],
          createdAt: expect.any(Date),
        },
      ]);
      expect(failedImportPageUris(rows()[0])).toEqual([
        `file://${path.join(folder(id), '1.jpg')}`,
        `file://${path.join(folder(id), '2.jpg')}`,
      ]);
    });

    test('a link row has no pages', () => {
      recordFailedImport({ url: TIKKA_URL, title: null, reason: 'failed' });
      expect(rows()[0]).toMatchObject({ kind: 'link', pages: null });
      expect(failedImportPageUris(rows()[0])).toEqual([]);
    });

    test("a page that's gone from the cache records nothing and leaves no folder", () => {
      const uris = [cachePage('a.jpg'), `file://${path.join(cache, 'missing.jpg')}`];
      expect(recordFailedPhotoImport(uris, 'failed', { householdId: household, listId: null })).toBeNull();
      expect(rows()).toEqual([]);
      expect(fs.existsSync(path.join(documents, 'failed-imports')) ? fs.readdirSync(path.join(documents, 'failed-imports')) : []).toEqual([]);
    });

    test('no pages records nothing', () => {
      expect(recordFailedPhotoImport([], 'failed', { householdId: household, listId: null })).toBeNull();
      expect(rows()).toEqual([]);
    });

    test('a failed importRecipeFromPhotos records its pages and gives the row', async () => {
      invoke.mockResolvedValue(httpError(422, 'not_a_recipe'));
      const uris = ['a.jpg', 'b.jpg'].map((n) => cachePage(n));
      const result = await importRecipeFromPhotos({ listId: costco, photoUris: uris });
      expect(result).toEqual({ ok: false, error: 'not_a_recipe', failedImportId: expect.any(String) });
      const id = (result as { failedImportId: string }).failedImportId;
      expect(rows()).toEqual([expect.objectContaining({ id, kind: 'photo', reason: 'not_a_recipe', householdId: household, listId: costco })]);
      expect(filesIn(id)).toEqual(['1.jpg', '2.jpg']);
      expect(storageUploads()).toEqual([]);
    });
  });

  describe('Try again', () => {
    test('sends the kept pages, in order; success makes the recipe with its pages and removes the row and folder', async () => {
      const id = record(['a.jpg', 'b.jpg']);
      invoke.mockResolvedValue({ data: PHOTO_RECIPE, error: null });
      const result = await retryFailedImport(id, USER);
      expect(result).toMatchObject({ ok: true, listId: costco, added: 2, created: true });
      expect(invoke.mock.calls.map(([fn]) => fn)).toEqual(['import-recipe-photo']);
      expect(sentPages()).toEqual(['jpeg:a.jpg', 'jpeg:b.jpg']);
      // The pages went up with the recipe before their files were deleted.
      const uploads = storageUploads();
      expect(uploads.map(([bucket]) => bucket)).toEqual(['recipe-pages', 'recipe-pages']);
      expect(uploads.map(([, , body]) => new TextDecoder().decode(body as ArrayBuffer))).toEqual(['jpeg:a.jpg', 'jpeg:b.jpg']);
      const saved = db.select({ sourcePages: recipes.sourcePages }).from(recipes).where(eq(recipes.id, (result as { recipeId: string }).recipeId)).get();
      expect(saved?.sourcePages).toEqual(uploads.map(([, p]) => p));
      expect(rows()).toEqual([]);
      expect(filesIn(id)).toBeNull();
      expect(itemNames(costco)).toEqual(['garlic', 'onion']);
    });

    test('a recipe-only row saves into its household and adds nothing', async () => {
      const id = record(['a.jpg'], { householdId: household, listId: null });
      invoke.mockResolvedValue({ data: PHOTO_RECIPE, error: null });
      expect(await retryFailedImport(id, USER)).toMatchObject({ ok: true, listId: null, added: 0 });
      expect(liveRecipes()).toEqual([{ name: 'Chicken tikka masala' }]);
      expect(itemNames(groceries)).toEqual([]);
      expect(itemNames(costco)).toEqual([]);
    });

    test('a list that has gone falls back to the default list', async () => {
      const id = record(['a.jpg']);
      deleteList(costco);
      invoke.mockResolvedValue({ data: PHOTO_RECIPE, error: null });
      expect(await retryFailedImport(id, USER)).toMatchObject({ ok: true, listId: groceries });
      expect(itemNames(groceries)).toEqual(['garlic', 'onion']);
    });

    test('another failure keeps the row and its pages with the new reason, and records no second row', async () => {
      const id = record(['a.jpg', 'b.jpg']);
      invoke.mockResolvedValue(httpError(429, 'rate_limited'));
      expect(await retryFailedImport(id, USER)).toEqual({ ok: false, error: 'rate_limited', failedImportId: id });
      expect(rows()).toEqual([expect.objectContaining({ id, kind: 'photo', reason: 'rate_limited', pages: ['1.jpg', '2.jpg'] })]);
      expect(filesIn(id)).toEqual(['1.jpg', '2.jpg']);
      expect(read(id, '1.jpg')).toBe('jpeg:a.jpg');
      expect(storageUploads()).toEqual([]);
      expect(liveRecipes()).toEqual([]);

      // And the next Try again sends the same pages.
      invoke.mockResolvedValue({ data: PHOTO_RECIPE, error: null });
      expect(await retryFailedImport(id, USER)).toMatchObject({ ok: true });
      expect(sentPages()).toEqual(['jpeg:a.jpg', 'jpeg:b.jpg']);
      expect(rows()).toEqual([]);
    });

    test('a row whose pages have gone is deleted quietly and nothing is sent', async () => {
      const id = record(['a.jpg', 'b.jpg']);
      fs.unlinkSync(path.join(folder(id), '2.jpg'));
      expect(await retryFailedImport(id, USER)).toBeNull();
      expect(invoke).not.toHaveBeenCalled();
      expect(rows()).toEqual([]);
      expect(filesIn(id)).toBeNull();
    });

    test('a retry already running for the same row does nothing', async () => {
      const id = record(['a.jpg']);
      invoke.mockResolvedValue({ data: PHOTO_RECIPE, error: null });
      const [first, second] = await Promise.all([retryFailedImport(id, USER), retryFailedImport(id, USER)]);
      expect(first).toMatchObject({ ok: true });
      expect(second).toBeNull();
      expect(invoke).toHaveBeenCalledTimes(1);
    });
  });

  describe('editing (the review sheet)', () => {
    test('keeps, reorders, removes and adds pages, and saves the target', () => {
      const id = record(['a.jpg', 'b.jpg', 'c.jpg']);
      const [p1, p2, p3] = failedImportPageUris(rows()[0]);
      const added = cachePage('new.jpg');
      expect(updateFailedPhotoImport(id, { pages: [p3, added, p1], householdId: household, listId: null })).toBe(true);
      expect(rows()[0]).toMatchObject({ pages: ['3.jpg', '4.jpg', '1.jpg'], householdId: household, listId: null });
      // The removed page's file is deleted; the new one moved in from the cache.
      expect(filesIn(id)).toEqual(['1.jpg', '3.jpg', '4.jpg']);
      expect(read(id, '4.jpg')).toBe('jpeg:new.jpg');
      expect(fs.readdirSync(cache)).toEqual([]);
      expect(failedImportPageUris(rows()[0])).toEqual([p3, `file://${path.join(folder(id), '4.jpg')}`, p1]);
      expect(p2).not.toBe(p1);
    });

    test('new names never reuse a kept one, even after the highest was removed', () => {
      const id = record(['a.jpg', 'b.jpg']);
      const [p1] = failedImportPageUris(rows()[0]);
      updateFailedPhotoImport(id, { pages: [p1], householdId: household, listId: costco });
      expect(filesIn(id)).toEqual(['1.jpg']);
      updateFailedPhotoImport(id, { pages: [p1, cachePage('x.jpg')], householdId: household, listId: costco });
      expect(rows()[0].pages).toEqual(['1.jpg', '2.jpg']);
      expect(read(id, '2.jpg')).toBe('jpeg:x.jpg');
    });

    test('Try again after an edit sends the edited pages to the edited target', async () => {
      const id = record(['a.jpg', 'b.jpg']);
      const [, p2] = failedImportPageUris(rows()[0]);
      updateFailedPhotoImport(id, { pages: [p2, cachePage('c.jpg')], householdId: household, listId: groceries });
      invoke.mockResolvedValue({ data: PHOTO_RECIPE, error: null });
      expect(await retryFailedImport(id, USER)).toMatchObject({ ok: true, listId: groceries });
      expect(sentPages()).toEqual(['jpeg:b.jpg', 'jpeg:c.jpg']);
    });

    test("refuses no pages, a link row, an unknown row, and a new page that can't be moved, changing nothing", () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      const id = record(['a.jpg']);
      const link = recordFailedImport({ url: TIKKA_URL, title: null, reason: 'failed' });
      const target = { householdId: household, listId: null };
      expect(updateFailedPhotoImport(id, { pages: [], ...target })).toBe(false);
      expect(updateFailedPhotoImport(link, { pages: [cachePage('x.jpg')], ...target })).toBe(false);
      expect(updateFailedPhotoImport('nope', { pages: [cachePage('y.jpg')], ...target })).toBe(false);
      const [p1] = failedImportPageUris(rows().find((r) => r.id === id)!);
      expect(updateFailedPhotoImport(id, { pages: [p1, `file://${path.join(cache, 'missing.jpg')}`], ...target })).toBe(false);
      expect(rows().find((r) => r.id === id)).toMatchObject({ pages: ['1.jpg'], listId: costco });
      expect(filesIn(id)).toEqual(['1.jpg']);
    });
  });

  test('dismiss deletes the row and its folder', () => {
    const id = record(['a.jpg', 'b.jpg']);
    const other = record(['c.jpg']);
    dismissFailedImport(id);
    expect(rows().map((r) => r.id)).toEqual([other]);
    expect(filesIn(id)).toBeNull();
    expect(filesIn(other)).toEqual(['1.jpg']);
  });

  describe('the launch prune', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const age = (id: string, ms: number) =>
      db.update(failedImports).set({ createdAt: new Date(Date.now() - ms) }).where(eq(failedImports.id, id)).run();

    test('deletes photo rows 30 days old or more with their folders, and keeps younger ones', () => {
      const old = record(['a.jpg']);
      const edge = record(['b.jpg']);
      const young = record(['c.jpg']);
      age(old, 31 * DAY);
      age(edge, 30 * DAY);
      age(young, 29 * DAY);
      pruneFailedPhotoImports();
      expect(rows().map((r) => r.id)).toEqual([young]);
      expect(filesIn(old)).toBeNull();
      expect(filesIn(edge)).toBeNull();
      expect(filesIn(young)).toEqual(['1.jpg']);
    });

    test('deletes a row whose pages have gone, and a folder no row owns', () => {
      const missingFile = record(['a.jpg', 'b.jpg']);
      const missingFolder = record(['c.jpg']);
      const kept = record(['d.jpg']);
      fs.unlinkSync(path.join(folder(missingFile), '1.jpg'));
      fs.rmSync(folder(missingFolder), { recursive: true });
      fs.mkdirSync(folder('orphan'));
      fs.writeFileSync(path.join(folder('orphan'), '1.jpg'), 'x');
      pruneFailedPhotoImports();
      expect(rows().map((r) => r.id)).toEqual([kept]);
      expect(fs.readdirSync(path.join(documents, 'failed-imports'))).toEqual([kept]);
    });

    test('leaves link rows alone, however old', () => {
      const link = recordFailedImport({ url: TIKKA_URL, title: null, reason: 'failed' });
      age(link, 90 * DAY);
      pruneFailedPhotoImports();
      expect(rows().map((r) => r.id)).toEqual([link]);
    });

    test('with nothing kept, does nothing', () => {
      expect(() => pruneFailedPhotoImports()).not.toThrow();
      expect(rows()).toEqual([]);
    });
  });
});
