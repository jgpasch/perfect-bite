import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, households, ingredientUsage, lists } from '@/db';
import { loadCatalogSeed, searchCatalog } from '@/features/categories/categories';
import { resetDb } from '@/test/db';

import { addItem } from '../items';
import { ensureStarterData, getDefaultListId } from '../lists';
import { applySuggestion, getSuggestions, suggestionCaption } from '../suggestions';
import { hideFromSuggestions } from '../usage';

jest.mock('@/db/client', () => require('@/test/db'));

const USER = 'user-1';
let listId: string;
let householdId: string;

beforeEach(() => {
  resetDb();
  loadCatalogSeed();
  ensureStarterData(USER);
  listId = getDefaultListId(USER)!;
  householdId = db.select({ id: lists.householdId }).from(lists).where(eq(lists.id, listId)).get()!.id;
});

const catalog = (q: string, limit = 5) => searchCatalog(q, limit).map((r) => ({ ...r, source: 'catalog' }));

describe('getSuggestions (spec 4.2)', () => {
  test('with 2 or more history matches, shows only history', () => {
    addItem(listId, 'chicken thighs', USER);
    addItem(listId, 'chicken thighs', USER);
    addItem(listId, 'chicken breasts', USER);
    expect(getSuggestions(householdId, 'chi')).toEqual([
      { key: 'chicken thigh', displayName: 'chicken thighs', source: 'history' },
      { key: 'chicken breast', displayName: 'chicken breasts', source: 'history' },
    ]);
    // The catalog does have chicken salad; history keeps it out.
    expect(catalog('chi', 50).map((s) => s.displayName)).toContain('chicken salad');
  });

  test('history-only results are capped at the limit', () => {
    for (const name of ['chicken thighs', 'chicken breasts', 'chicken wings', 'chili flakes']) addItem(listId, name, USER);
    const out = getSuggestions(householdId, 'chi', 3);
    expect(out).toHaveLength(3);
    expect(out.every((s) => s.source === 'history')).toBe(true);
  });

  test('with one history match, the catalog fills the rest after it, deduped by key', () => {
    addItem(listId, 'chicken sausage from the butcher', USER);
    const out = getSuggestions(householdId, 'chick');
    expect(out[0]).toEqual({
      key: 'chicken sausage from the butcher',
      displayName: 'chicken sausage from the butcher',
      source: 'history',
    });
    expect(out.slice(1)).toEqual(catalog('chick').slice(0, 4));
    expect(out).toHaveLength(5);

    // A history entry the catalog also has appears once, as history.
    resetDb();
    loadCatalogSeed();
    ensureStarterData(USER);
    listId = getDefaultListId(USER)!;
    householdId = db.select({ id: lists.householdId }).from(lists).where(eq(lists.id, listId)).get()!.id;
    addItem(listId, 'Chickpeas', USER);
    const deduped = getSuggestions(householdId, 'chick');
    expect(deduped[0]).toEqual({ key: 'chickpea', displayName: 'Chickpeas', source: 'history' });
    expect(deduped.filter((s) => s.key === 'chickpea')).toHaveLength(1);
    expect(deduped.slice(1).every((s) => s.source === 'catalog')).toBe(true);
  });

  test('with no history, returns the catalog results unchanged', () => {
    const out = getSuggestions(householdId, 'chi');
    expect(out).toEqual(catalog('chi'));
    expect(out.map((s) => s.displayName)).toContain('chicken');
    expect(out.every((s) => s.source === 'catalog')).toBe(true);
  });

  test('history drops out as the user keeps typing, so catalog items still appear', () => {
    addItem(listId, 'chicken thighs', USER);
    addItem(listId, 'chicken breasts', USER);
    expect(getSuggestions(householdId, 'chickp')).toEqual([{ key: 'chickpea', displayName: 'chickpeas', source: 'catalog' }]);
  });

  test('`2 lbs chi` behaves the same as `chi`', () => {
    addItem(listId, 'chicken thighs', USER);
    addItem(listId, 'chicken breasts', USER);
    expect(getSuggestions(householdId, '2 lbs chi')).toEqual(getSuggestions(householdId, 'chi'));
    expect(getSuggestions(householdId, '2 lbs chi')).toHaveLength(2);
    // And with no history.
    expect(getSuggestions(householdId, '2 lbs zucc')).toEqual(getSuggestions(householdId, 'zucc'));
  });

  test('a history match identical to the typed name is still shown first', () => {
    addItem(listId, 'chicken', USER);
    const out = getSuggestions(householdId, 'Chicken');
    expect(out[0]).toEqual({ key: 'chicken', displayName: 'chicken', source: 'history' });
    expect(out.filter((s) => s.key === 'chicken')).toHaveLength(1);
    expect(out.slice(1).every((s) => s.source === 'catalog')).toBe(true);
  });

  test('a catalog suggestion identical to the typed name is skipped', () => {
    expect(catalog('chicken').map((s) => s.displayName)).toContain('chicken');
    expect(getSuggestions(householdId, 'chicken').map((s) => s.displayName)).not.toContain('chicken');
  });

  test('hidden history rows and other households are not history matches', () => {
    addItem(listId, 'chicken thighs', USER);
    addItem(listId, 'chicken breasts', USER);
    db.update(ingredientUsage).set({ hiddenAt: new Date() }).where(eq(ingredientUsage.ingredientName, 'chicken breast')).run();
    const out = getSuggestions(householdId, 'chi');
    expect(out[0]).toEqual({ key: 'chicken thigh', displayName: 'chicken thighs', source: 'history' });
    expect(out.slice(1).every((s) => s.source === 'catalog')).toBe(true);
    // The hidden key can still come back from the catalog.
    expect(getSuggestions(householdId, 'chicken bre')).toEqual([
      { key: 'chicken breast', displayName: 'chicken breasts', source: 'catalog' },
    ]);

    db.insert(households).values({ id: 'h-other', name: 'Other' }).run();
    expect(getSuggestions('h-other', 'chi')).toEqual(catalog('chi'));
  });

  test('returns [] for text shorter than 2 characters', () => {
    addItem(listId, 'chicken thighs', USER);
    expect(getSuggestions(householdId, 'c')).toEqual([]);
    expect(getSuggestions(householdId, '2 lbs c')).toEqual([]);
    expect(getSuggestions(householdId, '   ')).toEqual([]);
  });

  test('applySuggestion keeps the typed amount for either source', () => {
    addItem(listId, 'chicken thighs', USER);
    const [history] = getSuggestions(householdId, '2 lbs chi');
    expect(history.source).toBe('history');
    expect(applySuggestion('2 lbs chi', history)).toBe('2 lbs chicken thighs');
    const [catalogHit] = getSuggestions(householdId, '1 can chickp');
    expect(catalogHit.source).toBe('catalog');
    expect(applySuggestion('1 can chickp', catalogHit)).toBe('1 can chickpeas');
  });
});

describe('Remove from suggestions (spec 4.2)', () => {
  test('a hidden history row is excluded from getSuggestions', () => {
    addItem(listId, 'chicken thighs', USER);
    addItem(listId, 'chicken breasts', USER);
    addItem(listId, 'chili flakes', USER);
    hideFromSuggestions(householdId, 'chicken breast');
    const out = getSuggestions(householdId, 'chi');
    expect(out).toHaveLength(2);
    expect(out).toEqual(
      expect.arrayContaining([
        { key: 'chicken thigh', displayName: 'chicken thighs', source: 'history' },
        { key: 'chili flake', displayName: 'chili flakes', source: 'history' },
      ]),
    );
  });

  test('hiding drops history below 2, so the catalog fills in again', () => {
    addItem(listId, 'chicken thighs', USER);
    addItem(listId, 'chicken sausage from the butcher', USER);
    expect(getSuggestions(householdId, 'chi').every((s) => s.source === 'history')).toBe(true);
    hideFromSuggestions(householdId, 'chicken sausage from the butcher');
    const out = getSuggestions(householdId, 'chi');
    expect(out[0]).toEqual({ key: 'chicken thigh', displayName: 'chicken thighs', source: 'history' });
    expect(out.map((s) => s.key)).not.toContain('chicken sausage from the butcher');
    expect(out.slice(1)).toEqual(catalog('chi').filter((s) => s.key !== 'chicken thigh').slice(0, 4));
  });

  test('a hidden row comes back as history after a new use', () => {
    addItem(listId, 'chicken thighs', USER);
    addItem(listId, 'chicken breasts', USER);
    hideFromSuggestions(householdId, 'chicken thigh');
    expect(getSuggestions(householdId, 'chi').map((s) => s.key)).not.toContain('chicken thigh');

    addItem(listId, '2 lbs Chicken Thighs', USER);
    // Back with its 2 uses, so it ranks first again.
    expect(getSuggestions(householdId, 'chi')).toEqual([
      { key: 'chicken thigh', displayName: 'Chicken Thighs', source: 'history' },
      { key: 'chicken breast', displayName: 'chicken breasts', source: 'history' },
    ]);
  });

  test('hiding a key with no history row changes nothing', () => {
    hideFromSuggestions(householdId, 'chicken');
    expect(getSuggestions(householdId, 'chi')).toEqual(catalog('chi'));
    expect(db.select().from(ingredientUsage).all()).toEqual([]);
  });

  test('hiding in another household leaves this one alone', () => {
    db.insert(households).values({ id: 'h-other', name: 'Other' }).run();
    addItem(listId, 'chicken thighs', USER);
    addItem(listId, 'chicken breasts', USER);
    hideFromSuggestions('h-other', 'chicken thigh');
    expect(getSuggestions(householdId, 'chi').map((s) => s.key).sort()).toEqual(['chicken breast', 'chicken thigh']);
  });
});

describe('suggestionCaption (board 03)', () => {
  test('says YOU USUALLY BUY when household history leads', () => {
    addItem(listId, 'chicken thighs', USER);
    const suggestions = getSuggestions(householdId, 'chi');
    expect(suggestions[0].source).toBe('history');
    expect(suggestionCaption(suggestions)).toBe('YOU USUALLY BUY');
  });

  test('says SUGGESTIONS for catalog-only suggestions', () => {
    const suggestions = getSuggestions(householdId, 'chi');
    expect(suggestions.every((s) => s.source === 'catalog')).toBe(true);
    expect(suggestionCaption(suggestions)).toBe('SUGGESTIONS');
  });

  test('says SUGGESTIONS for none', () => {
    expect(suggestionCaption([])).toBe('SUGGESTIONS');
  });
});
