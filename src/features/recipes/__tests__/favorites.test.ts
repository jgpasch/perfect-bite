// Favorites per person (spec 4.14): the user's own through `setMyFavorite`, every current member's in
// `readRecipeFavorites`, and the VoiceOver label.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { and, eq } from 'drizzle-orm';

import { db, householdMemberNames, households, recipeFavorites, recipes } from '@/db';
import { initI18n } from '@/i18n';
import { purgeHousehold } from '@/sync/purge';
import { resetDb } from '@/test/db';
import { clearOutbox, outboxPatches, outboxRows } from '@/test/outbox';

import { favoriteLabel, favoritesByRecipe, isMyFavorite, readRecipeFavorites, setMyFavorite } from '../favorites';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
const mockAuth: { account: { userId: string } | null } = { account: { userId: 'me' } };
jest.mock('@/features/auth/account', () => ({ getAccount: () => mockAuth.account }));

const HOME = 'home';
const CABIN = 'cabin';

const member = (householdId: string, userId: string, firstName: string, lastName: string | null) =>
  db.insert(householdMemberNames).values({ householdId, userId, firstName, lastName, joinedAt: '2026-10-01T00:00:00Z' }).run();
const addRecipe = (id: string, householdId = HOME) => db.insert(recipes).values({ id, householdId, name: id }).run();
/** Another member's row, as a pull brings it. */
const theirs = (recipeId: string, userId: string, householdId = HOME, deletedAt: Date | null = null) =>
  db.insert(recipeFavorites).values({ recipeId, userId, householdId, deletedAt }).run();
const myRow = (recipeId: string) =>
  db
    .select()
    .from(recipeFavorites)
    .where(and(eq(recipeFavorites.recipeId, recipeId), eq(recipeFavorites.userId, 'me')))
    .get();

beforeEach(() => {
  resetDb();
  mockAuth.account = { userId: 'me' };
  db.insert(households).values([
    { id: HOME, name: 'Home' },
    { id: CABIN, name: 'Cabin' },
  ]).run();
  member(HOME, 'me', 'Jo', 'Doe');
  member(HOME, 'sam', 'Sam', 'Lee');
  member(HOME, 'ana', 'Ana', 'Ruiz');
  member(HOME, 'kim', 'Kim', 'Park');
  member(CABIN, 'me', 'Jo', 'Doe');
  member(CABIN, 'lou', 'Lou', 'Grant');
  addRecipe('tacos');
  addRecipe('soup');
  addRecipe('stew', CABIN);
});

afterEach(() => initI18n('en'));

describe('setMyFavorite', () => {
  test('set, unset and set again: one row, its deleted_at cleared, set, cleared; each through the outbox', () => {
    setMyFavorite('tacos', true);
    expect(myRow('tacos')).toMatchObject({ householdId: HOME, deletedAt: null });
    expect(isMyFavorite('tacos')).toBe(true);

    setMyFavorite('tacos', false);
    expect(myRow('tacos')!.deletedAt).toBeInstanceOf(Date);
    expect(isMyFavorite('tacos')).toBe(false);

    setMyFavorite('tacos', true);
    expect(myRow('tacos')!.deletedAt).toBeNull();
    expect(isMyFavorite('tacos')).toBe(true);
    expect(db.select().from(recipeFavorites).all()).toHaveLength(1);

    const key = { recipe_id: 'tacos', user_id: 'me' };
    const patches = outboxPatches();
    expect(patches).toEqual([
      // The insert carries the recipe's household; the server stamps created_at.
      { table: 'recipe_favorites', key, fields: { household_id: HOME, deleted_at: null } },
      { table: 'recipe_favorites', key, fields: { deleted_at: expect.any(String) } },
      { table: 'recipe_favorites', key, fields: { deleted_at: null } },
    ]);
    expect(outboxRows().map((r) => r.householdId)).toEqual([HOME, HOME, HOME]);
    // The later write wins: each clock moved on.
    expect(myRow('tacos')!.fieldClock.deleted_at).toBe(outboxRows()[2].mutation.hlc);
  });

  test('takes the recipe’s household', () => {
    setMyFavorite('stew', true);
    expect(myRow('stew')!.householdId).toBe(CABIN);
    expect(outboxRows()[0].householdId).toBe(CABIN);
  });

  test('no change writes nothing: unfavoriting one that isn’t, favoriting one that is', () => {
    setMyFavorite('tacos', false);
    expect(myRow('tacos')).toBeUndefined();
    expect(outboxRows()).toEqual([]);
    setMyFavorite('tacos', true);
    clearOutbox();
    setMyFavorite('tacos', true);
    expect(outboxRows()).toEqual([]);
  });

  test('only the user’s own row: another member’s stays as it was', () => {
    theirs('tacos', 'sam');
    setMyFavorite('tacos', true);
    setMyFavorite('tacos', false);
    const sams = db.select().from(recipeFavorites).where(eq(recipeFavorites.userId, 'sam')).get();
    expect(sams!.deletedAt).toBeNull();
    expect(outboxPatches().every((p) => p.key?.user_id === 'me')).toBe(true);
  });

  test('signed out, or a recipe this device doesn’t have: nothing', () => {
    mockAuth.account = null;
    setMyFavorite('tacos', true);
    expect(isMyFavorite('tacos')).toBe(false);
    mockAuth.account = { userId: 'me' };
    setMyFavorite('missing', true);
    expect(db.select().from(recipeFavorites).all()).toEqual([]);
    expect(outboxRows()).toEqual([]);
  });
});

describe('readRecipeFavorites', () => {
  test('mine, and other current members’ names A–Z, per recipe', () => {
    setMyFavorite('tacos', true);
    theirs('tacos', 'sam');
    theirs('soup', 'sam');
    theirs('soup', 'ana');
    theirs('stew', 'lou', CABIN);
    expect(readRecipeFavorites()).toEqual(
      new Map([
        ['tacos', { mine: true, others: ['Sam'] }],
        ['soup', { mine: false, others: ['Ana', 'Sam'] }],
        ['stew', { mine: false, others: ['Lou'] }],
      ]),
    );
  });

  test('unfavorited rows don’t count, and a recipe with none has no entry', () => {
    setMyFavorite('tacos', true);
    setMyFavorite('tacos', false);
    theirs('soup', 'sam', HOME, new Date());
    expect(readRecipeFavorites()).toEqual(new Map());
  });

  test('others’ rows count only for current members of the recipe’s household', () => {
    // Lou is in Cabin, not Home; Zed is in no household this device knows.
    theirs('tacos', 'lou');
    theirs('soup', 'zed');
    theirs('soup', 'kim');
    expect(readRecipeFavorites()).toEqual(new Map([['soup', { mine: false, others: ['Kim'] }]]));
  });

  test('a leaver’s row stops counting as soon as the member cache drops them; the others’ stay', () => {
    theirs('tacos', 'sam');
    theirs('tacos', 'ana');
    setMyFavorite('tacos', true);
    expect(readRecipeFavorites().get('tacos')).toEqual({ mine: true, others: ['Ana', 'Sam'] });
    db.delete(householdMemberNames)
      .where(and(eq(householdMemberNames.householdId, HOME), eq(householdMemberNames.userId, 'sam')))
      .run();
    expect(readRecipeFavorites().get('tacos')).toEqual({ mine: true, others: ['Ana'] });
  });

  test('a row naming another household than its recipe’s isn’t counted', () => {
    theirs('tacos', 'lou', CABIN);
    expect(readRecipeFavorites()).toEqual(new Map());
  });

  test('names as the household shows them: a shared first name gets the initial', () => {
    member(HOME, 'sam2', 'Sam', 'Ortiz');
    theirs('tacos', 'sam');
    theirs('tacos', 'sam2');
    expect(readRecipeFavorites().get('tacos')!.others).toEqual(['Sam L.', 'Sam O.']);
  });

  test('mine counts before the member cache is filled', () => {
    db.delete(householdMemberNames).run();
    setMyFavorite('tacos', true);
    theirs('tacos', 'sam');
    expect(readRecipeFavorites()).toEqual(new Map([['tacos', { mine: true, others: [] }]]));
  });

  test('signed out: no favorite is mine', () => {
    theirs('tacos', 'me');
    mockAuth.account = null;
    expect(favoritesByRecipe([{ recipeId: 'tacos', userId: 'me', householdId: HOME }], [], null)).toEqual(new Map());
  });

  test('leaving a household purges its favorites with it, the user’s and the others’', () => {
    setMyFavorite('stew', true);
    theirs('stew', 'lou', CABIN);
    setMyFavorite('tacos', true);
    db.transaction((tx) => purgeHousehold(tx, CABIN));
    expect(db.select().from(recipeFavorites).all().map((r) => r.recipeId)).toEqual(['tacos']);
    expect(outboxRows().map((r) => r.householdId)).toEqual([HOME]);
  });
});

describe('favoriteLabel', () => {
  test('English', () => {
    expect(favoriteLabel(true, [])).toBe('Your favorite');
    expect(favoriteLabel(true, ['Sam', 'Ana'])).toBe('Your favorite');
    expect(favoriteLabel(false, ['Sam'])).toBe("Sam's favorite");
    expect(favoriteLabel(false, ['Sam', 'Ana'])).toBe('Favorite of Sam and Ana');
    expect(favoriteLabel(false, ['Sam', 'Ana', 'Kim'])).toBe('Favorite of Sam and 2 others');
    expect(favoriteLabel(false, ['Sam', 'Ana', 'Kim', 'Lou'])).toBe('Favorite of Sam and 3 others');
    expect(favoriteLabel(false, [])).toBeNull();
  });

  test('Spanish', () => {
    initI18n('es');
    expect(favoriteLabel(true, ['Sam'])).toBe('Tu favorita');
    expect(favoriteLabel(false, ['Sam'])).toBe('Favorita de Sam');
    expect(favoriteLabel(false, ['Sam', 'Ana'])).toBe('Favorita de Sam y Ana');
    expect(favoriteLabel(false, ['Sam', 'Ana', 'Kim'])).toBe('Favorita de Sam y 2 más');
    expect(favoriteLabel(false, [])).toBeNull();
  });
});
