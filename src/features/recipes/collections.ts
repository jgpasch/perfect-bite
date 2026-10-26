// Recipe collections: a named set of recipes owned by a household and shared by every member; a
// recipe can be in any number of them. They sit beside tags and Saved and replace neither. Household
// data synced like the favorites (7.3): a collection's name and `deleted_at`, and a membership's
// `deleted_at`, are last-writer-wins. Deleting a collection leaves its memberships (ignored while
// it's deleted), and a deleted recipe's memberships stay, so restoring either brings them back.
// Free on every plan, with no limit.
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { useMemo } from 'react';

import { db, recipeCollectionRecipes, recipeCollections, recipes } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { newId } from '@/lib/id';
import { foldAccents } from '@/shared/ingredient-normalizer';
import type { Exec } from '@/sync/clock';
import { insertRow, updateRows, upsertRow } from '@/sync/mutate';

import { compareRecipeNames, sortRecipesByName } from './recipe-sort';

/** The longest name, in characters. */
export const COLLECTION_NAME_MAX = 40;

/** Why a name can't be used: none, over `COLLECTION_NAME_MAX`, or a live collection of the household has it. */
export type CollectionNameProblem = 'empty' | 'tooLong' | 'duplicate';

/** A refused name; `name` is the cleaned one (for "There's already a collection called …"). */
export class CollectionNameError extends Error {
  constructor(
    readonly problem: CollectionNameProblem,
    readonly name: string,
  ) {
    super(`collection name ${problem}: ${name}`);
  }
}

/** A recipe on a collection's cover: its photo (own, else the site's), or neither for the aisle-colour tile. */
export type CollectionCoverRecipe = { id: string; name: string; photoPath: string | null; imageUrl: string | null };

/** A live collection, with its live recipes' count and the first four of them A–Z for the cover. */
export type CollectionSummary = {
  id: string;
  householdId: string;
  name: string;
  recipeCount: number;
  cover: CollectionCoverRecipe[];
};

/** A collection a recipe is in. */
export type RecipeCollection = { id: string; name: string };

/** Tables the live queries read, for `useLiveQueryOn`. */
export const COLLECTIONS_QUERY_TABLES = [recipeCollections, recipeCollectionRecipes, recipes];

/** Trimmed, inner whitespace collapsed. */
const cleanName = (name: string) => name.trim().replace(/\s+/g, ' ');

/** How names compare for duplicates: ignoring case and accents. */
const nameKey = (name: string) => foldAccents(name).toLocaleLowerCase();

/** A collection, live or deleted; undefined when there's none. */
function collectionOf(exec: Exec, id: string) {
  return exec.select().from(recipeCollections).where(eq(recipeCollections.id, id)).get();
}

/**
 * What's wrong with `name` for a collection of the household, or null when it can be used. A live
 * collection with the same name, ignoring case and accents, makes it a duplicate, except `exceptId`
 * (the one being renamed).
 */
export function collectionNameProblem(
  householdId: string,
  name: string,
  exceptId?: string,
  exec: Exec = db,
): CollectionNameProblem | null {
  const cleaned = cleanName(name);
  if (!cleaned) return 'empty';
  if ([...cleaned].length > COLLECTION_NAME_MAX) return 'tooLong';
  const key = nameKey(cleaned);
  const taken = exec
    .select({ id: recipeCollections.id, name: recipeCollections.name })
    .from(recipeCollections)
    .where(and(eq(recipeCollections.householdId, householdId), isNull(recipeCollections.deletedAt)))
    .all()
    .some((c) => c.id !== exceptId && nameKey(c.name) === key);
  return taken ? 'duplicate' : null;
}

function checkName(householdId: string, name: string, exceptId?: string, exec: Exec = db): string {
  const cleaned = cleanName(name);
  const problem = collectionNameProblem(householdId, cleaned, exceptId, exec);
  if (problem) throw new CollectionNameError(problem, cleaned);
  return cleaned;
}

/** A new collection for the household; returns its id. Throws `CollectionNameError` for a name it can't take. */
export function createCollection(householdId: string, name: string): string {
  return db.transaction((tx) => {
    const cleaned = checkName(householdId, name, undefined, tx);
    const id = newId();
    insertRow(tx, recipeCollections, { id, householdId, name: cleaned });
    return id;
  });
}

/**
 * Renames a collection. Throws `CollectionNameError` for a name it can't take (its own name in
 * another case is fine). The same name, or no such collection: no write.
 */
export function renameCollection(id: string, name: string): void {
  db.transaction((tx) => {
    const collection = collectionOf(tx, id);
    if (!collection) return;
    const cleaned = checkName(collection.householdId, name, id, tx);
    if (cleaned === collection.name) return;
    updateRows(tx, recipeCollections, eq(recipeCollections.id, id), { name: cleaned });
  });
}

/** Deletes a collection (soft: its memberships stay, ignored while it's deleted). Already deleted: no write. */
export function deleteCollection(id: string): void {
  updateRows(db, recipeCollections, and(eq(recipeCollections.id, id), isNull(recipeCollections.deletedAt)), {
    deletedAt: new Date(),
  });
}

/** The recipes' household, checked against the collection's: they're filed in their own household only. */
function householdFor(tx: Exec, collectionId: string, recipeIds: readonly string[]): string | null {
  const collection = collectionOf(tx, collectionId);
  if (!collection) return null;
  const found = tx
    .select({ id: recipes.id, householdId: recipes.householdId })
    .from(recipes)
    .where(inArray(recipes.id, [...recipeIds]))
    .all();
  if (found.length !== new Set(recipeIds).size || found.some((r) => r.householdId !== collection.householdId)) {
    throw new Error("a collection only takes its own household's recipes");
  }
  return collection.householdId;
}

/** The recipe's membership row in the collection, live or removed. */
function membershipOf(tx: Exec, collectionId: string, recipeId: string) {
  return tx
    .select({ deletedAt: recipeCollectionRecipes.deletedAt })
    .from(recipeCollectionRecipes)
    .where(and(eq(recipeCollectionRecipes.collectionId, collectionId), eq(recipeCollectionRecipes.recipeId, recipeId)))
    .get();
}

/** Puts one recipe in the collection, or takes it out again. */
function setMembership(tx: Exec, householdId: string, collectionId: string, recipeId: string, on: boolean): boolean {
  const row = membershipOf(tx, collectionId, recipeId);
  if ((row !== undefined && row.deletedAt === null) === on) return false;
  const deletedAt = on ? null : new Date();
  upsertRow(tx, recipeCollectionRecipes, { collectionId, recipeId, householdId, deletedAt }, { deletedAt });
  return true;
}

/**
 * Puts a recipe in a collection (`on`) or takes it out. Taking it out sets `deleted_at` and putting it
 * back clears it. No change, or no such collection: no write. Throws for a recipe of another household.
 */
export function setRecipeInCollection(recipeId: string, collectionId: string, on: boolean): void {
  db.transaction((tx) => {
    const householdId = householdFor(tx, collectionId, [recipeId]);
    if (householdId) setMembership(tx, householdId, collectionId, recipeId, on);
  });
}

/**
 * Adds recipes to a collection in one transaction, skipping ones already in it. Returns how many were
 * added. Throws (writing none) for a recipe of another household.
 */
export function addRecipesToCollection(collectionId: string, recipeIds: readonly string[]): number {
  if (recipeIds.length === 0) return 0;
  return db.transaction((tx) => {
    const householdId = householdFor(tx, collectionId, recipeIds);
    if (!householdId) return 0;
    let added = 0;
    for (const recipeId of new Set(recipeIds)) {
      if (setMembership(tx, householdId, collectionId, recipeId, true)) added++;
    }
    return added;
  });
}

// --- Reading -----------------------------------------------------------------------------------

function householdCollectionsQuery(householdId: string) {
  return db
    .select({ id: recipeCollections.id, householdId: recipeCollections.householdId, name: recipeCollections.name })
    .from(recipeCollections)
    .where(and(eq(recipeCollections.householdId, householdId), isNull(recipeCollections.deletedAt)));
}

/** The household's live memberships whose recipe is live, with what the cover shows. */
function householdMembersQuery(householdId: string) {
  return db
    .select({
      collectionId: recipeCollectionRecipes.collectionId,
      id: recipes.id,
      name: recipes.name,
      photoPath: recipes.photoPath,
      imageUrl: recipes.imageUrl,
    })
    .from(recipeCollectionRecipes)
    .innerJoin(recipes, eq(recipes.id, recipeCollectionRecipes.recipeId))
    .where(
      and(
        eq(recipeCollectionRecipes.householdId, householdId),
        isNull(recipeCollectionRecipes.deletedAt),
        isNull(recipes.deletedAt),
      ),
    );
}

type CollectionRow = { id: string; householdId: string; name: string };
type MemberRow = CollectionCoverRecipe & { collectionId: string };

/** The collections A–Z (ties by id), each with its recipes' count and its first four recipes A–Z. */
export function collectionSummaries(collections: readonly CollectionRow[], members: readonly MemberRow[]): CollectionSummary[] {
  const byCollection = new Map<string, CollectionCoverRecipe[]>();
  for (const { collectionId, ...recipe } of members) {
    byCollection.set(collectionId, [...(byCollection.get(collectionId) ?? []), recipe]);
  }
  return [...collections]
    .sort((a, b) => compareRecipeNames(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => {
      const inIt = sortRecipesByName(byCollection.get(c.id) ?? []);
      return { id: c.id, householdId: c.householdId, name: c.name, recipeCount: inIt.length, cover: inIt.slice(0, 4) };
    });
}

/** The household's live collections A–Z (read once). */
export function readHouseholdCollections(householdId: string): CollectionSummary[] {
  return collectionSummaries(householdCollectionsQuery(householdId).all(), householdMembersQuery(householdId).all());
}

/** The household's live collections A–Z (live). */
export function useHouseholdCollections(householdId: string): CollectionSummary[] {
  const { data: collections } = useLiveQueryOn(householdCollectionsQuery(householdId), COLLECTIONS_QUERY_TABLES, [householdId]);
  const { data: members } = useLiveQueryOn(householdMembersQuery(householdId), COLLECTIONS_QUERY_TABLES, [householdId]);
  return useMemo(() => collectionSummaries(collections, members), [collections, members]);
}

function recipeCollectionsQuery(recipeId: string) {
  return db
    .select({ id: recipeCollections.id, name: recipeCollections.name })
    .from(recipeCollectionRecipes)
    .innerJoin(recipeCollections, eq(recipeCollections.id, recipeCollectionRecipes.collectionId))
    .where(
      and(
        eq(recipeCollectionRecipes.recipeId, recipeId),
        isNull(recipeCollectionRecipes.deletedAt),
        isNull(recipeCollections.deletedAt),
      ),
    );
}

/** The live collections a recipe is in, A–Z (read once). */
export function readRecipeCollections(recipeId: string): RecipeCollection[] {
  return sortRecipesByName(recipeCollectionsQuery(recipeId).all());
}

/** The live collections a recipe is in, A–Z (live). */
export function useRecipeCollections(recipeId: string): RecipeCollection[] {
  const { data } = useLiveQueryOn(recipeCollectionsQuery(recipeId), COLLECTIONS_QUERY_TABLES, [recipeId]);
  return useMemo(() => sortRecipesByName(data), [data]);
}
