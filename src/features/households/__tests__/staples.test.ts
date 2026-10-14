import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, householdStaples, households, ingredientUsage, outbox } from '@/db';
import { getDefaultListId, ensureStarterData, getList } from '@/features/lists/lists';
import { resetDb } from '@/test/db';

import { isStaple, setStaple, stapleNames, staplesQuery } from '../staples';

jest.mock('@/db/client', () => require('@/test/db'));

const USER = 'user-1';
const CABIN = 'cabin';
let home: string;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  home = getList(getDefaultListId(USER)!)!.householdId;
  db.insert(households).values({ id: CABIN, name: 'Cabin' }).run();
});

const row = (householdId: string, ingredientName: string) =>
  db
    .select()
    .from(householdStaples)
    .where(eq(householdStaples.householdId, householdId))
    .all()
    .find((r) => r.ingredientName === ingredientName);
const outboxCount = () => db.select().from(outbox).all().length;

describe('setStaple and isStaple', () => {
  test('marks an ingredient for the household, set by the caller', () => {
    expect(isStaple(home, 'salt')).toBe(false);
    setStaple(home, 'salt', true, USER);
    expect(isStaple(home, 'salt')).toBe(true);
    expect(row(home, 'salt')).toMatchObject({ createdBy: USER, deletedAt: null });
  });

  test('unmarking sets deleted_at; marking again clears it', () => {
    setStaple(home, 'salt', true, USER);
    setStaple(home, 'salt', false, USER);
    expect(isStaple(home, 'salt')).toBe(false);
    expect(row(home, 'salt')!.deletedAt).toBeInstanceOf(Date);
    setStaple(home, 'salt', true, 'user-2');
    expect(isStaple(home, 'salt')).toBe(true);
    expect(row(home, 'salt')!.deletedAt).toBeNull();
    // The first marker stays: only `deleted_at` changes on a re-mark.
    expect(row(home, 'salt')!.createdBy).toBe(USER);
  });

  test('each change goes through the outbox; one that changes nothing writes nothing', () => {
    const start = outboxCount();
    setStaple(home, 'salt', true, USER);
    expect(outboxCount()).toBe(start + 1);
    setStaple(home, 'salt', true, USER);
    expect(outboxCount()).toBe(start + 1);
    setStaple(home, 'salt', false, USER);
    expect(outboxCount()).toBe(start + 2);
    setStaple(home, 'salt', false, USER);
    expect(outboxCount()).toBe(start + 2);
  });

  test('unmarking an ingredient that was never marked creates no row', () => {
    setStaple(home, 'pepper', false, USER);
    expect(row(home, 'pepper')).toBeUndefined();
  });

  test('matches by key exactly: `sea salt` is not `salt`', () => {
    setStaple(home, 'salt', true, USER);
    expect(isStaple(home, 'sea salt')).toBe(false);
  });

  test("another household's staples don't count", () => {
    setStaple(CABIN, 'salt', true, USER);
    expect(isStaple(home, 'salt')).toBe(false);
    expect(isStaple(CABIN, 'salt')).toBe(true);
    expect(stapleNames(home)).toEqual(new Set());
  });
});

describe('stapleNames', () => {
  test("is the household's marked keys, without unmarked ones", () => {
    setStaple(home, 'salt', true, USER);
    setStaple(home, 'black pepper', true, USER);
    setStaple(home, 'water', true, USER);
    setStaple(home, 'water', false, USER);
    setStaple(CABIN, 'olive oil', true, USER);
    expect(stapleNames(home)).toEqual(new Set(['salt', 'black pepper']));
    expect(stapleNames(CABIN)).toEqual(new Set(['olive oil']));
  });
});

describe('staplesQuery', () => {
  test("lists live staples by display name, the household's own text when it has one, else the key", () => {
    db.insert(ingredientUsage)
      .values([
        { householdId: home, ingredientName: 'olive oil', displayName: 'Extra virgin olive oil', lastUsedAt: new Date() },
        // Another household's text for the same key isn't used.
        { householdId: CABIN, ingredientName: 'salt', displayName: 'Kosher salt', lastUsedAt: new Date() },
      ])
      .run();
    for (const name of ['salt', 'olive oil', 'black pepper', 'water']) setStaple(home, name, true, USER);
    setStaple(home, 'water', false, USER);
    setStaple(CABIN, 'garlic', true, USER);
    expect(staplesQuery(home).all()).toEqual([
      { ingredientName: 'black pepper', displayName: 'black pepper' },
      { ingredientName: 'olive oil', displayName: 'Extra virgin olive oil' },
      { ingredientName: 'salt', displayName: 'salt' },
    ]);
  });

  test('is empty for a household with none', () => {
    setStaple(CABIN, 'salt', true, USER);
    expect(staplesQuery(home).all()).toEqual([]);
  });
});
