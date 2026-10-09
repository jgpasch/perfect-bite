// Recipes (spec 4.5): local reads and writes. M5 adds the outbox write beside each of these.
import { and, asc, desc, eq, isNull, max, sql } from 'drizzle-orm';

import { db, households, listItemContributions, recipeIngredients, recipes, type Recipe } from '@/db';
import { positionBetween } from '@/domain/position';
import { ensureLocalIngredient } from '@/features/categories/categories';
import { recordUsage } from '@/features/lists/usage';
import { newId } from '@/lib/id';
import { normalizeIngredientName, parseQuantity } from '@/shared';

const liveRecipe = isNull(recipes.deletedAt);
const liveIngredient = isNull(recipeIngredients.deletedAt);

/** The household new recipes go in. M7 asks which household when there is more than one. */
function currentHouseholdId(): string {
  const row = db.select({ id: households.id }).from(households).orderBy(asc(households.createdAt)).get();
  if (!row) throw new Error('No household yet (ensureStarterData has not run)');
  return row.id;
}

/** Live recipes, most recently updated first, each with its ingredient count. */
export function recipesQuery() {
  return db
    .select({
      id: recipes.id,
      name: recipes.name,
      updatedAt: recipes.updatedAt,
      ingredientCount: sql<number>`count(${recipeIngredients.id})`,
    })
    .from(recipes)
    .leftJoin(recipeIngredients, and(eq(recipeIngredients.recipeId, recipes.id), liveIngredient))
    .where(liveRecipe)
    .groupBy(recipes.id)
    .orderBy(desc(recipes.updatedAt), asc(recipes.name));
}
export type RecipeSummary = Awaited<ReturnType<typeof recipesQuery>>[number];

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

export function createRecipe(name: string): string {
  const id = newId();
  db.insert(recipes).values({ id, householdId: currentHouseholdId(), name: cleanName(name) }).run();
  return id;
}

export type RecipeEdit = { name: string; notes: string; sourceUrl: string };

export function updateRecipe(id: string, edit: RecipeEdit): void {
  db.update(recipes)
    .set({ name: cleanName(edit.name), notes: edit.notes.trim() || null, sourceUrl: edit.sourceUrl.trim() || null })
    .where(eq(recipes.id, id))
    .run();
}

/**
 * Deletes a recipe. Its list items stay; their amounts from it become "no recipe" (spec 4.5),
 * so they show under Other items in the By recipe view.
 */
export function deleteRecipe(id: string): void {
  db.transaction((tx) => {
    tx.update(recipes).set({ deletedAt: new Date() }).where(eq(recipes.id, id)).run();
    tx.update(listItemContributions).set({ recipeId: null }).where(eq(listItemContributions.recipeId, id)).run();
  });
}

/** Marks the recipe as just changed, so it sorts first. */
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
    tx.insert(recipeIngredients)
      .values({
        id,
        recipeId,
        householdId: recipe.householdId,
        ingredientName,
        displayName: name,
        quantity,
        unit,
        position: nextPosition(recipeId),
      })
      .run();
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
      tx.insert(recipeIngredients)
        .values({ id: newId(), recipeId, householdId: recipe.householdId, ...item, position })
        .run();
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
    tx.update(recipeIngredients)
      .set({ ingredientName, displayName: name, quantity, unit, note: note.trim() || null })
      .where(eq(recipeIngredients.id, id))
      .run();
    return ensureLocalIngredient(tx, ingredientName, name) ? [ingredientName] : [];
  });
}

export function deleteRecipeIngredient(id: string): void {
  db.update(recipeIngredients).set({ deletedAt: new Date() }).where(eq(recipeIngredients.id, id)).run();
}

export function undeleteRecipeIngredient(id: string): void {
  db.update(recipeIngredients).set({ deletedAt: null }).where(eq(recipeIngredients.id, id)).run();
}
