// Recipes (spec 4.5): local reads, and writes through the sync helpers (outbox, spec 7.1).
import { and, asc, desc, eq, isNotNull, isNull, max, sql } from 'drizzle-orm';

import { db, households, listItemContributions, listItems, lists, recipeIngredients, recipes, type Recipe } from '@/db';
import { positionBetween } from '@/domain/position';
import { ensureLocalIngredient } from '@/features/categories/categories';
import { recordUsage } from '@/features/lists/usage';
import { newId } from '@/lib/id';
import { normalizeIngredientName, parseQuantity } from '@/shared';
import { insertRow, updateRows } from '@/sync/mutate';

import { orderByLastUse } from './recipe-view';

const liveRecipe = isNull(recipes.deletedAt);
const liveIngredient = isNull(recipeIngredients.deletedAt);

/** The household new recipes go in. M7 asks which household when there is more than one. */
function currentHouseholdId(): string {
  const row = db.select({ id: households.id }).from(households).orderBy(asc(households.createdAt)).get();
  if (!row) throw new Error('No household yet (ensureStarterData has not run)');
  return row.id;
}

/** Live recipes, most recently updated first, each with its household and ingredient count. */
export function recipesQuery() {
  return db
    .select({
      id: recipes.id,
      name: recipes.name,
      householdId: recipes.householdId,
      householdName: households.name,
      updatedAt: recipes.updatedAt,
      ingredientCount: sql<number>`count(${recipeIngredients.id})`,
    })
    .from(recipes)
    .innerJoin(households, eq(households.id, recipes.householdId))
    .leftJoin(recipeIngredients, and(eq(recipeIngredients.recipeId, recipes.id), liveIngredient))
    .where(liveRecipe)
    .groupBy(recipes.id)
    .orderBy(desc(recipes.updatedAt), asc(recipes.name));
}
export type RecipeSummary = Awaited<ReturnType<typeof recipesQuery>>[number];

/**
 * Each recipe amount on an open (unchecked) item of a live, unarchived list, with the list's name
 * and when it was added, for the "On Groceries" badge (pick one per recipe with `onListByRecipe`).
 */
export function recipesOnListsQuery() {
  return db
    .select({
      recipeId: sql<string>`${listItemContributions.recipeId}`,
      listName: lists.name,
      addedAt: listItemContributions.createdAt,
    })
    .from(listItemContributions)
    .innerJoin(
      listItems,
      and(eq(listItems.id, listItemContributions.listItemId), isNull(listItems.deletedAt), isNull(listItems.checkedAt)),
    )
    .innerJoin(lists, and(eq(lists.id, listItems.listId), isNull(lists.deletedAt), isNull(lists.archivedAt)))
    .where(and(isNotNull(listItemContributions.recipeId), isNull(listItemContributions.deletedAt)));
}

/** Tables the recipes tab reads (`recipesQuery`, `recipesOnListsQuery`), for `useLiveQueryOn`. */
export const RECIPES_TAB_TABLES = [recipes, recipeIngredients, households, listItemContributions, listItems, lists];

/**
 * The "Add to recipe" sheet's recipes (spec 4.5): the household's live recipes with their
 * ingredient count, most recently used first (`orderByLastUse`).
 */
export function recipesForPicker(householdId: string): RecipeSummary[] {
  const all = recipesQuery()
    .all()
    .filter((r) => r.householdId === householdId);
  return orderByLastUse(all, recipeAddTimes(householdId));
}

/** Each time one of the household's recipes was added to a list: one per recipe contribution. */
export function recipeAddTimes(householdId: string): { recipeId: string; at: Date }[] {
  return db
    .select({ recipeId: sql<string>`${listItemContributions.recipeId}`, at: listItemContributions.createdAt })
    .from(listItemContributions)
    .where(and(isNotNull(listItemContributions.recipeId), eq(listItemContributions.householdId, householdId)))
    .all();
}

export function recipeQuery(id: string) {
  return db.select().from(recipes).where(and(eq(recipes.id, id), liveRecipe));
}

export function getRecipe(id: string): Recipe | undefined {
  return recipeQuery(id).get();
}

export function recipeIngredientsQuery(recipeId: string) {
  return db
    .select()
    .from(recipeIngredients)
    .where(and(eq(recipeIngredients.recipeId, recipeId), liveIngredient))
    .orderBy(asc(recipeIngredients.position));
}

function cleanName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!trimmed) throw new Error('A recipe needs a name');
  return trimmed;
}

/** A new recipe in `householdId` (by default the first household; M7 asks which). */
export function createRecipe(name: string, householdId: string = currentHouseholdId()): string {
  const id = newId();
  insertRow(db, recipes, { id, householdId, name: cleanName(name) });
  return id;
}

export type RecipeEdit = { name: string; notes: string; sourceUrl: string };

export function updateRecipe(id: string, edit: RecipeEdit): void {
  updateRows(db, recipes, eq(recipes.id, id), {
    name: cleanName(edit.name),
    notes: edit.notes.trim() || null,
    sourceUrl: edit.sourceUrl.trim() || null,
  });
}

/**
 * Deletes a recipe. Its list items stay; their amounts from it become "no recipe" (spec 4.5),
 * so they show under Other items in the By recipe view.
 */
export function deleteRecipe(id: string): void {
  db.transaction((tx) => {
    updateRows(tx, recipes, eq(recipes.id, id), { deletedAt: new Date() });
    updateRows(tx, listItemContributions, eq(listItemContributions.recipeId, id), { recipeId: null });
  });
}

/**
 * Marks the recipe as just changed, so it sorts first. Local only, not a mutation: `updated_at`
 * is server-set (spec 7.1).
 */
function touch(recipeId: string) {
  db.update(recipes).set({ updatedAt: new Date() }).where(eq(recipes.id, recipeId)).run();
}

function nextPosition(recipeId: string): number {
  const last = db
    .select({ position: max(recipeIngredients.position) })
    .from(recipeIngredients)
    .where(and(eq(recipeIngredients.recipeId, recipeId), liveIngredient))
    .get();
  return positionBetween(last?.position ?? null, null);
}

/**
 * Adds an ingredient with the same parser as lists (spec 4.5): `2 cups flour`. A recipe can list
 * the same ingredient twice (e.g. butter for the crust and the filling). Returns null for empty
 * text; else the new row's id, and the name if this add recorded it as pending (for `categorizePending`).
 */
export function addRecipeIngredient(recipeId: string, text: string): { id: string; pendingNames: string[] } | null {
  const { quantity, unit, name } = parseQuantity(text);
  const ingredientName = normalizeIngredientName(name);
  if (!ingredientName) return null;
  const recipe = getRecipe(recipeId);
  if (!recipe) throw new Error(`No recipe ${recipeId}`);
  const id = newId();
  const pendingNames = db.transaction((tx) => {
    insertRow(tx, recipeIngredients, {
      id,
      recipeId,
      householdId: recipe.householdId,
      ingredientName,
      displayName: name,
      quantity,
      unit,
      position: nextPosition(recipeId),
    });
    recordUsage(tx, recipe.householdId, ingredientName, name, new Date(), { quantity, unit });
    return ensureLocalIngredient(tx, ingredientName, name) ? [ingredientName] : [];
  });
  touch(recipeId);
  return { id, pendingNames };
}

/**
 * Adds ingredients that are already parsed (from list items, "Make recipe...", spec 4.5). Returns
 * the names it recorded as pending, for `categorizePending`.
 */
export function addParsedRecipeIngredients(
  recipeId: string,
  items: readonly { ingredientName: string; displayName: string; quantity: number | null; unit: RecipeIngredientUnit }[],
): string[] {
  const recipe = getRecipe(recipeId);
  if (!recipe) throw new Error(`No recipe ${recipeId}`);
  const pendingNames: string[] = [];
  db.transaction((tx) => {
    let position = nextPosition(recipeId);
    const now = new Date();
    for (const item of items) {
      insertRow(tx, recipeIngredients, { id: newId(), recipeId, householdId: recipe.householdId, ...item, position });
      recordUsage(tx, recipe.householdId, item.ingredientName, item.displayName, now, {
        quantity: item.quantity,
        unit: item.unit ?? null,
      });
      if (ensureLocalIngredient(tx, item.ingredientName, item.displayName)) pendingNames.push(item.ingredientName);
      position = positionBetween(position, null);
    }
  });
  touch(recipeId);
  return pendingNames;
}
type RecipeIngredientUnit = (typeof recipeIngredients.$inferInsert)['unit'];

/**
 * Replaces an ingredient's name and amount from text, as typed: `3 cups flour`. An edit isn't a
 * use, so history isn't counted. Returns the name if the edit recorded it as pending.
 */
export function updateRecipeIngredient(id: string, text: string, note = ''): string[] {
  const { quantity, unit, name } = parseQuantity(text);
  const ingredientName = normalizeIngredientName(name);
  if (!ingredientName) throw new Error('An ingredient needs a name');
  return db.transaction((tx) => {
    updateRows(tx, recipeIngredients, eq(recipeIngredients.id, id), {
      ingredientName,
      displayName: name,
      quantity,
      unit,
      note: note.trim() || null,
    });
    return ensureLocalIngredient(tx, ingredientName, name) ? [ingredientName] : [];
  });
}

export function deleteRecipeIngredient(id: string): void {
  updateRows(db, recipeIngredients, eq(recipeIngredients.id, id), { deletedAt: new Date() });
}

export function undeleteRecipeIngredient(id: string): void {
  updateRows(db, recipeIngredients, eq(recipeIngredients.id, id), { deletedAt: null });
}
