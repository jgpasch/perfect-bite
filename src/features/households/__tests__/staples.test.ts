import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, householdStaples, households, ingredientUsage, outbox } from '@/db';
import { getDefaultListId, ensureStarterData, getList } from '@/features/lists/lists';
import { i18n } from '@/i18n';
import { resetDb } from '@/test/db';

import {
  addStapleFromText,
  alwaysHaveFootnote,
  isStaple,
  setStaple,
  stapleKeyFromText,
  stapleNames,
  staplesCountLabel,
  staplesQuery,
  stapleToast,
} from '../staples';

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

describe('alwaysHaveFootnote', () => {
  test('names the household, or says "your household" without a name', () => {
    expect(alwaysHaveFootnote('Home')).toBe('Left off when you add a recipe. Changes it for everyone in Home.');
    expect(alwaysHaveFootnote(' Home ')).toBe('Left off when you add a recipe. Changes it for everyone in Home.');
    expect(alwaysHaveFootnote(null)).toBe('Left off when you add a recipe. Changes it for everyone in your household.');
    expect(alwaysHaveFootnote('  ')).toBe('Left off when you add a recipe. Changes it for everyone in your household.');
  });
});

describe('stapleToast', () => {
  test('marked or unmarked, with the household on a second line and the name in bold', () => {
    expect(stapleToast(CABIN, 'salt', true)).toEqual({
      message: 'Added Salt to Always have\nFor everyone in Cabin',
      emphasis: 'Salt',
    });
    expect(stapleToast(CABIN, 'olive oil', false)).toEqual({
      message: 'Removed Olive oil from Always have\nFor everyone in Cabin',
      emphasis: 'Olive oil',
    });
  });

  test('a blank or missing household name reads "your household", and a padded one is trimmed', () => {
    db.update(households).set({ name: '  ' }).where(eq(households.id, CABIN)).run();
    expect(stapleToast(CABIN, 'salt', true).message).toBe('Added Salt to Always have\nFor everyone in your household');
    expect(stapleToast('nope', 'salt', false).message).toBe('Removed Salt from Always have\nFor everyone in your household');
    db.update(households).set({ name: ' Cabin ' }).where(eq(households.id, CABIN)).run();
    expect(stapleToast(CABIN, 'salt', true).message).toBe('Added Salt to Always have\nFor everyone in Cabin');
  });

  test('in Spanish', async () => {
    await i18n.changeLanguage('es');
    try {
      expect(stapleToast(CABIN, 'sal', true).message).toBe('Se agregó Sal a Siempre tengo\nPara todos en Cabin');
      expect(stapleToast('nope', 'sal', false).message).toBe('Se quitó Sal de Siempre tengo\nPara todos en tu hogar');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('stapleKeyFromText and addStapleFromText', () => {
  test('reads the name as the add bar does, amount ignored', () => {
    expect(stapleKeyFromText('salt')).toBe('salt');
    expect(stapleKeyFromText('  Salt ')).toBe('salt');
    expect(stapleKeyFromText('2 tbsp Olive oils')).toBe('olive oil');
    expect(stapleKeyFromText('1 1/2 cups flour')).toBe('flour');
    expect(stapleKeyFromText('   ')).toBeNull();
  });

  test('marks the key for the household; one already marked writes nothing', () => {
    expect(addStapleFromText(home, '2 tbsp Olive oils', USER)).toBe('olive oil');
    expect(isStaple(home, 'olive oil')).toBe(true);
    expect(isStaple(CABIN, 'olive oil')).toBe(false);
    const start = outboxCount();
    expect(addStapleFromText(home, 'olive oil', USER)).toBe('olive oil');
    expect(outboxCount()).toBe(start);
    expect(staplesQuery(home).all()).toHaveLength(1);
  });

  test('marks an unmarked one again', () => {
    setStaple(home, 'salt', true, USER);
    setStaple(home, 'salt', false, USER);
    addStapleFromText(home, 'Salt', USER);
    expect(isStaple(home, 'salt')).toBe(true);
  });

  test('text with no name marks nothing', () => {
    const start = outboxCount();
    expect(addStapleFromText(home, '  ', USER)).toBeNull();
    expect(addStapleFromText(home, '', USER)).toBeNull();
    expect(outboxCount()).toBe(start);
    expect(staplesQuery(home).all()).toEqual([]);
  });
});

describe('staplesCountLabel', () => {
  test('"None" with none, else the count', () => {
    expect(staplesCountLabel(0)).toBe('None');
    expect(staplesCountLabel(1)).toBe('1');
    expect(staplesCountLabel(12)).toBe('12');
  });
});
