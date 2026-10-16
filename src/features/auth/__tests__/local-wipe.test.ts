// Wiping the device after account deletion (spec 4.8): nothing of the user's is left in SQLite, the
// App Group or memory, except the keep-list; and no table in the schema can be missed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { count, eq, is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';

import { categories, db, deviceSettings, households, ingredients, lists } from '@/db';
import * as schema from '@/db/schema';
import { createCategory, SEED_KEY, setCategoryOverride } from '@/features/categories/categories';
import { FOLD_ACCENTS_KEY, foldAccentKeys } from '@/features/categories/fold-accents';
import { clearMyInvites, getMyInvites, refreshMyInvites } from '@/features/households/my-invites';
import { addItem, checkItems } from '@/features/lists/items';
import { AISLE_COLORS_KEY, ITEM_ROW_STYLE_KEY, manualOrderKey, viewModeKey } from '@/features/lists/list-view';
import { createList, ensureStarterData, getDefaultListId, setDefaultList, setLastOpenedList } from '@/features/lists/lists';
import { backfillUnitUsage, backfillUsage, BACKFILL_KEY, UNITS_BACKFILL_KEY } from '@/features/lists/usage';
import { clearNotifications, currentNotification, notify } from '@/features/notifications/notifications';
import { DEFAULT_FEATURES, getFeatures, setFeatures } from '@/features/plans/features';
import { FEATURES_KEY } from '@/features/plans/load';
import { setSlot } from '@/features/meal-plan/write';
import { recordFailedImport } from '@/features/recipes/failed-imports';
import { addRecipeIngredient, createRecipe } from '@/features/recipes/recipes';
import { IMPORT_ADD_TO_LIST_KEY } from '@/features/recipes/save-choice';
import { getShareQueueStatus, setShareQueueStatus } from '@/features/recipes/share-queue-status';
import { getDeviceSetting, setAisleColorStyle, setDeviceSetting, setKeepScreenOn, KEEP_SCREEN_ON_KEY } from '@/features/settings/device-settings';
import { LISTS_FILE, LOG_FILE, PENDING_DIR, SHARE_PENDING_DIR } from '@/features/siri/app-group';
import { normalizeIngredientName } from '@/shared';
import { upsertRow } from '@/sync/mutate';
import { SYSTEM_CATEGORIES } from '@/shared/seed/categories';
import { resetDb, sqlite } from '@/test/db';
import { seedCatalog } from '@/test/seed';
import { setAppGroupRoot } from '@/test/fake-file-system';
import { respondToRpc, resetSupabase } from '@/test/fake-supabase';

import { KEEP_LIST, KEPT_DEVICE_SETTINGS, WIPE_STEPS, wipeLocalData } from '../local-wipe';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('expo-file-system', () => require('@/test/fake-file-system'));
jest.mock('@/lib/google-sign-in', () => ({ getGoogleIdToken: jest.fn(), signOutOfGoogle: jest.fn(async () => {}) }));

const USER = 'u1';
const PRODUCE = SYSTEM_CATEGORIES.find((c) => c.slug === 'produce')!.id;

/** Every table in `src/db/schema.ts`, by name. */
const tableNames = (Object.values(schema) as unknown[])
  .filter((value): value is SQLiteTable => is(value, SQLiteTable))
  .map((table) => getTableConfig(table).name)
  .sort();

const rowCount = (name: string) => (sqlite.prepare(`select count(*) as n from "${name}"`).get() as { n: number }).n;
const deviceKeys = () =>
  db
    .select({ key: deviceSettings.key })
    .from(deviceSettings)
    .all()
    .map((r) => r.key)
    .sort();

let root: string;
const appGroup = (...parts: string[]) => path.join(root, ...parts);
const writeAppGroupFile = (relative: string, body = '{}') => {
  fs.mkdirSync(path.dirname(appGroup(relative)), { recursive: true });
  fs.writeFileSync(appGroup(relative), body);
};

let home: string;
let homeList: string;

/** A household with lists, items, recipes, aisles, usage, outbox rows, settings, App Group files and in-memory stores. */
beforeEach(async () => {
  resetDb();
  resetSupabase();
  seedCatalog();
  foldAccentKeys();
  backfillUsage();
  backfillUnitUsage();
  ensureStarterData(USER);
  home = db.select().from(households).get()!.id;
  homeList = getDefaultListId(USER)!;
  const costcoList = createList('Costco', home);
  setDefaultList(USER, costcoList);

  addItem(homeList, '2 lbs chicken thighs', USER);
  addItem(homeList, 'milk', USER);
  addItem(costcoList, 'zorblax crackers', USER); // a name the catalog doesn't know: pending
  checkItems(
    db
      .select()
      .from(schema.listItems)
      .where(eq(schema.listItems.ingredientName, 'milk'))
      .all()
      .map((i) => i.id),
    USER,
  );
  const recipe = createRecipe('Chili', home);
  addRecipeIngredient(recipe, '1 can beans');
  setSlot(home, '2026-10-15', 'dinner', { kind: 'recipe', recipeId: recipe });
  const aisle = createCategory(USER, home, 'Farm stand');
  setCategoryOverride(home, 'onions', aisle);
  setCategoryOverride(home, 'milk', PRODUCE);
  upsertRow(db, schema.householdStaples, { householdId: home, ingredientName: 'salt', createdBy: USER }, {});
  recordFailedImport({ url: 'https://example.com/ramen', title: 'Ramen', reason: 'not_a_recipe' });

  // Device settings: list state and sync state (user data) next to device-only preferences.
  setDeviceSetting(viewModeKey(homeList), 'aisle');
  setDeviceSetting(manualOrderKey(homeList), [{ id: 'item-1', at: 1 }]);
  setLastOpenedList(homeList);
  setDeviceSetting(FEATURES_KEY, { userId: USER, features: ['categorize', 'recipe_import'] });
  setDeviceSetting('sync.pull', { userId: USER, cursors: { [`household:${home}:lists`]: '2026-10-01' } });
  setDeviceSetting('sync.push', { attempts: 2, nextAttemptAt: null, lastError: 'offline', lastSuccessAt: null });
  setDeviceSetting('shareImportAttempts:abc', 2);
  setAisleColorStyle('header');
  setDeviceSetting(ITEM_ROW_STYLE_KEY, 'card');
  setKeepScreenOn(false);
  setDeviceSetting(IMPORT_ADD_TO_LIST_KEY, true);

  // The App Group: the list snapshot, both queues (with an in-progress write), and the native log.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wipe-'));
  setAppGroupRoot(root);
  writeAppGroupFile(LISTS_FILE);
  writeAppGroupFile(`${PENDING_DIR}/019a5e21-4b7c-7a10-9c3e-5d2f8a6b1e04.json`, '{"text":"two avocados"}');
  writeAppGroupFile(`${PENDING_DIR}/019a5e22-03d1-7b55-8e19-a4c07f3b9d61.json.tmp`, '{"text":"eggs"}');
  writeAppGroupFile(`${SHARE_PENDING_DIR}/019a5e23-77aa-7c01-8d42-1f0e9c8b7a65.json`, '{"url":"https://example.com"}');
  writeAppGroupFile(LOG_FILE, 'launched\n');

  // In memory: plan features, invites, a notification and the share queue status.
  setFeatures(['categorize', 'recipe_import']);
  respondToRpc('my_invites', {
    data: [{ id: 'i1', household_id: 'h2', household_name: 'Smith household', invited_by: 'John', member_count: 2 }],
  });
  await refreshMyInvites();
  notify({ id: 'n1', kind: 'recipeImport', icon: 'fork.knife', hue: 'green', tone: 'success', title: 'Imported Ramen' });
  setShareQueueStatus({ queued: [{ id: 's1' } as never], importing: null, waitReason: 'offline' });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  clearMyInvites();
  clearNotifications();
});

describe('the keep-list', () => {
  test('every table in the schema has a wipe step, once', () => {
    expect(WIPE_STEPS.map((s) => getTableConfig(s.table).name).sort()).toEqual(tableNames);
  });

  test('only the catalog and device-only settings keep rows, each with a reason', () => {
    expect(Object.keys(KEEP_LIST).sort()).toEqual(['categories', 'device_settings', 'ingredients']);
    for (const reason of Object.values(KEEP_LIST)) expect(reason.length).toBeGreaterThan(20);
  });

  test('the kept device settings are preferences and markers, none holding user data', () => {
    expect([...KEPT_DEVICE_SETTINGS].sort()).toEqual(
      [
        'catalog.accentsFolded',
        'catalog.seedFingerprint',
        'importAddToList',
        'list.aisleColors',
        'list.itemRowStyle',
        'list.keepScreenOn',
        'usage.backfilled',
        'usage.unitsBackfilled',
      ].sort(),
    );
  });
});

describe('wipeLocalData', () => {
  test('the seed touches every table, so the wipe below is tested on all of them', () => {
    expect(tableNames.filter((name) => rowCount(name) === 0)).toEqual([]);
  });

  test('leaves nothing but the keep-list', () => {
    wipeLocalData();

    const notKept = tableNames.filter((name) => !(name in KEEP_LIST));
    expect(notKept.filter((name) => rowCount(name) > 0)).toEqual([]);
    expect(notKept).toEqual(
      expect.arrayContaining(['households', 'lists', 'list_items', 'recipes', 'outbox', 'user_settings', 'failed_imports']),
    );
  });

  test('keeps the system aisles and drops the custom one', () => {
    wipeLocalData();
    const left = db.select().from(categories).all();
    expect(left).toHaveLength(SYSTEM_CATEGORIES.length);
    expect(left.every((c) => c.householdId === null)).toBe(true);
    expect(left.some((c) => c.name === 'Farm stand')).toBe(false);
  });

  test('keeps the categorized catalog and drops the names the user typed that are still pending', () => {
    const before = db.select({ n: count() }).from(ingredients).where(eq(ingredients.status, 'categorized')).get()!.n;
    const typed = eq(ingredients.normalizedName, normalizeIngredientName('zorblax crackers'));
    expect(db.select().from(ingredients).where(typed).get()?.status).toBe('pending');

    wipeLocalData();

    expect(db.select().from(ingredients).where(typed).get()).toBeUndefined();
    expect(db.select({ n: count() }).from(ingredients).get()!.n).toBe(before);
    expect(db.select().from(ingredients).where(eq(ingredients.normalizedName, 'milk')).get()?.status).toBe('categorized');
  });

  test('keeps device-only preferences with their values and drops every other device setting', () => {
    wipeLocalData();
    expect(deviceKeys()).toEqual(
      [
        AISLE_COLORS_KEY,
        BACKFILL_KEY,
        FOLD_ACCENTS_KEY,
        IMPORT_ADD_TO_LIST_KEY,
        ITEM_ROW_STYLE_KEY,
        KEEP_SCREEN_ON_KEY,
        SEED_KEY,
        UNITS_BACKFILL_KEY,
      ].sort(),
    );
    expect(getDeviceSetting(KEEP_SCREEN_ON_KEY, true)).toBe(false);
    expect(getDeviceSetting(ITEM_ROW_STYLE_KEY, null)).toBe('card');
    expect(getDeviceSetting(IMPORT_ADD_TO_LIST_KEY, false)).toBe(true);
    // Sync cursors, the HLC clock, push backoff, list state and the cached plan are gone.
    for (const key of ['sync.pull', 'sync.push', 'sync.clock', 'lastOpenedListId', viewModeKey(homeList), manualOrderKey(homeList), FEATURES_KEY]) {
      expect(getDeviceSetting(key, null)).toBeNull();
    }
  });

  test('deletes the list snapshot and empties both queues, leaving the native log', () => {
    wipeLocalData();
    expect(fs.existsSync(appGroup(LISTS_FILE))).toBe(false);
    expect(fs.readdirSync(appGroup(PENDING_DIR))).toEqual([]);
    expect(fs.readdirSync(appGroup(SHARE_PENDING_DIR))).toEqual([]);
    expect(fs.readFileSync(appGroup(LOG_FILE), 'utf8')).toBe('launched\n');
  });

  test('clears the plans store, invites, notifications and share queue status', () => {
    expect(getFeatures()).toEqual(['categorize', 'recipe_import']);
    expect(getMyInvites()).toHaveLength(1);
    expect(currentNotification()?.id).toBe('n1');

    wipeLocalData();

    expect(getFeatures()).toEqual(DEFAULT_FEATURES);
    expect(getMyInvites()).toEqual([]);
    expect(currentNotification()).toBeNull();
    expect(getShareQueueStatus()).toEqual({ queued: [], importing: null, waitReason: null });
  });

  test('running it twice is fine', () => {
    wipeLocalData();
    const keys = deviceKeys();
    expect(() => wipeLocalData()).not.toThrow();
    expect(deviceKeys()).toEqual(keys);
    expect(rowCount('households')).toBe(0);
    expect(db.select().from(categories).all()).toHaveLength(SYSTEM_CATEGORIES.length);
  });

  test('works without the App Group (Expo Go) and with no queue directories', () => {
    setAppGroupRoot(null);
    expect(() => wipeLocalData()).not.toThrow();
    expect(rowCount('lists')).toBe(0);

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wipe-empty-'));
    setAppGroupRoot(empty);
    expect(() => wipeLocalData()).not.toThrow();
    fs.rmSync(empty, { recursive: true, force: true });
  });

  test('a failed delete rolls the whole transaction back and touches nothing else', () => {
    // A row outside the schema that still points at the household makes its delete fail.
    sqlite.exec('create table blocker (household_id text references households(id))');
    sqlite.prepare('insert into blocker values (?)').run(home);
    try {
      expect(() => wipeLocalData()).toThrow(/FOREIGN KEY/);
      expect(db.select().from(lists).all()).toHaveLength(2);
      expect(rowCount('outbox')).toBeGreaterThan(0);
      expect(getDeviceSetting<string | null>('lastOpenedListId', null)).toBe(homeList);
      expect(fs.existsSync(appGroup(LISTS_FILE))).toBe(true);
      expect(fs.readdirSync(appGroup(PENDING_DIR))).toHaveLength(2);
      expect(getMyInvites()).toHaveLength(1);
      expect(getFeatures()).toEqual(['categorize', 'recipe_import']);
    } finally {
      sqlite.exec('drop table blocker');
    }
  });
});
