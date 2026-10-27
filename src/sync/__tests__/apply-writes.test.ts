// The share/import write planner's writes run on the device (`applyWrites`): each becomes a local
// row write and its outbox mutation, as any other local write.
import { beforeEach, expect, jest, test } from '@jest/globals';
import { and, eq } from 'drizzle-orm';

import { db, households, ingredientUnitUsage, ingredientUsage, listItems, lists, outbox } from '@/db';
import type { Write } from '@/shared/domain/list-plan';
import { resetDb } from '@/test/db';
import { clearOutbox, outboxMutations, outboxPatches } from '@/test/outbox';

import { applyWrites } from '../apply-writes';
import { insertRow } from '../mutate';

jest.mock('@/db/client', () => require('@/test/db'));

const H = 'household-1';
const L = 'list-1';
const AT = '2026-10-01T12:00:00.000Z';

beforeEach(() => {
  resetDb();
  insertRow(db, households, { id: H, name: 'Home' });
  insertRow(db, lists, { id: L, householdId: H, name: 'Groceries', position: 1 });
  clearOutbox();
});

const itemInsert = (id: string, name: string): Write => ({
  op: 'insert',
  table: 'list_items',
  id,
  fields: { list_id: L, household_id: H, ingredient_name: name, display_name: name, checked_at: null },
});

const usage = (name: string) =>
  db
    .select()
    .from(ingredientUsage)
    .where(and(eq(ingredientUsage.householdId, H), eq(ingredientUsage.ingredientName, name)))
    .get();

test('an insert writes the row from wire columns and enqueues it with its id', () => {
  applyWrites(db, [itemInsert('i1', 'milk')]);

  const row = db.select().from(listItems).where(eq(listItems.id, 'i1')).get()!;
  expect(row).toMatchObject({ listId: L, householdId: H, ingredientName: 'milk', displayName: 'milk', checkedAt: null });
  const [mutation] = outboxPatches();
  expect(mutation).toMatchObject({ table: 'list_items', id: 'i1' });
  expect(mutation.fields).toMatchObject({ list_id: L, household_id: H, ingredient_name: 'milk', display_name: 'milk' });
  expect(mutation.key).toBeUndefined();
});

test('ISO strings for date columns become Dates locally and go back out as the same ISO string', () => {
  applyWrites(db, [itemInsert('i1', 'milk'), { op: 'update', table: 'list_items', id: 'i1', fields: { checked_at: AT } }]);

  expect(db.select().from(listItems).where(eq(listItems.id, 'i1')).get()!.checkedAt).toEqual(new Date(AT));
  expect(outboxPatches()[1]).toEqual({ table: 'list_items', id: 'i1', fields: { checked_at: AT } });
});

test('an update patches exactly its fields', () => {
  applyWrites(db, [itemInsert('i1', 'milk'), itemInsert('i2', 'eggs')]);
  clearOutbox();

  applyWrites(db, [{ op: 'update', table: 'list_items', id: 'i2', fields: { display_name: 'Eggs', note: 'a dozen' } }]);

  expect(db.select().from(listItems).where(eq(listItems.id, 'i2')).get()).toMatchObject({ displayName: 'Eggs', note: 'a dozen' });
  expect(db.select().from(listItems).where(eq(listItems.id, 'i1')).get()!.displayName).toBe('milk');
  expect(outboxPatches()).toEqual([{ table: 'list_items', id: 'i2', fields: { display_name: 'Eggs', note: 'a dozen' } }]);
});

test('an upsert by composite key inserts, then updates with its counters adding up', () => {
  const write: Write = {
    op: 'upsert',
    table: 'ingredient_usage',
    key: { household_id: H, ingredient_name: 'milk' },
    fields: { display_name: 'Milk', last_used_at: AT },
    counters: { use_count: 1 },
  };

  applyWrites(db, [write]);
  expect(usage('milk')).toMatchObject({ displayName: 'Milk', useCount: 1, lastUsedAt: new Date(AT) });

  applyWrites(db, [{ ...write, fields: { display_name: 'milk', last_used_at: AT }, counters: { use_count: 2 } }]);
  expect(usage('milk')).toMatchObject({ displayName: 'milk', useCount: 3 });

  const [inserted, updated] = outboxPatches();
  expect(inserted).toMatchObject({
    table: 'ingredient_usage',
    key: { household_id: H, ingredient_name: 'milk' },
    counters: { use_count: 1 },
  });
  expect(inserted.fields).toMatchObject({ display_name: 'Milk', last_used_at: AT });
  expect(updated).toEqual({
    table: 'ingredient_usage',
    key: { household_id: H, ingredient_name: 'milk' },
    fields: { display_name: 'milk', last_used_at: AT },
    counters: { use_count: 2 },
  });
});

test('a three-column key reaches the right row', () => {
  const unit = (unitKey: string, delta: number): Write => ({
    op: 'upsert',
    table: 'ingredient_unit_usage',
    key: { household_id: H, ingredient_name: 'milk', unit_key: unitKey },
    fields: { last_used_at: AT },
    counters: { use_count: delta },
  });
  applyWrites(db, [unit('l', 1), unit('cup', 1), unit('l', 4)]);

  const counts = db
    .select({ unit: ingredientUnitUsage.unitKey, count: ingredientUnitUsage.useCount })
    .from(ingredientUnitUsage)
    .all()
    .sort((a, b) => a.unit.localeCompare(b.unit));
  expect(counts).toEqual([
    { unit: 'cup', count: 1 },
    { unit: 'l', count: 5 },
  ]);
});

test('writes run in order, one mutation each, with increasing HLCs', () => {
  applyWrites(db, [
    itemInsert('i1', 'milk'),
    { op: 'update', table: 'list_items', id: 'i1', fields: { note: 'oat' } },
    itemInsert('i2', 'eggs'),
  ]);

  const mutations = outboxMutations();
  expect(mutations.map((m) => [m.id, Object.keys(m.fields).includes('note') && m.fields.note])).toEqual([
    ['i1', null],
    ['i1', 'oat'],
    ['i2', null],
  ]);
  const hlcs = mutations.map((m) => m.hlc);
  expect([...hlcs].sort()).toEqual(hlcs);
  expect(new Set(hlcs).size).toBe(3);
});

test('no writes, nothing written', () => {
  applyWrites(db, []);
  expect(outboxMutations()).toEqual([]);
});

test('an unknown column throws and writes none of the batch', () => {
  expect(() =>
    applyWrites(db, [itemInsert('i1', 'milk'), { op: 'update', table: 'list_items', id: 'i1', fields: { colour: 'red' } }]),
  ).toThrow('No column list_items.colour for a planned write');
  expect(db.select().from(listItems).all()).toEqual([]);
  expect(db.select().from(outbox).all()).toEqual([]);
});

test('an unknown table throws and writes none of the batch', () => {
  expect(() =>
    applyWrites(db, [itemInsert('i1', 'milk'), { op: 'insert', table: 'lists' as Write['table'], id: 'x', fields: {} }]),
  ).toThrow('No table lists for a planned write');
  expect(db.select().from(listItems).all()).toEqual([]);
  expect(outboxMutations()).toEqual([]);
});

test("inside the caller's transaction, a later failure there rolls the writes back", () => {
  expect(() =>
    db.transaction((tx) => {
      applyWrites(tx, [itemInsert('i1', 'milk')]);
      throw new Error('commit check failed');
    }),
  ).toThrow('commit check failed');
  expect(db.select().from(listItems).all()).toEqual([]);
  expect(outboxMutations()).toEqual([]);
});

test('an update matching no row writes nothing', () => {
  applyWrites(db, [{ op: 'update', table: 'list_items', id: 'missing', fields: { note: 'x' } }]);
  expect(outboxMutations()).toEqual([]);
});
