import { beforeEach, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import {
  categories,
  db,
  deviceSettings,
  householdCategoryOverrides,
  households,
  householdStaples,
  ingredientUnitUsage,
  ingredientUsage,
  ingredients,
  lists,
  recipes,
  userCategoryOrder,
  userSettings,
} from '@/db';
import { resetDb } from '@/test/db';
import { outboxMutations, outboxPatches, outboxRows } from '@/test/outbox';

import { getDeviceId, nextHlc, observeHlc } from '../clock';
import { compareHlc, parseHlc } from '../hlc';
import { deleteRows, insertRow, updateRows, upsertRow } from '../mutate';

jest.mock('@/db/client', () => require('@/test/db'));

const H = 'household-1';
const AT = new Date('2026-10-01T12:00:00.000Z');

beforeEach(() => {
  resetDb();
});

const addHousehold = () => insertRow(db, households, { id: H, name: 'Home', createdAt: AT });

test('insertRow writes the row, its clock and one mutation with every column', () => {
  addHousehold();
  const row = insertRow(db, lists, { id: 'l1', householdId: H, name: 'Groceries', position: 1, createdAt: AT });

  expect(row).toMatchObject({ id: 'l1', name: 'Groceries', emoji: null });
  const [householdMutation, listMutation] = outboxMutations();
  expect(householdMutation).toMatchObject({ table: 'households', id: H, fields: { name: 'Home', created_at: AT.toISOString() } });
  expect(listMutation.table).toBe('lists');
  expect(listMutation.id).toBe('l1');
  expect(listMutation.fields).toEqual({
    household_id: H,
    name: 'Groceries',
    emoji: null,
    color: null,
    position: 1,
    archived_at: null,
    deleted_at: null,
    created_at: AT.toISOString(),
  });
  expect(listMutation.counters).toBeUndefined();

  const stored = db.select().from(lists).where(eq(lists.id, 'l1')).get()!;
  expect(stored.fieldClock).toEqual(Object.fromEntries(Object.keys(listMutation.fields).map((f) => [f, listMutation.hlc])));
  // The outbox remembers the household, so a lost membership can drop its mutations.
  expect(outboxRows().map((r) => r.householdId)).toEqual([H, H]);
});

test('updateRows enqueues exactly the patched fields, one mutation per row', () => {
  addHousehold();
  insertRow(db, lists, { id: 'l1', householdId: H, name: 'A', position: 1 });
  insertRow(db, lists, { id: 'l2', householdId: H, name: 'B', position: 2 });
  const before = outboxMutations();

  const rows = updateRows(db, lists, eq(lists.householdId, H), { emoji: '🥕' });

  expect(rows.map((r) => r.id).sort()).toEqual(['l1', 'l2']);
  const added = outboxPatches().slice(before.length);
  expect(added).toEqual(
    expect.arrayContaining([
      { table: 'lists', id: 'l1', fields: { emoji: '🥕' } },
      { table: 'lists', id: 'l2', fields: { emoji: '🥕' } },
    ]),
  );
  expect(added).toHaveLength(2);

  // field_clock: emoji moves to the new HLC; the other fields keep the insert's.
  const update = outboxMutations().at(-1)!;
  const insert = before.find((m) => m.id === update.id)!;
  const clock = db.select().from(lists).where(eq(lists.id, update.id!)).get()!.fieldClock;
  expect(clock.emoji).toBe(update.hlc);
  expect(clock.name).toBe(insert.hlc);
  expect(compareHlc(update.hlc, insert.hlc)).toBeGreaterThan(0);
});

test('updateRows matching nothing writes nothing', () => {
  addHousehold();
  const count = outboxRows().length;
  expect(updateRows(db, lists, eq(lists.id, 'missing'), { name: 'X' })).toEqual([]);
  expect(outboxRows()).toHaveLength(count);
});

test('updateRows refuses keys, counters and server-owned fields', () => {
  addHousehold();
  expect(() => updateRows(db, lists, eq(lists.id, 'l1'), { id: 'other' })).toThrow("lists.id can't be patched");
  expect(() => updateRows(db, households, eq(households.id, H), { fieldClock: {} } as never)).toThrow(
    "households.fieldClock can't be patched",
  );
  expect(() =>
    updateRows(db, ingredientUsage, undefined, { useCount: 3 } as never),
  ).toThrow("ingredient_usage.useCount can't be patched");
  expect(() => updateRows(db, lists, undefined, {}, { useCount: 1 })).toThrow("lists.useCount isn't a counter");
});

test('a non-synced table is refused', () => {
  expect(() => insertRow(db, ingredients as never, { normalizedName: 'x', displayName: 'x' } as never)).toThrow(
    "ingredients isn't a synced table",
  );
});

test('usage rows use composite keys and send use_count as a counter', () => {
  addHousehold();
  const values = { householdId: H, ingredientName: 'milk', displayName: 'milk', lastUsedAt: AT };
  upsertRow(db, ingredientUsage, values, { displayName: 'Milk', lastUsedAt: AT }, { useCount: 1 });
  upsertRow(db, ingredientUsage, values, { displayName: 'Milk', lastUsedAt: AT }, { useCount: 1 });

  const [, insert, update] = outboxPatches();
  expect(insert).toEqual({
    table: 'ingredient_usage',
    key: { household_id: H, ingredient_name: 'milk' },
    fields: { display_name: 'milk', last_used_at: AT.toISOString(), hidden_at: null, created_at: expect.any(String) },
    counters: { use_count: 1 },
  });
  expect(update).toEqual({
    table: 'ingredient_usage',
    key: { household_id: H, ingredient_name: 'milk' },
    fields: { display_name: 'Milk', last_used_at: AT.toISOString() },
    counters: { use_count: 1 },
  });
  expect(db.select().from(ingredientUsage).get()).toMatchObject({ useCount: 2, displayName: 'Milk' });
});

test('a counter-only update sends no fields and leaves field_clock alone', () => {
  addHousehold();
  insertRow(db, ingredientUnitUsage, { householdId: H, ingredientName: 'milk', unitKey: 'gal', lastUsedAt: AT }, { useCount: 1 });
  const clock = db.select().from(ingredientUnitUsage).get()!.fieldClock;

  updateRows(db, ingredientUnitUsage, eq(ingredientUnitUsage.ingredientName, 'milk'), {}, { useCount: -1 });
  updateRows(db, ingredientUnitUsage, eq(ingredientUnitUsage.ingredientName, 'milk'), {}, { useCount: -1 });

  const patches = outboxPatches();
  expect(patches.at(-1)).toEqual({
    table: 'ingredient_unit_usage',
    key: { household_id: H, ingredient_name: 'milk', unit_key: 'gal' },
    fields: {},
    counters: { use_count: -1 },
  });
  // The local count stops at 0; the server adds the deltas up.
  expect(db.select().from(ingredientUnitUsage).get()).toMatchObject({ useCount: 0, fieldClock: clock });
});

test('per-user rows have no household and hard-delete with a delete mutation', () => {
  db.insert(categories).values({ id: 'produce', slug: 'produce', name: 'Produce' }).run();
  upsertRow(db, userSettings, { userId: 'u1', defaultListId: null }, { defaultListId: null });
  insertRow(db, userCategoryOrder, { userId: 'u1', categoryId: 'produce', position: 1 });

  expect(deleteRows(db, userCategoryOrder, eq(userCategoryOrder.userId, 'u1'))).toBe(1);

  expect(outboxPatches()).toEqual([
    { table: 'user_settings', key: { user_id: 'u1' }, fields: { default_list_id: null } },
    { table: 'user_category_order', key: { user_id: 'u1', category_id: 'produce' }, fields: { position: 1 } },
    { table: 'user_category_order', key: { user_id: 'u1', category_id: 'produce' }, fields: {}, delete: true },
  ]);
  expect(outboxRows().map((r) => r.householdId)).toEqual([null, null, null]);
  expect(db.select().from(userCategoryOrder).all()).toEqual([]);
});

test("a household's custom categories and overrides are household rows, keyed like the usage tables", () => {
  addHousehold();
  db.insert(categories).values({ id: 'produce', slug: 'produce', name: 'Produce', defaultRank: 0 }).run();
  insertRow(db, categories, { id: 'bulk', name: 'Bulk', householdId: H });
  upsertRow(db, householdCategoryOverrides, { householdId: H, ingredientName: 'milk', categoryId: 'bulk' }, { categoryId: 'bulk' });
  upsertRow(db, householdCategoryOverrides, { householdId: H, ingredientName: 'milk', categoryId: null }, { categoryId: null });

  expect(outboxPatches().slice(1)).toEqual([
    // A custom category never sends the system-only slug and rank.
    { table: 'categories', id: 'bulk', fields: { name: 'Bulk', household_id: H } },
    { table: 'household_category_overrides', key: { household_id: H, ingredient_name: 'milk' }, fields: { category_id: 'bulk' } },
    { table: 'household_category_overrides', key: { household_id: H, ingredient_name: 'milk' }, fields: { category_id: null } },
  ]);
  expect(outboxRows().map((r) => r.householdId)).toEqual([H, H, H, H]);
  // Reset keeps the row, with a null category and its clock.
  const override = db.select().from(householdCategoryOverrides).get()!;
  expect(override).toMatchObject({ householdId: H, ingredientName: 'milk', categoryId: null });
  expect(override.fieldClock.category_id).toBe(outboxMutations().at(-1)!.hlc);
  expect(() => updateRows(db, categories, eq(categories.id, 'bulk'), { defaultRank: 3 })).toThrow(
    "categories.defaultRank can't be patched",
  );
});

test('staples are household rows by key: unmark sets deleted_at, mark again clears it, created_by never goes up', () => {
  addHousehold();
  const key = { household_id: H, ingredient_name: 'salt' };
  const values = { householdId: H, ingredientName: 'salt', createdBy: 'u1', deletedAt: null };
  upsertRow(db, householdStaples, values, { deletedAt: null });
  upsertRow(db, householdStaples, values, { deletedAt: AT });
  upsertRow(db, householdStaples, values, { deletedAt: null });

  expect(outboxPatches().slice(1)).toEqual([
    { table: 'household_staples', key, fields: { deleted_at: null } },
    { table: 'household_staples', key, fields: { deleted_at: AT.toISOString() } },
    { table: 'household_staples', key, fields: { deleted_at: null } },
  ]);
  expect(outboxRows().map((r) => r.householdId)).toEqual([H, H, H, H]);
  const [mark, unmark, remark] = outboxMutations().slice(1);
  expect(compareHlc(unmark.hlc, mark.hlc)).toBeGreaterThan(0);
  expect(compareHlc(remark.hlc, unmark.hlc)).toBeGreaterThan(0);

  // One row, marked again, with deleted_at at the latest HLC; created_by stays local.
  const rows = db.select().from(householdStaples).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ householdId: H, ingredientName: 'salt', createdBy: 'u1', deletedAt: null });
  expect(rows[0].fieldClock).toEqual({ deleted_at: remark.hlc });
  expect(() => updateRows(db, householdStaples, eq(householdStaples.householdId, H), { createdBy: 'u2' })).toThrow(
    "household_staples.createdBy can't be patched",
  );
});

test('a failed insert leaves neither the row nor a mutation', () => {
  // No household: the list's foreign key fails.
  expect(() => insertRow(db, lists, { id: 'l1', householdId: 'missing', name: 'A', position: 1 })).toThrow();
  expect(db.select().from(lists).all()).toEqual([]);
  expect(outboxRows()).toEqual([]);
});

test('a failure later in the caller’s transaction rolls back the row, its clock and its mutation', () => {
  addHousehold();
  const before = outboxRows().length;
  const clockBefore = db.select().from(deviceSettings).where(eq(deviceSettings.key, 'sync.clock')).get();
  expect(() =>
    db.transaction((tx) => {
      updateRows(tx, households, eq(households.id, H), { name: 'Renamed' });
      throw new Error('boom');
    }),
  ).toThrow('boom');
  expect(db.select().from(households).get()!.name).toBe('Home');
  expect(outboxRows()).toHaveLength(before);
  expect(db.select().from(deviceSettings).where(eq(deviceSettings.key, 'sync.clock')).get()).toEqual(clockBefore);
});

test('HLCs from this device are increasing and carry its device id', () => {
  addHousehold();
  for (let i = 0; i < 5; i++) updateRows(db, households, eq(households.id, H), { name: `Home ${i}` });
  const hlcs = outboxMutations().map((m) => m.hlc);
  const device = getDeviceId();
  for (let i = 1; i < hlcs.length; i++) expect(compareHlc(hlcs[i], hlcs[i - 1])).toBeGreaterThan(0);
  for (const hlc of hlcs) expect(parseHlc(hlc)!.device).toBe(device);
});

test('the clock adopts a larger remote HLC and ignores older or malformed ones', () => {
  const device = getDeviceId();
  observeHlc('9999999999998-0007-other');
  expect(nextHlc()).toBe(`9999999999998-0008-${device}`);
  observeHlc('1000000000000-0000-other');
  observeHlc('not an hlc');
  expect(nextHlc()).toBe(`9999999999998-0009-${device}`);
});

test('the device id is stable', () => {
  const device = getDeviceId();
  nextHlc();
  expect(getDeviceId()).toBe(device);
  expect(nextHlc().endsWith(`-${device}`)).toBe(true);
});

test('deleteRows only enqueues rows it removed', () => {
  expect(deleteRows(db, userCategoryOrder, eq(userCategoryOrder.userId, 'nobody'))).toBe(0);
  expect(outboxRows()).toEqual([]);
});

test('a recipe insert sends its tags, tags_edited and total_minutes but never added_by (spec 4.14)', () => {
  addHousehold();
  const tags = { saved: ['favorite'], meal: ['dinner'], cuisine: [], protein: ['beef'], diet: [], method: ['grill'] };
  const row = insertRow(db, recipes, {
    id: 'r1',
    householdId: H,
    name: 'Burgers',
    tags,
    totalMinutes: 40,
    addedBy: 'u-local',
    createdAt: AT,
  });

  expect(row).toMatchObject({ tags, tagsEdited: false, totalMinutes: 40, addedBy: 'u-local' });
  const mutation = outboxMutations().at(-1)!;
  expect(mutation.fields).toEqual({
    household_id: H,
    name: 'Burgers',
    notes: null,
    source_url: null,
    tags,
    tags_edited: false,
    total_minutes: 40,
    steps: null,
    servings: null,
    image_url: null,
    deleted_at: null,
    created_at: AT.toISOString(),
  });
  expect(db.select().from(recipes).where(eq(recipes.id, 'r1')).get()!.fieldClock).not.toHaveProperty('added_by');
});

test('an untagged recipe insert sends null tags and time', () => {
  addHousehold();
  insertRow(db, recipes, { id: 'r1', householdId: H, name: 'Soup' });

  expect(outboxMutations().at(-1)!.fields).toMatchObject({ tags: null, tags_edited: false, total_minutes: null });
});

test('a recipe insert sends its steps, servings and image_url (spec 5)', () => {
  addHousehold();
  const steps = ['Brown the beef.', 'Add the beans and simmer for 20 minutes.'];
  insertRow(db, recipes, {
    id: 'r1',
    householdId: H,
    name: 'Chili',
    steps,
    servings: 6,
    imageUrl: 'https://example.com/chili.jpg',
  });

  const row = db.select().from(recipes).where(eq(recipes.id, 'r1')).get()!;
  expect(row).toMatchObject({ steps, servings: 6, imageUrl: 'https://example.com/chili.jpg' });
  expect(Object.keys(row.fieldClock)).toEqual(expect.arrayContaining(['steps', 'servings', 'image_url']));
  expect(outboxMutations().at(-1)!.fields).toMatchObject({
    steps,
    servings: 6,
    image_url: 'https://example.com/chili.jpg',
  });
});

test('a recipe without steps, servings or a photo sends nulls', () => {
  addHousehold();
  insertRow(db, recipes, { id: 'r1', householdId: H, name: 'Soup' });

  expect(outboxMutations().at(-1)!.fields).toMatchObject({ steps: null, servings: null, image_url: null });
});

test('a recipe update sends only the steps, servings or image_url it changed', () => {
  addHousehold();
  insertRow(db, recipes, { id: 'r1', householdId: H, name: 'Soup', servings: 2 });

  updateRows(db, recipes, eq(recipes.id, 'r1'), { steps: ['Simmer.'] });
  expect(outboxPatches().at(-1)).toEqual({ table: 'recipes', id: 'r1', fields: { steps: ['Simmer.'] } });

  updateRows(db, recipes, eq(recipes.id, 'r1'), { servings: 4, imageUrl: 'https://example.com/soup.png' });
  expect(outboxPatches().at(-1)).toEqual({
    table: 'recipes',
    id: 'r1',
    fields: { servings: 4, image_url: 'https://example.com/soup.png' },
  });

  updateRows(db, recipes, eq(recipes.id, 'r1'), { steps: null, servings: null, imageUrl: null });
  expect(outboxPatches().at(-1)).toEqual({
    table: 'recipes',
    id: 'r1',
    fields: { steps: null, servings: null, image_url: null },
  });
  expect(db.select().from(recipes).where(eq(recipes.id, 'r1')).get()).toMatchObject({
    steps: null,
    servings: null,
    imageUrl: null,
  });
});

test("a recipe tags update sends exactly the tag fields; added_by can't be patched", () => {
  addHousehold();
  insertRow(db, recipes, { id: 'r1', householdId: H, name: 'Soup' });
  const tags = { saved: [], meal: ['lunch'], cuisine: [], protein: [], diet: ['vegan'], method: [] };

  updateRows(db, recipes, eq(recipes.id, 'r1'), { tags, tagsEdited: true, totalMinutes: null });

  expect(outboxPatches().at(-1)).toEqual({
    table: 'recipes',
    id: 'r1',
    fields: { tags, tags_edited: true, total_minutes: null },
  });
  expect(db.select().from(recipes).where(eq(recipes.id, 'r1')).get()).toMatchObject({ tags, tagsEdited: true });
  expect(() => updateRows(db, recipes, eq(recipes.id, 'r1'), { addedBy: 'someone' })).toThrow(
    "recipes.addedBy can't be patched",
  );
});
