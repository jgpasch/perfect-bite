// Recipes (spec 4.5): local reads, and writes through the sync helpers (outbox, spec 7.1).
import { and, asc, desc, eq, isNotNull, isNull, max, sql } from 'drizzle-orm';

import { db, households, listItemContributions, listItems, lists, recipeIngredients, recipes, type Recipe } from '@/db';
import { positionBetween } from '@/domain/position';
import { ensureLocalIngredient } from '@/features/categories/categories';
import { currentHouseholdId } from '@/features/lists/lists';
import { recordUsage } from '@/features/lists/usage';
import { i18n } from '@/i18n';
import { newId } from '@/lib/id';
import { normalizeIngredientName, parseQuantity } from '@/shared';
import type { PhotoCredit } from '@/shared/photo-credit';
import { emptyRecipeTags, RecipeTagsSchema, type RecipeTags, type SavedTag } from '@/shared/recipe-tags';
import type { Exec } from '@/sync/clock';
import { insertRow, updateRows } from '@/sync/mutate';

import { orderByLastUse } from './recipe-view';

const liveRecipe = isNull(recipes.deletedAt);
const liveIngredient = isNull(recipeIngredients.deletedAt);

/**
 * Live recipes, most recently updated first, each with its household, link, photo, ingredient count,
 * and the tags and time the tab's filters match (spec 4.14).
 */
export function recipesQuery() {
  return db
    .select({
      id: recipes.id,
      name: recipes.name,
      householdId: recipes.householdId,
      householdName: households.name,
      sourceUrl: recipes.sourceUrl,
      imageUrl: recipes.imageUrl,
      photoPath: recipes.photoPath,
      updatedAt: recipes.updatedAt,
      tags: recipes.tags,
      totalMinutes: recipes.totalMinutes,
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

/** The live ingredients of live recipes, in recipe order, for the Recipes tab's search (spec 4.14). */
export function recipeIngredientNamesQuery() {
  return db
    .select({ recipeId: recipeIngredients.recipeId, displayName: recipeIngredients.displayName })
    .from(recipeIngredients)
    .innerJoin(recipes, and(eq(recipes.id, recipeIngredients.recipeId), liveRecipe))
    .where(liveIngredient)
    .orderBy(asc(recipeIngredients.recipeId), asc(recipeIngredients.position));
}

/** Tables the recipes tab reads (`recipesQuery`, `recipesOnListsQuery`, `recipeIngredientNamesQuery`), for `useLiveQueryOn`. */
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
  if (!trimmed) throw new Error(i18n.t('errors.recipeNeedsName'));
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

/** Sets how many the recipe serves (1–100), or clears it with null. */
export function updateRecipeServings(id: string, servings: number | null): void {
  updateRows(db, recipes, eq(recipes.id, id), { servings });
}

/**
 * Saves the Tags sheet (spec 4.14): the tags, the total time and `tagsEdited` in one update, so the
 * "Tagged when you imported it" note goes. `tags` is the whole stored value, unknown slugs included.
 */
export function updateRecipeTags(id: string, tags: RecipeTags, totalMinutes: number | null): void {
  updateRows(db, recipes, eq(recipes.id, id), {
    tags: RecipeTagsSchema.parse(tags),
    totalMinutes,
    tagsEdited: true,
  });
}

/**
 * The Recipes tab menu's Favorite / Unfavorite and Want to try / Tried it (spec 4.5, 4.14): adds or
 * removes one Saved slug and keeps every other stored slug (unknown ones too), writing `tags` and
 * `tagsEdited` in one update as the Tags sheet's Save does. An untagged recipe gets tags with only it.
 */
export function setRecipeSaved(id: string, slug: SavedTag, on: boolean): void {
  const recipe = getRecipe(id);
  if (!recipe) return;
  const tags = recipe.tags ? RecipeTagsSchema.parse(recipe.tags) : emptyRecipeTags();
  const saved = tags.saved.filter((s) => s !== slug);
  updateRows(db, recipes, eq(recipes.id, id), {
    tags: { ...tags, saved: on ? [...saved, slug] : saved },
    tagsEdited: true,
  });
}

/**
 * The Choose a photo sheet (spec 4.5): sets the site photo (`imageUrl`), the household's own
 * (`photoPath`) and its credit (`photoCredit`), each only when given, so an unchanged one keeps its clock.
 */
export function updateRecipePhoto(
  id: string,
  photo: { imageUrl?: string | null; photoPath?: string | null; photoCredit?: PhotoCredit | null },
): void {
  updateRows(db, recipes, eq(recipes.id, id), photo);
}

/** Sets a photo import's kept pages (spec 4.10), their paths in order, or clears them with null. */
export function updateRecipeSourcePages(id: string, sourcePages: string[] | null): void {
  updateRows(db, recipes, eq(recipes.id, id), { sourcePages: sourcePages && sourcePages.length > 0 ? sourcePages : null });
}

/** Saves the Steps sheet: the method in order, or null for none. Hand-made and imported recipes alike. */
export function updateRecipeSteps(id: string, steps: string[] | null): void {
  updateRows(db, recipes, eq(recipes.id, id), { steps: steps && steps.length > 0 ? steps : null });
}

/**
 * Deletes a recipe. Its list items stay; their amounts from it become "no recipe" (spec 4.5),
 * so they show under Other items in the By recipe view. `exec`: the caller's transaction.
 */
export function deleteRecipe(id: string, exec: Exec = db): void {
  exec.transaction((tx) => {
    updateRows(tx, recipes, eq(recipes.id, id), { deletedAt: new Date() });
    updateRows(tx, listItemContributions, eq(listItemContributions.recipeId, id), { recipeId: null });
  });
}

/**
 * Marks the recipe as just changed, so it sorts first. Local only, not a mutation: `updated_at`
 * is server-set (spec 7.1).
 */
function touch(recipeId: string, exec: Exec = db) {
  exec
    .update(recipes).set({ updatedAt: new Date() }).where(eq(recipes.id, recipeId)).run();
}

function nextPosition(recipeId: string, exec: Exec = db): number {
  const last = exec
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
 * the names it recorded as pending, for `categorizePending`. `countUsage: false` leaves household
 * history alone, for a recipe import, which counts its uses as the list add (spec 4.10). `exec`:
 * the caller's transaction.
 */
export function addParsedRecipeIngredients(
  recipeId: string,
  items: readonly {
    ingredientName: string;
    displayName: string;
    quantity: number | null;
    unit: RecipeIngredientUnit;
    note?: string | null;
  }[],
  { countUsage = true }: { countUsage?: boolean } = {},
  exec: Exec = db,
): string[] {
  const recipe = exec.select().from(recipes).where(and(eq(recipes.id, recipeId), liveRecipe)).get();
  if (!recipe) throw new Error(`No recipe ${recipeId}`);
  const pendingNames: string[] = [];
  exec.transaction((tx) => {
    let position = nextPosition(recipeId, tx);
    const now = new Date();
    for (const item of items) {
      insertRow(tx, recipeIngredients, { id: newId(), recipeId, householdId: recipe.householdId, ...item, position });
      if (countUsage) {
        recordUsage(tx, recipe.householdId, item.ingredientName, item.displayName, now, {
          quantity: item.quantity,
          unit: item.unit ?? null,
        });
      }
      if (ensureLocalIngredient(tx, item.ingredientName, item.displayName)) pendingNames.push(item.ingredientName);
      position = positionBetween(position, null);
    }
  });
  touch(recipeId, exec);
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
  if (!ingredientName) throw new Error(i18n.t('errors.ingredientNeedsName'));
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
