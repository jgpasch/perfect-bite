// Recipe collections: create, rename and delete (names unique per household ignoring case and accents),
// putting recipes in and out one at a time or in a batch, and the live lists (counts ignoring deleted
// recipes, the cover, a recipe's collections).
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { and, eq } from 'drizzle-orm';

import { db, households, recipeCollectionRecipes, recipeCollections, recipes } from '@/db';
import { purgeHousehold } from '@/sync/purge';
import { resetDb } from '@/test/db';
import { clearOutbox, outboxPatches } from '@/test/outbox';

import {
  addRecipesToCollection,
  collectionNameProblem,
  CollectionNameError,
  collectionSummaries,
  createCollection,
  deleteCollection,
  readHouseholdCollections,
  readRecipeCollections,
  renameCollection,
  setRecipeInCollection,
} from '../collections';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));

const HOME = 'home';
const CABIN = 'cabin';

const addRecipe = (id: string, name: string, householdId = HOME, extra: Partial<typeof recipes.$inferInsert> = {}) =>
  db.insert(recipes).values({ id, householdId, name, ...extra }).run();
const collectionRow = (id: string) => db.select().from(recipeCollections).where(eq(recipeCollections.id, id)).get();
const membership = (collectionId: string, recipeId: string) =>
  db
    .select()
    .from(recipeCollectionRecipes)
    .where(and(eq(recipeCollectionRecipes.collectionId, collectionId), eq(recipeCollectionRecipes.recipeId, recipeId)))
    .get();
/** Thrown by `fn`, for checking a `CollectionNameError`'s fields. */
const thrown = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('nothing thrown');
};

beforeEach(() => {
  resetDb();
  db.insert(households).values([
    { id: HOME, name: 'Home' },
    { id: CABIN, name: 'Cabin' },
  ]).run();
  addRecipe('tacos', 'Tacos', HOME, { photoPath: 'home/tacos/a.jpg' });
  addRecipe('soup', 'Soup', HOME, { imageUrl: 'https://example.com/soup.jpg' });
  addRecipe('chili', 'Chili');
  addRecipe('bread', 'Bread');
  addRecipe('apple', 'Apple pie');
  addRecipe('stew', 'Stew', CABIN);
});

describe('createCollection', () => {
  test('writes a live collection with the cleaned name, and queues it without created_by', () => {
    const id = createCollection(HOME, "  Mom's   cookbook ");

    expect(collectionRow(id)).toMatchObject({ householdId: HOME, name: "Mom's cookbook", createdBy: null, deletedAt: null });
    const patches = outboxPatches();
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ table: 'recipe_collections', id });
    expect(Object.keys(patches[0].fields).sort()).toEqual(['created_at', 'deleted_at', 'household_id', 'name']);
    expect(patches[0].fields).toMatchObject({ household_id: HOME, name: "Mom's cookbook", deleted_at: null });
  });

  test('refuses a name the household already has, ignoring case and accents, and writes nothing', () => {
    createCollection(HOME, 'Crème brûlée');
    clearOutbox();

    const error = thrown(() => createCollection(HOME, ' creme BRULEE ')) as CollectionNameError;

    expect(error).toBeInstanceOf(CollectionNameError);
    expect(error.problem).toBe('duplicate');
    expect(error.name).toBe('creme BRULEE');
    expect(db.select().from(recipeCollections).all()).toHaveLength(1);
    expect(outboxPatches()).toEqual([]);
  });

  test("another household's name, or a deleted collection's, is free", () => {
    createCollection(CABIN, 'Weeknights');
    const old = createCollection(HOME, 'Soups');
    deleteCollection(old);

    expect(() => createCollection(HOME, 'Weeknights')).not.toThrow();
    expect(() => createCollection(HOME, 'soups')).not.toThrow();
    expect(db.select().from(recipeCollections).all()).toHaveLength(4);
  });

  test('refuses an empty name and one over 40 characters; 40 is fine, counting characters', () => {
    expect((thrown(() => createCollection(HOME, '   ')) as CollectionNameError).problem).toBe('empty');
    expect((thrown(() => createCollection(HOME, 'x'.repeat(41))) as CollectionNameError).problem).toBe('tooLong');
    expect(() => createCollection(HOME, '🍰'.repeat(40))).not.toThrow();
    expect(db.select().from(recipeCollections).all()).toHaveLength(1);
  });
});

describe('collectionNameProblem', () => {
  test('null for a free name; each problem otherwise; the renamed one itself is no duplicate', () => {
    const id = createCollection(HOME, 'Kid favorites');

    expect(collectionNameProblem(HOME, 'Date night')).toBeNull();
    expect(collectionNameProblem(HOME, '')).toBe('empty');
    expect(collectionNameProblem(HOME, 'a'.repeat(41))).toBe('tooLong');
    expect(collectionNameProblem(HOME, 'KID  FAVORITES')).toBe('duplicate');
    expect(collectionNameProblem(HOME, 'kid favorites', id)).toBeNull();
    expect(collectionNameProblem(CABIN, 'Kid favorites')).toBeNull();
  });
});

describe('renameCollection', () => {
  test('sets the cleaned name as one LWW field', () => {
    const id = createCollection(HOME, 'Soups');
    clearOutbox();

    renameCollection(id, ' Soups & stews ');

    expect(collectionRow(id)!.name).toBe('Soups & stews');
    expect(outboxPatches()).toEqual([{ table: 'recipe_collections', id, fields: { name: 'Soups & stews' } }]);
  });

  test("its own name in another case is fine; the same name writes nothing; another's is refused", () => {
    const id = createCollection(HOME, 'Soups');
    createCollection(HOME, 'Salads');
    clearOutbox();

    renameCollection(id, 'Soups');
    expect(outboxPatches()).toEqual([]);

    renameCollection(id, 'SOUPS');
    expect(collectionRow(id)!.name).toBe('SOUPS');

    const error = thrown(() => renameCollection(id, 'salads')) as CollectionNameError;
    expect(error.problem).toBe('duplicate');
    expect(collectionRow(id)!.name).toBe('SOUPS');
    expect(outboxPatches()).toHaveLength(1);
  });

  test('an unknown collection: no write', () => {
    renameCollection('nope', 'Anything');
    expect(outboxPatches()).toEqual([]);
  });
});

describe('deleteCollection', () => {
  test('soft-deletes it once, keeps its memberships, and drops it from the lists', () => {
    const id = createCollection(HOME, 'Soups');
    setRecipeInCollection('soup', id, true);
    clearOutbox();

    deleteCollection(id);
    deleteCollection(id);

    expect(collectionRow(id)!.deletedAt).toBeInstanceOf(Date);
    expect(membership(id, 'soup')!.deletedAt).toBeNull();
    expect(outboxPatches()).toEqual([
      { table: 'recipe_collections', id, fields: { deleted_at: collectionRow(id)!.deletedAt!.toISOString() } },
    ]);
    expect(readHouseholdCollections(HOME)).toEqual([]);
    expect(readRecipeCollections('soup')).toEqual([]);
  });
});

describe('setRecipeInCollection', () => {
  test('add, remove and add again: one row, deleted_at cleared, set, cleared; each through the outbox', () => {
    const id = createCollection(HOME, 'Soups');
    clearOutbox();

    setRecipeInCollection('soup', id, true);
    const added = membership(id, 'soup')!;
    expect(added).toMatchObject({ householdId: HOME, deletedAt: null });
    expect(added.addedAt).toBeInstanceOf(Date);

    setRecipeInCollection('soup', id, false);
    const removedAt = membership(id, 'soup')!.deletedAt;
    expect(removedAt).toBeInstanceOf(Date);

    setRecipeInCollection('soup', id, true);
    expect(membership(id, 'soup')!.deletedAt).toBeNull();

    const key = { collection_id: id, recipe_id: 'soup' };
    expect(outboxPatches()).toEqual([
      {
        table: 'recipe_collection_recipes',
        key,
        fields: { household_id: HOME, added_at: added.addedAt.toISOString(), deleted_at: null },
      },
      { table: 'recipe_collection_recipes', key, fields: { deleted_at: removedAt!.toISOString() } },
      { table: 'recipe_collection_recipes', key, fields: { deleted_at: null } },
    ]);
  });

  test('no change writes nothing: adding twice, or removing one that was never in', () => {
    const id = createCollection(HOME, 'Soups');
    setRecipeInCollection('soup', id, true);
    clearOutbox();

    setRecipeInCollection('soup', id, true);
    setRecipeInCollection('tacos', id, false);

    expect(outboxPatches()).toEqual([]);
    expect(membership(id, 'tacos')).toBeUndefined();
  });

  test("an unknown collection writes nothing; another household's recipe is refused", () => {
    const id = createCollection(HOME, 'Soups');
    clearOutbox();

    setRecipeInCollection('soup', 'nope', true);
    expect(() => setRecipeInCollection('stew', id, true)).toThrow("a collection only takes its own household's recipes");

    expect(db.select().from(recipeCollectionRecipes).all()).toEqual([]);
    expect(outboxPatches()).toEqual([]);
  });
});

describe('addRecipesToCollection', () => {
  test('adds every one not already in, restoring a removed one, in one go; returns how many', () => {
    const id = createCollection(HOME, 'Weeknights');
    setRecipeInCollection('tacos', id, true);
    setRecipeInCollection('soup', id, true);
    setRecipeInCollection('soup', id, false);
    clearOutbox();

    expect(addRecipesToCollection(id, ['tacos', 'soup', 'chili', 'chili'])).toBe(2);

    expect(readHouseholdCollections(HOME)[0]).toMatchObject({ name: 'Weeknights', recipeCount: 3 });
    expect(outboxPatches().map((p) => [p.key, p.fields.deleted_at])).toEqual([
      [{ collection_id: id, recipe_id: 'soup' }, null],
      [{ collection_id: id, recipe_id: 'chili' }, null],
    ]);
  });

  test('nothing to add returns 0 and writes nothing', () => {
    const id = createCollection(HOME, 'Weeknights');
    setRecipeInCollection('tacos', id, true);
    clearOutbox();

    expect(addRecipesToCollection(id, [])).toBe(0);
    expect(addRecipesToCollection(id, ['tacos'])).toBe(0);
    expect(addRecipesToCollection('nope', ['soup'])).toBe(0);
    expect(outboxPatches()).toEqual([]);
  });

  test("one recipe from another household, or an unknown one, refuses the whole batch", () => {
    const id = createCollection(HOME, 'Weeknights');
    clearOutbox();

    expect(() => addRecipesToCollection(id, ['tacos', 'stew'])).toThrow();
    expect(() => addRecipesToCollection(id, ['tacos', 'ghost'])).toThrow();

    expect(db.select().from(recipeCollectionRecipes).all()).toEqual([]);
    expect(outboxPatches()).toEqual([]);
  });
});

describe('readHouseholdCollections', () => {
  test("A–Z, with live recipes counted, the cover's first four A–Z, and only this household's", () => {
    const weeknights = createCollection(HOME, 'weeknights');
    const baking = createCollection(HOME, 'Baking');
    const empty = createCollection(HOME, 'Ábuela');
    createCollection(CABIN, 'Cabin food');
    addRecipesToCollection(weeknights, ['tacos', 'soup', 'chili', 'bread', 'apple']);
    addRecipesToCollection(baking, ['bread']);

    const list = readHouseholdCollections(HOME);

    expect(list.map((c) => [c.id, c.name, c.recipeCount])).toEqual([
      [empty, 'Ábuela', 0],
      [baking, 'Baking', 1],
      [weeknights, 'weeknights', 5],
    ]);
    expect(list[2].householdId).toBe(HOME);
    expect(list[2].cover).toEqual([
      { id: 'apple', name: 'Apple pie', photoPath: null, imageUrl: null },
      { id: 'bread', name: 'Bread', photoPath: null, imageUrl: null },
      { id: 'chili', name: 'Chili', photoPath: null, imageUrl: null },
      { id: 'soup', name: 'Soup', photoPath: null, imageUrl: 'https://example.com/soup.jpg' },
    ]);
    expect(list[0].cover).toEqual([]);
  });

  test("a deleted recipe isn't counted or shown, and comes back when it's restored", () => {
    const id = createCollection(HOME, 'Mexican');
    addRecipesToCollection(id, ['tacos', 'chili']);

    db.update(recipes).set({ deletedAt: new Date() }).where(eq(recipes.id, 'tacos')).run();
    expect(readHouseholdCollections(HOME)[0]).toMatchObject({ recipeCount: 1, cover: [{ id: 'chili' }] });
    expect(readRecipeCollections('chili')).toEqual([{ id, name: 'Mexican' }]);

    db.update(recipes).set({ deletedAt: null }).where(eq(recipes.id, 'tacos')).run();
    expect(readHouseholdCollections(HOME)[0].recipeCount).toBe(2);
    expect(readHouseholdCollections(HOME)[0].cover.map((r) => r.id)).toEqual(['chili', 'tacos']);
  });

  test('a removed recipe is not counted', () => {
    const id = createCollection(HOME, 'Mexican');
    addRecipesToCollection(id, ['tacos', 'chili']);
    setRecipeInCollection('tacos', id, false);

    expect(readHouseholdCollections(HOME)[0].recipeCount).toBe(1);
  });
});

describe('collectionSummaries', () => {
  test('ties in name order by id; members of collections not listed are ignored', () => {
    const recipe = { id: 'r', name: 'R', photoPath: null, imageUrl: null };
    expect(
      collectionSummaries(
        [
          { id: 'b', householdId: HOME, name: 'Same' },
          { id: 'a', householdId: HOME, name: 'same' },
        ],
        [{ collectionId: 'gone', ...recipe }, { collectionId: 'b', ...recipe }],
      ).map((c) => [c.id, c.recipeCount]),
    ).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });
});

describe('readRecipeCollections', () => {
  test('the live collections a recipe is in, A–Z; none gives an empty list', () => {
    const kids = createCollection(HOME, 'Kid favorites');
    const mom = createCollection(HOME, "Mom's cookbook");
    const other = createCollection(HOME, 'Other');
    setRecipeInCollection('tacos', mom, true);
    setRecipeInCollection('tacos', kids, true);
    setRecipeInCollection('tacos', other, true);
    setRecipeInCollection('tacos', other, false);

    expect(readRecipeCollections('tacos')).toEqual([
      { id: kids, name: 'Kid favorites' },
      { id: mom, name: "Mom's cookbook" },
    ]);
    expect(readRecipeCollections('soup')).toEqual([]);
  });
});

describe('leaving a household', () => {
  test("purging it removes its collections and memberships and keeps the other household's", () => {
    const home = createCollection(HOME, 'Soups');
    setRecipeInCollection('soup', home, true);
    const cabin = createCollection(CABIN, 'Stews');
    setRecipeInCollection('stew', cabin, true);

    db.transaction((tx) => purgeHousehold(tx, HOME));

    expect(db.select({ id: recipeCollections.id }).from(recipeCollections).all()).toEqual([{ id: cabin }]);
    expect(db.select({ id: recipeCollectionRecipes.recipeId }).from(recipeCollectionRecipes).all()).toEqual([{ id: 'stew' }]);
  });
});
