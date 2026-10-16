import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { and, asc, eq, isNull } from 'drizzle-orm';

import { db, households, recipes } from '@/db';
import { groupItems, listItemsQuery } from '@/features/lists/items';
import {
  createList,
  deleteList,
  ensureStarterData,
  getDefaultListId,
  getList,
  setListArchived,
} from '@/features/lists/lists';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { SHARE_PENDING_DIR } from '@/features/siri/app-group';
import { normalizeIngredientName, SYSTEM_CATEGORIES } from '@/shared';
import type { RecipeImportResponse } from '@/shared/schemas/recipe-import';
import { resetDb } from '@/test/db';
import { seedCatalog } from '@/test/seed';
import { File, setAppGroupRoot } from '@/test/fake-file-system';
import { makeSession, resetSupabase, supabase } from '@/test/fake-supabase';

import { recipeIdForImport } from '../import';
import {
  EMPTY_SHARE_QUEUE_STATUS,
  getShareQueueStatus,
  importsBadgeCount,
  importsCardHeading,
  queuedShareDetail,
  setShareQueueStatus,
  type QueuedShare,
} from '../share-queue-status';
import { sharedImportsToast } from '../import-sheet';
import {
  drainShareQueue,
  MAX_SHARE_ATTEMPTS,
  onShareImports,
  removeQueuedShare,
  runShareDrain,
  shareAttemptsKey,
  type FailedShare,
} from '../share-drain';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('expo-file-system', () => require('@/test/fake-file-system'));
jest.mock('expo-network', () => ({ addNetworkStateListener: () => ({ remove: () => {} }) }));

const USER = 'user-1';
const invoke = supabase.functions.invoke;
const category = (slug: string) => SYSTEM_CATEGORIES.find((c) => c.slug === slug)!.id;

// UUIDv7 envelope ids, in the order they were shared.
const E1 = '019a4c2e-7d3b-7a10-8f2e-3b9d1c0e5a71';
const E2 = '019a4c2e-9e01-7c44-b1aa-0f6e2d8c3b92';
const E3 = '019a4c2f-0102-7d55-a2bb-1a2b3c4d5e6f';
const GONE_LIST = '019a4c10-0000-7000-8000-00000000c057';

const TIKKA_URL = 'https://example.com/tikka';
const SOUP_URL = 'https://example.com/soup';

const recipeFor = (name: string, sourceUrl: string, ...names: string[]): RecipeImportResponse => ({
  name,
  sourceUrl,
  servings: null,
  ingredients: names.map((displayName) => ({
    ingredientName: normalizeIngredientName(displayName),
    displayName,
    quantity: null,
    unit: null,
    note: '',
    categoryId: category('produce'),
    status: 'categorized',
  })),
  tags: null,
  totalMinutes: null,
  steps: [],
  stepIngredients: null,
  imageUrl: null,
});
const TIKKA = recipeFor('Chicken tikka masala', TIKKA_URL, 'garlic', 'onion');
const SOUP = recipeFor('Leek soup', SOUP_URL, 'leek');

/** What `functions.invoke` gives for a non-2xx answer. */
const httpError = (status: number, error: string) => ({
  data: null,
  error: {
    name: 'FunctionsHttpError',
    message: 'Edge Function returned a non-2xx status code',
    context: { status, json: () => Promise.resolve({ error }) },
  },
});
const offline = { data: null, error: { name: 'FunctionsFetchError', message: 'Failed to send a request' } };

/** Answers each import by its URL: a recipe, or an error. */
function respond(byUrl: Record<string, RecipeImportResponse | { data: null; error: unknown }>) {
  invoke.mockImplementation(async (_fn: string, options: { body: { url: string } }) => {
    const answer = byUrl[options.body.url];
    if (!answer) throw new Error(`no answer for ${options.body.url}`);
    return 'error' in answer ? answer : { data: answer, error: null };
  });
}

let root: string;
let groceries: string;
let costco: string;
/** The starter household, where Groceries and Costco are. */
let personal: string;
let recordFailed: jest.Mock<(failed: FailedShare) => void>;

beforeEach(() => {
  resetDb();
  resetSupabase();
  seedCatalog();
  ensureStarterData(USER);
  groceries = getDefaultListId(USER)!;
  costco = createList('Costco');
  personal = getList(groceries)!.householdId;
  supabase.auth.getSession.mockResolvedValue({ data: { session: makeSession(USER) }, error: null });
  respond({ [TIKKA_URL]: TIKKA, [SOUP_URL]: SOUP });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'share-drain-'));
  fs.mkdirSync(path.join(root, SHARE_PENDING_DIR), { recursive: true });
  setAppGroupRoot(root);
  recordFailed = jest.fn();
  setShareQueueStatus(EMPTY_SHARE_QUEUE_STATUS);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Writes a queued share as the extension does: `share/pending/<id>.json`. */
function enqueue(
  id: string,
  url: string,
  extra: { listId?: string | null; householdId?: string | null; addToList?: boolean; page?: Record<string, unknown> } = {},
): void {
  const envelope = {
    id,
    url,
    listId: costco,
    createdAt: '2026-10-08T17:42:05.123-05:00',
    appVersion: '1.0.0',
    source: 'share',
    ...extra,
  };
  writeQueued(`${id}.json`, JSON.stringify(envelope));
}
const writeQueued = (name: string, body: string) => fs.writeFileSync(path.join(root, SHARE_PENDING_DIR, name), body);
const queued = () => fs.readdirSync(path.join(root, SHARE_PENDING_DIR)).sort();
const drain = () => drainShareQueue(USER, { recordFailed });

const liveRecipes = () =>
  db
    .select({ id: recipes.id, name: recipes.name, sourceUrl: recipes.sourceUrl })
    .from(recipes)
    .where(isNull(recipes.deletedAt))
    .orderBy(asc(recipes.name))
    .all();
const rows = (listId: string) => groupItems(listItemsQuery(listId).all()).unchecked.map((i) => i.displayName);
const importedUrls = () => invoke.mock.calls.map(([, options]) => (options as { body: { url: string } }).body.url);

describe('drainShareQueue', () => {
  test('imports a share into its list, deletes the file and returns the import', async () => {
    enqueue(E1, TIKKA_URL);
    const result = await drain();

    expect(result.failed).toBe(0);
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]).toMatchObject({
      ok: true,
      recipeId: recipeIdForImport(E1),
      recipeName: 'Chicken tikka masala',
      listId: costco,
      added: 2,
      combined: 0,
    });
    expect(liveRecipes()).toEqual([{ id: recipeIdForImport(E1), name: 'Chicken tikka masala', sourceUrl: TIKKA_URL }]);
    expect(rows(costco)).toEqual(['garlic', 'onion']);
    expect(rows(groceries)).toEqual([]);
    expect(queued()).toEqual([]);
    expect(recordFailed).not.toHaveBeenCalled();
  });

  test('sends the captured page with the envelope id as the import id', async () => {
    const page = { title: 'Tikka | Example', jsonLd: ['{"@type":"Recipe"}'], text: 'Chicken tikka' };
    enqueue(E1, TIKKA_URL, { page });
    await drain();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('import-recipe', { body: { url: TIKKA_URL, page } });
  });

  test('imports several shares oldest first', async () => {
    enqueue(E2, SOUP_URL);
    enqueue(E1, TIKKA_URL);
    const result = await drain();
    expect(importedUrls()).toEqual([TIKKA_URL, SOUP_URL]);
    expect(result.imported.map((i) => i.recipeName)).toEqual(['Chicken tikka masala', 'Leek soup']);
    expect(rows(costco)).toEqual(['garlic', 'onion', 'leek']);
    expect(queued()).toEqual([]);
  });

  test('uses the default list when the envelope has none, or its list is deleted, archived or unknown', async () => {
    const archived = createList('Old');
    setListArchived(archived, true);
    const deleted = createList('Gone');
    deleteList(deleted);
    enqueue(E1, TIKKA_URL, { listId: null });
    enqueue(E2, SOUP_URL, { listId: GONE_LIST });
    const result = await drain();
    expect(result.imported.map((i) => i.listId)).toEqual([groceries, groceries]);

    enqueue(E3, TIKKA_URL, { listId: archived });
    const third = await drain();
    expect(third.imported.map((i) => i.listId)).toEqual([groceries]);
    expect(rows(groceries)).toEqual(['garlic', 'onion', 'leek']);
    expect(rows(costco)).toEqual([]);
    expect(queued()).toEqual([]);
  });

  test.each([
    ['offline', offline],
    ['rate_limited', httpError(429, 'rate_limited')],
    ['failed', httpError(500, 'internal')],
  ])('%s keeps the file and counts a try', async (_error, answer) => {
    respond({ [TIKKA_URL]: answer });
    enqueue(E1, TIKKA_URL);

    expect(await drain()).toEqual({ imported: [], failed: 0 });
    expect(queued()).toEqual([`${E1}.json`]);
    expect(getDeviceSetting(shareAttemptsKey(E1), 0)).toBe(1);

    await drain();
    expect(getDeviceSetting(shareAttemptsKey(E1), 0)).toBe(2);
    expect(queued()).toEqual([`${E1}.json`]);
    expect(liveRecipes()).toEqual([]);
    expect(recordFailed).not.toHaveBeenCalled();
  });

  test('offline, the rest of the queue waits without counting a try', async () => {
    respond({ [TIKKA_URL]: offline, [SOUP_URL]: SOUP });
    enqueue(E1, TIKKA_URL);
    enqueue(E2, SOUP_URL);
    await drain();
    expect(importedUrls()).toEqual([TIKKA_URL]);
    expect(queued()).toEqual([`${E1}.json`, `${E2}.json`]);
    expect(getDeviceSetting(shareAttemptsKey(E2), 0)).toBe(0);
  });

  test('a failure that isn’t offline or rate limited moves on to the next share', async () => {
    respond({ [TIKKA_URL]: httpError(500, 'internal'), [SOUP_URL]: SOUP });
    enqueue(E1, TIKKA_URL);
    enqueue(E2, SOUP_URL);
    const result = await drain();
    expect(result.imported.map((i) => i.recipeName)).toEqual(['Leek soup']);
    expect(queued()).toEqual([`${E1}.json`]);
  });

  test('the 5th failure records a failed import and deletes the file', async () => {
    respond({ [TIKKA_URL]: httpError(429, 'rate_limited') });
    enqueue(E1, TIKKA_URL, { page: { title: '  Tikka | Example ' } });
    for (let i = 1; i < MAX_SHARE_ATTEMPTS; i++) {
      await drain();
      expect(getDeviceSetting(shareAttemptsKey(E1), 0)).toBe(i);
    }
    expect(recordFailed).not.toHaveBeenCalled();

    expect(await drain()).toEqual({ imported: [], failed: 1 });
    expect(recordFailed).toHaveBeenCalledTimes(1);
    expect(recordFailed).toHaveBeenCalledWith({
      url: TIKKA_URL,
      title: 'Tikka | Example',
      reason: 'rate_limited',
      householdId: personal,
      listId: costco,
    });
    expect(queued()).toEqual([]);
    expect(getDeviceSetting(shareAttemptsKey(E1), null)).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(MAX_SHARE_ATTEMPTS);
  });

  test('a share that imports after failing forgets its tries', async () => {
    setDeviceSetting(shareAttemptsKey(E1), 3);
    enqueue(E1, TIKKA_URL);
    expect((await drain()).imported).toHaveLength(1);
    expect(getDeviceSetting(shareAttemptsKey(E1), null)).toBeNull();
  });

  test('not a recipe records a failed import at once, with no title when the share had no page', async () => {
    respond({ [TIKKA_URL]: httpError(422, 'not_a_recipe'), [SOUP_URL]: SOUP });
    enqueue(E1, TIKKA_URL);
    enqueue(E2, SOUP_URL);
    const result = await drain();
    expect(result.failed).toBe(1);
    expect(result.imported.map((i) => i.recipeName)).toEqual(['Leek soup']);
    expect(recordFailed).toHaveBeenCalledTimes(1);
    expect(recordFailed).toHaveBeenCalledWith({
      url: TIKKA_URL,
      title: null,
      reason: 'not_a_recipe',
      householdId: personal,
      listId: costco,
    });
    expect(queued()).toEqual([]);
    expect(getDeviceSetting(shareAttemptsKey(E1), null)).toBeNull();
  });

  test('not in the plan records a failed import at once, with no retries, for every share', async () => {
    respond({ [TIKKA_URL]: httpError(403, 'not_entitled'), [SOUP_URL]: httpError(403, 'not_entitled') });
    enqueue(E1, TIKKA_URL, { page: { title: 'Tikka' } });
    enqueue(E2, SOUP_URL);
    // Tries from before the plan changed don't matter.
    setDeviceSetting(shareAttemptsKey(E2), 2);
    expect(await drain()).toEqual({ imported: [], failed: 2 });
    expect(recordFailed.mock.calls).toEqual([
      [{ url: TIKKA_URL, title: 'Tikka', reason: 'not_entitled', householdId: personal, listId: costco }],
      [{ url: SOUP_URL, title: null, reason: 'not_entitled', householdId: personal, listId: costco }],
    ]);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(queued()).toEqual([]);
    expect(getDeviceSetting(shareAttemptsKey(E1), null)).toBeNull();
    expect(getDeviceSetting(shareAttemptsKey(E2), null)).toBeNull();
    expect(getShareQueueStatus()).toEqual(EMPTY_SHARE_QUEUE_STATUS);
    expect(liveRecipes()).toEqual([]);
  });

  test('deletes and logs a bad file, and imports the rest', async () => {
    writeQueued(`${E1}.json`, '{ not json');
    writeQueued(`${E2}.json`, JSON.stringify({ id: E2, url: 'ftp://example.com', source: 'share' }));
    enqueue(E3, TIKKA_URL);
    const result = await drain();
    expect(result.imported.map((i) => i.recipeName)).toEqual(['Chicken tikka masala']);
    expect(queued()).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith('[share] dropping a bad queued share', `${E1}.json`, expect.any(String));
    expect(console.warn).toHaveBeenCalledWith('[share] dropping a bad queued share', `${E2}.json`, expect.any(String));
    expect(recordFailed).not.toHaveBeenCalled();
  });

  test('skips in-progress .tmp writes', async () => {
    writeQueued(`${E1}.json.tmp`, '{');
    expect(await drain()).toEqual({ imported: [], failed: 0 });
    expect(invoke).not.toHaveBeenCalled();
    expect(queued()).toEqual([`${E1}.json.tmp`]);
  });

  test('two concurrent drains import once', async () => {
    let answer!: () => void;
    invoke.mockImplementationOnce(
      () => new Promise((resolve) => (answer = () => resolve({ data: TIKKA, error: null }))),
    );
    enqueue(E1, TIKKA_URL);
    const first = drain();
    // Let the first drain reach the import call.
    await new Promise((resolve) => setImmediate(resolve));
    expect(await drain()).toEqual({ imported: [], failed: 0 });
    answer();
    expect((await first).imported).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(liveRecipes()).toHaveLength(1);
    expect(queued()).toEqual([]);
    // Free again afterwards.
    enqueue(E2, SOUP_URL);
    expect((await drain()).imported).toHaveLength(1);
  });

  test('a crash between import and delete imports the same recipe again, not a second one', async () => {
    enqueue(E1, TIKKA_URL);
    const del = jest.spyOn(File.prototype, 'delete').mockImplementationOnce(() => {
      throw new Error('crashed');
    });
    await drain();
    expect(queued()).toEqual([`${E1}.json`]);
    del.mockRestore();

    // The household's recipe is now named differently, so only the import id can find it.
    respond({ [TIKKA_URL]: { ...TIKKA, sourceUrl: 'https://example.com/tikka-v2' } });
    const again = await drain();
    expect(again.imported[0].recipeId).toBe(recipeIdForImport(E1));
    expect(liveRecipes()).toEqual([{ id: recipeIdForImport(E1), name: 'Chicken tikka masala', sourceUrl: TIKKA_URL }]);
    expect(rows(costco)).toEqual(['garlic', 'onion']);
    expect(queued()).toEqual([]);
  });

  test('with no list to import into, every share waits', async () => {
    deleteList(costco);
    deleteList(groceries);
    enqueue(E1, TIKKA_URL);
    expect(await drain()).toEqual({ imported: [], failed: 0 });
    expect(invoke).not.toHaveBeenCalled();
    expect(queued()).toEqual([`${E1}.json`]);
    expect(getDeviceSetting(shareAttemptsKey(E1), 0)).toBe(0);
  });

  test('signed out, shares wait and count a try', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    enqueue(E1, TIKKA_URL);
    expect(await drain()).toEqual({ imported: [], failed: 0 });
    expect(queued()).toEqual([`${E1}.json`]);
    expect(getDeviceSetting(shareAttemptsKey(E1), 0)).toBe(1);
    expect(liveRecipes()).toEqual([]);
  });
});

describe('recipe-only shares', () => {
  const CABIN = '019a4c0f-0000-7000-8000-0000000000b1';
  const recipeOnly = (householdId: string | null = CABIN) => ({ listId: null, householdId, addToList: false });
  const recipesIn = (householdId: string) =>
    db
      .select({ id: recipes.id, name: recipes.name })
      .from(recipes)
      .where(and(eq(recipes.householdId, householdId), isNull(recipes.deletedAt)))
      .all();

  beforeEach(() => {
    db.insert(households).values({ id: CABIN, name: 'Lake cabin' }).run();
  });

  test('saves the recipe to its household and adds nothing to any list', async () => {
    enqueue(E1, TIKKA_URL, recipeOnly());
    const result = await drain();
    expect(result.failed).toBe(0);
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]).toMatchObject({
      ok: true,
      recipeId: recipeIdForImport(E1),
      recipeName: 'Chicken tikka masala',
      listId: null,
      created: true,
      added: 0,
      combined: 0,
    });
    expect(recipesIn(CABIN)).toEqual([{ id: recipeIdForImport(E1), name: 'Chicken tikka masala' }]);
    expect(recipesIn(personal)).toEqual([]);
    expect(rows(costco)).toEqual([]);
    expect(rows(groceries)).toEqual([]);
    expect(queued()).toEqual([]);
  });

  test('with its household gone (left or deleted), goes to the household of the default list', async () => {
    db.delete(households).where(eq(households.id, CABIN)).run();
    enqueue(E1, TIKKA_URL, recipeOnly());
    enqueue(E2, SOUP_URL, recipeOnly(null));
    const result = await drain();
    expect(result.imported.map((i) => [i.recipeName, i.listId])).toEqual([
      ['Chicken tikka masala', null],
      ['Leek soup', null],
    ]);
    expect(recipesIn(personal).map((r) => r.name).sort()).toEqual(['Chicken tikka masala', 'Leek soup']);
    expect(rows(groceries)).toEqual([]);
    expect(rows(costco)).toEqual([]);
  });

  test('with no household and no lists to fall back on, it waits', async () => {
    db.delete(households).where(eq(households.id, CABIN)).run();
    deleteList(costco);
    deleteList(groceries);
    enqueue(E1, TIKKA_URL, recipeOnly());
    expect(await drain()).toEqual({ imported: [], failed: 0 });
    expect(invoke).not.toHaveBeenCalled();
    expect(queued()).toEqual([`${E1}.json`]);
  });

  test('a failure is recorded with its household and no list', async () => {
    respond({ [TIKKA_URL]: httpError(422, 'not_a_recipe') });
    enqueue(E1, TIKKA_URL, { ...recipeOnly(), page: { title: 'Tikka' } });
    expect(await drain()).toEqual({ imported: [], failed: 1 });
    expect(recordFailed.mock.calls).toEqual([
      [{ url: TIKKA_URL, title: 'Tikka', reason: 'not_a_recipe', householdId: CABIN, listId: null }],
    ]);
  });

  test('a failure whose household was gone is recorded with the household it fell back to', async () => {
    db.delete(households).where(eq(households.id, CABIN)).run();
    respond({ [TIKKA_URL]: httpError(422, 'not_a_recipe') });
    enqueue(E1, TIKKA_URL, recipeOnly());
    await drain();
    expect(recordFailed).toHaveBeenCalledWith(expect.objectContaining({ householdId: personal, listId: null }));
  });

  test('a list share is unchanged by the new fields, and an old envelope without them adds to its list', async () => {
    enqueue(E1, TIKKA_URL, { listId: costco, householdId: personal, addToList: true });
    enqueue(E2, SOUP_URL);
    const result = await drain();
    expect(result.imported.map((i) => i.listId)).toEqual([costco, costco]);
    expect(rows(costco)).toEqual(['garlic', 'onion', 'leek']);
  });

  test('the queue shows the household it waits for', async () => {
    respond({ [TIKKA_URL]: offline });
    enqueue(E1, TIKKA_URL, recipeOnly());
    await drain();
    const [share] = getShareQueueStatus().queued;
    expect(share).toEqual({ id: E1, url: TIKKA_URL, title: null, listName: null, householdName: 'Lake cabin', attempts: 1 });
    expect(queuedShareDetail(share)).toBe('example.com · to Lake cabin · tried once');
  });

  test('undo deletes the recipe the share created; a reused one stays', async () => {
    enqueue(E1, TIKKA_URL, recipeOnly());
    const first = (await drain()).imported[0];
    first.undo();
    expect(recipesIn(CABIN)).toEqual([]);

    // The cabin already has the recipe (same canonical link): reused, and undo leaves it.
    enqueue(E2, SOUP_URL, recipeOnly());
    const soup = (await drain()).imported[0];
    expect(soup.created).toBe(true);
    enqueue(E3, 'https://www.example.com/soup/?utm_source=pin', recipeOnly());
    respond({ 'https://www.example.com/soup/?utm_source=pin': SOUP });
    const again = (await drain()).imported[0];
    expect(again).toMatchObject({ recipeId: soup.recipeId, created: false, listId: null, added: 0 });
    again.undo();
    expect(recipesIn(CABIN)).toEqual([{ id: soup.recipeId, name: 'Leek soup' }]);
  });
});

describe('runShareDrain', () => {
  test('tells listeners once with every import of the drain', async () => {
    const listener = jest.fn();
    const stop = onShareImports(listener);
    enqueue(E1, TIKKA_URL);
    enqueue(E2, SOUP_URL);
    await runShareDrain(USER, { recordFailed });
    expect(listener).toHaveBeenCalledTimes(1);
    const [imported] = listener.mock.calls[0] as [{ recipeName: string }[]];
    expect(imported.map((i) => i.recipeName)).toEqual(['Chicken tikka masala', 'Leek soup']);

    // Nothing imported: no call. Unsubscribed: no call.
    await runShareDrain(USER, { recordFailed });
    stop();
    enqueue(E3, TIKKA_URL);
    await runShareDrain(USER, { recordFailed });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('does nothing without the App Group', async () => {
    setAppGroupRoot(null);
    expect(await runShareDrain(USER)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  test('undo from the toast takes back the adds and the recipe the import created', async () => {
    enqueue(E1, TIKKA_URL);
    const result = await runShareDrain(USER, { recordFailed });
    result!.imported[0].undo();
    expect(rows(costco)).toEqual([]);
    expect(liveRecipes()).toEqual([]);
  });
});

describe('sharedImportsToast', () => {
  test('counts the recipes', () => {
    expect(sharedImportsToast(3)).toEqual({ message: 'Added 3 recipes' });
    expect(sharedImportsToast(2)).toEqual({ message: 'Added 2 recipes' });
    expect(sharedImportsToast(1)).toEqual({ message: 'Added 1 recipe' });
  });
});

describe('queue status', () => {
  test('after a drain stops offline, lists what waits with its list and tries, and why', async () => {
    respond({ [TIKKA_URL]: offline, [SOUP_URL]: SOUP });
    enqueue(E1, TIKKA_URL, { page: { title: ' Tikka | Example ' } });
    enqueue(E2, SOUP_URL, { listId: null });
    await drain();
    expect(getShareQueueStatus()).toEqual({
      queued: [
        { id: E1, url: TIKKA_URL, title: 'Tikka | Example', listName: 'Costco', householdName: null, attempts: 1 },
        { id: E2, url: SOUP_URL, title: null, listName: 'Groceries', householdName: null, attempts: 0 },
      ],
      importing: null,
      waitReason: 'offline',
    });
  });

  test('says which share is importing, then empties once the queue is imported', async () => {
    let answer!: () => void;
    invoke.mockImplementationOnce(
      () => new Promise((resolve) => (answer = () => resolve({ data: TIKKA, error: null }))),
    );
    enqueue(E1, TIKKA_URL);
    enqueue(E2, SOUP_URL);
    const running = drain();
    await new Promise((resolve) => setImmediate(resolve));
    expect(getShareQueueStatus().importing).toEqual({ id: E1, position: 1, total: 2 });
    expect(getShareQueueStatus().queued.map((s) => s.id)).toEqual([E1, E2]);
    answer();
    await running;
    expect(getShareQueueStatus()).toEqual(EMPTY_SHARE_QUEUE_STATUS);
  });

  test('Remove deletes a waiting share and forgets its tries', async () => {
    respond({ [TIKKA_URL]: offline });
    enqueue(E1, TIKKA_URL);
    enqueue(E2, SOUP_URL);
    await drain();
    expect(removeQueuedShare(E2, USER)).toBe(true);
    expect(queued()).toEqual([`${E1}.json`]);
    expect(getShareQueueStatus().queued.map((s) => s.id)).toEqual([E1]);
    expect(getShareQueueStatus().waitReason).toBe('offline');

    expect(removeQueuedShare(E1, USER)).toBe(true);
    expect(getDeviceSetting(shareAttemptsKey(E1), null)).toBeNull();
    expect(getShareQueueStatus()).toEqual(EMPTY_SHARE_QUEUE_STATUS);
    expect(removeQueuedShare(E1, USER)).toBe(false);
  });

  test('the share importing can’t be removed; one removed mid-drain isn’t imported', async () => {
    let answer!: () => void;
    invoke.mockImplementationOnce(
      () => new Promise((resolve) => (answer = () => resolve({ data: TIKKA, error: null }))),
    );
    enqueue(E1, TIKKA_URL);
    enqueue(E2, SOUP_URL);
    const running = drain();
    await new Promise((resolve) => setImmediate(resolve));
    expect(removeQueuedShare(E1, USER)).toBe(false);
    expect(removeQueuedShare(E2, USER)).toBe(true);
    answer();
    const result = await running;
    expect(result.imported.map((i) => i.recipeName)).toEqual(['Chicken tikka masala']);
    expect(importedUrls()).toEqual([TIKKA_URL]);
    expect(queued()).toEqual([]);
  });
});

describe('imports card copy', () => {
  const share = (id: string, extra: Partial<QueuedShare> = {}): QueuedShare => ({
    id,
    url: 'https://www.bonappetit.com/recipe/tikka',
    title: 'Chicken tikka masala',
    listName: 'Groceries',
    attempts: 0,
    ...extra,
  });
  const idle = (queued: QueuedShare[], waitReason: 'offline' | 'rate_limited' | 'failed' | null = null) => ({
    queued,
    importing: null,
    waitReason,
  });

  test('nothing to show without failed imports or shares', () => {
    expect(importsCardHeading(0, EMPTY_SHARE_QUEUE_STATUS)).toBeNull();
  });

  test('importing shows progress and the share', () => {
    const queue = { queued: [share(E1), share(E2)], importing: { id: E1, position: 1, total: 2 }, waitReason: null };
    expect(importsCardHeading(0, queue)).toEqual({
      tone: 'importing',
      title: 'Importing 1 of 2…',
      subtitle: 'Chicken tikka masala · to Groceries',
    });
  });

  test('waiting says why', () => {
    expect(importsCardHeading(0, idle([share(E1), share(E2)], 'offline'))).toEqual({
      tone: 'waiting',
      title: '2 recipes waiting',
      subtitle: "You're offline. They'll import when you're back.",
    });
    expect(importsCardHeading(0, idle([share(E1)], 'rate_limited'))?.subtitle).toBe(
      "The import service is busy. They'll import next time you open the app.",
    );
    expect(importsCardHeading(0, idle([share(E1)]))?.title).toBe('1 recipe waiting');
  });

  test('failed imports lead, with the queue under them', () => {
    expect(importsCardHeading(1, EMPTY_SHARE_QUEUE_STATUS)).toEqual({
      tone: 'failed',
      title: "Couldn't import 1 recipe",
      subtitle: null,
    });
    expect(importsCardHeading(2, idle([share(E1)]))?.subtitle).toBe('1 more waiting');
    expect(importsCardHeading(1, idle([share(E1)], 'offline'))?.subtitle).toBe(
      "1 more waiting · You're offline. They'll import when you're back.",
    );
    const importing = { queued: [share(E1)], importing: { id: E1, position: 1, total: 1 }, waitReason: null };
    expect(importsCardHeading(1, importing)?.subtitle).toBe('Importing 1 of 1…');
  });

  test('a waiting row gives the host, the list and the tries', () => {
    expect(queuedShareDetail(share(E1))).toBe('bonappetit.com · to Groceries');
    expect(queuedShareDetail(share(E1, { attempts: 1, listName: null }))).toBe('bonappetit.com · tried once');
    expect(queuedShareDetail(share(E1, { attempts: 2 }))).toBe('bonappetit.com · to Groceries · tried twice');
    expect(queuedShareDetail(share(E1, { attempts: 4 }))).toBe('bonappetit.com · to Groceries · tried 4 times');
  });

  test('a recipe-only row and its import progress name the household', () => {
    const recipeOnly = share(E1, { listName: null, householdName: 'Smith home' });
    expect(queuedShareDetail(recipeOnly)).toBe('bonappetit.com · to Smith home');
    expect(queuedShareDetail({ ...recipeOnly, attempts: 2 })).toBe('bonappetit.com · to Smith home · tried twice');
    const queue = { queued: [recipeOnly], importing: { id: E1, position: 1, total: 1 }, waitReason: null };
    expect(importsCardHeading(0, queue)?.subtitle).toBe('Chicken tikka masala · to Smith home');
  });

  test('the tab badge counts waiting shares and failed imports, not while importing', () => {
    expect(importsBadgeCount(idle([share(E1), share(E2)]), 1)).toBe(3);
    const importing = { queued: [share(E1)], importing: { id: E1, position: 1, total: 1 }, waitReason: null };
    expect(importsBadgeCount(importing, 1)).toBe(1);
    expect(importsBadgeCount(EMPTY_SHARE_QUEUE_STATUS, 0)).toBe(0);
  });
});
