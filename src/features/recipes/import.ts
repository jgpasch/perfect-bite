// Recipe import from a link or photos (spec 4.10, 6.6, 6.10): calls the `import-recipe` (or
// `import-recipe-photo`) Edge Function, then saves the recipe and puts its ingredients on a list in
// one local transaction.
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { File } from 'expo-file-system';
import { v5 } from 'uuid';

import { db, households, lists, recipeIngredients, recipes } from '@/db';
import { applyResults, type CategorizeResult } from '@/features/categories/categorization';
import { addItemsBulk, undoAdds, type BulkAdd } from '@/features/lists/items';
import type { Feature } from '@/features/plans/features';
import { lostFeature } from '@/features/plans/load';
import { newId } from '@/lib/id';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { stepIngredientsBasis, stepTexts, type StepIngredients } from '@/shared';
import {
  canonicalRecipeUrl,
  RecipeImportErrorSchema,
  RecipeImportResponseSchema,
  type RecipeImportRequest,
  type RecipeImportResponse,
} from '@/shared/schemas/recipe-import';
import type { RecipePhotoImportRequest } from '@/shared/schemas/recipe-photo-import';
import type { Exec } from '@/sync/clock';
import { insertRow, updateRows } from '@/sync/mutate';

import { ensureStepMatch } from './ensure-step-match';
import { capturePage, toRequestPage } from './page-capture';
import { uploadRecipePages } from './photo-upload';
import { addParsedRecipeIngredients, deleteRecipe, getRecipe, updateRecipeSourcePages } from './recipes';

/** The namespace import ids are hashed under (UUIDv5), so an import id always gives the same recipe id. */
export const IMPORT_ID_NAMESPACE = '6f3b2a91-4c7e-4d1a-9b8e-2a5c7d0e4f13';

/**
 * Where an import goes: onto a list (the recipe is saved to its household), or into a household
 * alone, saving the recipe and adding nothing to a list (a recipe-only share, spec 4.10).
 */
export type ImportTarget = { listId: string; householdId?: never } | { householdId: string; listId?: never };

export type ImportRecipeInput = ImportTarget & {
  url: string;
  /** What Safari captured (spec 4.10), so the server needn't fetch. */
  page?: RecipeImportRequest['page'];
  /** A share envelope's id: a re-run after a crash reuses the recipe it created. */
  importId?: string;
};

export type ImportRecipeSuccess<ListId extends string | null = string | null> = {
  ok: true;
  recipeId: string;
  recipeName: string;
  /** The list the ingredients went on; null for a recipe-only import. */
  listId: ListId;
  /** Whether this import created the recipe (false: it reused one with the same link). */
  created: boolean;
  /** Ingredients added to the list, for the toast ("· 12 items"); 0 for a recipe-only import. */
  added: number;
  /** How many of those were Combined into an item already open on the list. */
  combined: number;
  /** Takes back the list adds, and deletes the recipe if this import created it. */
  undo: () => void;
};

/**
 * `not_a_recipe`: the page isn't a single recipe. `offline`: no connection, session or config.
 * `rate_limited`: a rate limit or the service is unavailable ("Try again in a minute").
 * `blocked`: the site blocked the server's fetch and the device capture didn't get past it either.
 * `not_entitled`: the user's plan doesn't have `recipe_import` (`recipe_import_photo` for photos, spec 4.12).
 * `failed`: anything else; `reason` says what the server said, when it did.
 */
export type ImportRecipeError =
  | { ok: false; error: 'not_a_recipe' | 'offline' | 'rate_limited' | 'blocked' | 'not_entitled' }
  | { ok: false; error: 'failed'; reason?: 'invalid_url' | 'fetch_failed' };

export type ImportRecipeResult<ListId extends string | null = string | null> =
  | ImportRecipeSuccess<ListId>
  | ImportRecipeError;

/** The recipe id an import id maps to. */
export function recipeIdForImport(importId: string): string {
  return v5(importId, IMPORT_ID_NAMESPACE);
}

/**
 * Imports the recipe at `url` into `listId`'s household and adds every ingredient to the list at
 * 1×, as a bulk add with Combine (spec 4.4, 4.10). With `householdId` and no list, it saves the
 * recipe to that household the same way (same reuse by link, same import id) and adds nothing to a
 * list. Never throws: errors come back as a result, and an error writes nothing.
 */
export async function importRecipe(input: ImportRecipeInput & { listId: string }): Promise<ImportRecipeResult<string>>;
export async function importRecipe(input: ImportRecipeInput & { householdId: string }): Promise<ImportRecipeResult<null>>;
export async function importRecipe(input: ImportRecipeInput): Promise<ImportRecipeResult>;
export async function importRecipe(input: ImportRecipeInput): Promise<ImportRecipeResult> {
  if (canonicalRecipeUrl(input.url) === null) return { ok: false, error: 'failed', reason: 'invalid_url' };
  if (!isSupabaseConfigured) return { ok: false, error: 'offline' };
  let userId: string;
  let recipe: RecipeImportResponse;
  try {
    const { data: auth } = await supabase.auth.getSession();
    if (!auth.session) return { ok: false, error: 'offline' };
    userId = auth.session.user.id;
    let fetched = await requestImport(input.page ? { url: input.url, page: input.page } : { url: input.url });
    // The site blocked the server's fetch: load it on the device and send what the page shows.
    // Only a link with no page of its own falls back, and only for `fetch_failed`.
    if (!input.page && isFetchFailed(fetched)) {
      const captured = await capturePage(input.url);
      if (captured.ok) {
        fetched = await requestImport({ url: input.url, page: toRequestPage(captured.page) });
        if (isFetchFailed(fetched)) return { ok: false, error: 'blocked' };
      } else if (captured.reason === 'timeout') {
        return { ok: false, error: 'blocked' };
      }
      // Unreachable on the device too: keep the server's "couldn't reach that site".
    }
    if ('ok' in fetched) return fetched;
    recipe = fetched;
  } catch (e) {
    console.warn('import-recipe failed', e);
    return { ok: false, error: 'offline' };
  }

  return saveAndMatch(input, recipe, userId);
}

/** Where a photo import goes, and its photos: the pages of one recipe, in order, as JPEG files on the device. */
export type ImportRecipePhotosInput = ImportTarget & { photoUris: readonly string[] };

/**
 * Imports the recipe in the photos (spec 4.10, 6.10): reads each downscaled JPEG as base64, sends
 * them to `import-recipe-photo` and saves the answer as a link import does, onto the list or into
 * the household. A photo import always creates a new recipe, with no link and no photo. Once it's
 * saved, the pages go up to `recipe-pages` and `source_pages` points at them (best effort), and the
 * page files are deleted. Never throws: errors come back as a result, and an error writes nothing.
 */
export async function importRecipeFromPhotos(
  input: ImportRecipePhotosInput & { listId: string },
): Promise<ImportRecipeResult<string>>;
export async function importRecipeFromPhotos(
  input: ImportRecipePhotosInput & { householdId: string },
): Promise<ImportRecipeResult<null>>;
export async function importRecipeFromPhotos(input: ImportRecipePhotosInput): Promise<ImportRecipeResult>;
export async function importRecipeFromPhotos(input: ImportRecipePhotosInput): Promise<ImportRecipeResult> {
  if (input.photoUris.length === 0) return { ok: false, error: 'failed' };
  if (!isSupabaseConfigured) return { ok: false, error: 'offline' };
  let userId: string;
  let recipe: RecipeImportResponse;
  try {
    const { data: auth } = await supabase.auth.getSession();
    if (!auth.session) return { ok: false, error: 'offline' };
    userId = auth.session.user.id;
    const body: RecipePhotoImportRequest = {
      images: await Promise.all(
        input.photoUris.map(async (uri) => ({ mediaType: 'image/jpeg' as const, data: await new File(uri).base64() })),
      ),
    };
    const fetched = await requestFunction('import-recipe-photo', body, 'recipe_import_photo');
    if ('ok' in fetched) return fetched;
    // Never a link or the site's photo, so never a reused recipe or a source credit.
    recipe = { ...fetched, sourceUrl: null, imageUrl: null };
  } catch (e) {
    console.warn('import-recipe-photo failed', e);
    return { ok: false, error: 'offline' };
  }
  const target: ImportTarget = input.listId ? { listId: input.listId } : { householdId: input.householdId! };
  const result = saveAndMatch(target, recipe, userId);
  if (result.ok) await keepPages(result.recipeId, input.photoUris);
  return result;
}

/**
 * Keeps a saved photo import's pages with the recipe (spec 4.10): uploads them and sets
 * `source_pages`, best effort (a failed upload leaves it null and the import still succeeds), then
 * deletes the page files from the cache.
 */
async function keepPages(recipeId: string, photoUris: readonly string[]): Promise<void> {
  const recipe = getRecipe(recipeId);
  if (recipe) {
    const paths = await uploadRecipePages(recipe.householdId, recipeId, photoUris);
    // Undone while it uploaded: the recipe is gone, and the server removes its pages.
    if (paths && getRecipe(recipeId)) updateRecipeSourcePages(recipeId, paths);
  }
  for (const uri of photoUris) {
    try {
      new File(uri).delete();
    } catch {}
  }
}

function saveAndMatch(input: SaveInput, recipe: RecipeImportResponse, userId: string): ImportRecipeResult {
  try {
    const saved = save(input, recipe, userId);
    void ensureStepMatch(saved.recipeId);
    return saved;
  } catch (e) {
    console.warn('Saving the imported recipe failed', e);
    return { ok: false, error: 'failed' };
  }
}

/** One call to `import-recipe`: the recipe, or the error it answered with. */
function requestImport(body: RecipeImportRequest): Promise<RecipeImportResponse | ImportRecipeError> {
  return requestFunction('import-recipe', body, 'recipe_import');
}

/** One call to an import function: the recipe, or the error it answered with. */
async function requestFunction(
  name: 'import-recipe' | 'import-recipe-photo',
  body: RecipeImportRequest | RecipePhotoImportRequest,
  feature: Feature,
): Promise<RecipeImportResponse | ImportRecipeError> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) return await errorResult(error, name, feature);
  const parsed = RecipeImportResponseSchema.safeParse(data);
  if (!parsed.success) {
    console.warn(`${name}: unexpected response`, parsed.error);
    return { ok: false, error: 'failed' };
  }
  return parsed.data;
}

function isFetchFailed(result: RecipeImportResponse | ImportRecipeError): boolean {
  return 'ok' in result && result.error === 'failed' && result.reason === 'fetch_failed';
}

/** Maps a `functions.invoke` error to a result: a network failure is offline, an HTTP error by its code. */
async function errorResult(error: unknown, fn: string, feature: Feature): Promise<ImportRecipeError> {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'FunctionsFetchError') return { ok: false, error: 'offline' };
  const response = (error as { context?: unknown } | null)?.context as
    | { status?: number; json?: () => Promise<unknown> }
    | undefined;
  let code: string | undefined;
  try {
    const parsed = RecipeImportErrorSchema.safeParse(await response?.json?.());
    if (parsed.success) code = parsed.data.error;
  } catch {
    // Not a JSON body; fall back to the status.
  }
  const status = response?.status;
  if (code === 'not_entitled' || (!code && status === 403)) {
    // The plan has no recipe import (or photo import): hide its entry points now and reload the plan (spec 4.12).
    void lostFeature(feature);
    return { ok: false, error: 'not_entitled' };
  }
  if (code === 'not_a_recipe' || (!code && status === 422)) return { ok: false, error: 'not_a_recipe' };
  if (code === 'rate_limited' || code === 'unavailable' || (!code && (status === 429 || status === 503))) {
    return { ok: false, error: 'rate_limited' };
  }
  if (code === 'invalid_url' || code === 'fetch_failed') return { ok: false, error: 'failed', reason: code };
  console.warn(`${fn} returned an error`, error);
  return { ok: false, error: 'failed' };
}

type SaveInput = ImportTarget & { importId?: string };

function save(input: SaveInput, imported: RecipeImportResponse, userId: string): ImportRecipeSuccess {
  const listId = input.listId ?? null;
  const { recipeId, recipeName, created, results } = db.transaction((tx) => {
    let householdId: string;
    if (listId) {
      const list = tx.select({ householdId: lists.householdId }).from(lists).where(eq(lists.id, listId)).get();
      if (!list) throw new Error(`No list ${listId}`);
      householdId = list.householdId;
    } else {
      const household = tx.select({ id: households.id }).from(households).where(eq(households.id, input.householdId!)).get();
      if (!household) throw new Error(`No household ${input.householdId}`);
      householdId = household.id;
    }

    const existing = findRecipe(tx, householdId, imported.sourceUrl, input.importId);
    let recipeId = existing?.id;
    if (!recipeId) {
      recipeId = createImportedRecipe(tx, householdId, imported, input.importId);
      addParsedRecipeIngredients(
        recipeId,
        imported.ingredients.map((i) => ({
          ingredientName: i.ingredientName,
          displayName: i.displayName,
          quantity: i.quantity,
          unit: i.unit,
          note: i.note.trim() || null,
        })),
        // The import counts its uses once, as the list add below (spec 4.10).
        { countUsage: false },
        tx,
      );
      // The import's own step match makes the recipe's match fresh, so ensureStepMatch skips it.
      const stepIngredients = importedStepIngredients(tx, recipeId, imported);
      if (stepIngredients) updateRows(tx, recipes, eq(recipes.id, recipeId), { stepIngredients });
    }

    // A recipe-only import adds nothing to a list.
    const adds: BulkAdd[] = listId
      ? imported.ingredients.map((i) => ({
          source: 'recipe',
          recipeId,
          parsed: { ingredientName: i.ingredientName, displayName: i.displayName, quantity: i.quantity, unit: i.unit },
        }))
      : [];
    const results = listId ? addItemsBulk(listId, adds, userId, tx) : [];

    // After the adds, so every name has a local row to update.
    applyResults(categorizeResults(imported), tx);

    return { recipeId, recipeName: existing?.name ?? nameOf(imported), created: !existing, results };
  });

  const added = results.filter((r) => r !== null);
  return {
    ok: true,
    recipeId,
    recipeName,
    listId,
    created,
    added: added.length,
    combined: added.filter((r) => r.kind === 'combine').length,
    undo: () =>
      db.transaction((tx) => {
        undoAdds(results, tx);
        if (created) deleteRecipe(recipeId, tx);
      }),
  };
}

/**
 * The household's recipe for this import: the one an earlier run of the same import created, else
 * a live one with the same canonical source URL. A photo import has no URL (spec 6.10), so it only
 * ever finds its own earlier run.
 */
function findRecipe(
  exec: Exec,
  householdId: string,
  sourceUrl: string | null,
  importId: string | undefined,
): { id: string; name: string } | undefined {
  if (importId) {
    const byId = exec
      .select({ id: recipes.id, name: recipes.name })
      .from(recipes)
      .where(and(eq(recipes.id, recipeIdForImport(importId)), isNull(recipes.deletedAt)))
      .get();
    if (byId) return byId;
  }
  if (sourceUrl === null) return undefined;
  return exec
    .select({ id: recipes.id, name: recipes.name, sourceUrl: recipes.sourceUrl })
    .from(recipes)
    .where(and(eq(recipes.householdId, householdId), isNull(recipes.deletedAt), isNotNull(recipes.sourceUrl)))
    .all()
    .find((r) => canonicalRecipeUrl(r.sourceUrl!) === sourceUrl);
}

function createImportedRecipe(
  exec: Exec,
  householdId: string,
  imported: RecipeImportResponse,
  importId: string | undefined,
): string {
  let id = importId ? recipeIdForImport(importId) : newId();
  // A recipe this import created and the user has since deleted keeps its id; start a new one.
  if (exec.select({ id: recipes.id }).from(recipes).where(eq(recipes.id, id)).get()) id = newId();
  insertRow(exec, recipes, {
    id,
    householdId,
    name: nameOf(imported),
    sourceUrl: imported.sourceUrl,
    // Only a recipe this import creates; a reused one keeps its own (spec 4.14). Never `saved`.
    tags: imported.tags && { saved: [], ...imported.tags },
    totalMinutes: imported.totalMinutes,
    steps: stepTexts(imported.steps).length > 0 ? imported.steps : null,
    servings: servingsOf(imported.servings),
    imageUrl: imported.imageUrl,
  });
  return id;
}

/**
 * The response's step match (indexes into its ingredients) as `recipes.step_ingredients` for the
 * recipe the import just created, whose ingredients are the response's in the same order. Null
 * when there's none, or it doesn't line up with the saved steps and ingredients: the recipe stays
 * unmatched and ensureStepMatch matches it.
 */
function importedStepIngredients(exec: Exec, recipeId: string, imported: RecipeImportResponse): StepIngredients | null {
  const match = imported.stepIngredients;
  // One entry per step string: headings aren't steps.
  const stepCount = stepTexts(imported.steps).length;
  if (!match || stepCount === 0 || match.length !== stepCount) return null;
  const ids = exec
    .select({ id: recipeIngredients.id })
    .from(recipeIngredients)
    .where(and(eq(recipeIngredients.recipeId, recipeId), isNull(recipeIngredients.deletedAt)))
    .orderBy(asc(recipeIngredients.position))
    .all()
    .map((i) => i.id);
  if (ids.length !== imported.ingredients.length) return null;
  if (match.some((uses) => uses.some((use) => use.index >= ids.length))) return null;
  return {
    v: 1,
    basis: stepIngredientsBasis(imported.steps, ids),
    steps: match.map((uses) => uses.map((use) => ({ id: ids[use.index], quantity: use.quantity }))),
  };
}

/** `recipes.servings`: a whole number from 1 to 100, else null. */
function servingsOf(servings: number | null): number | null {
  return servings !== null && Number.isInteger(servings) && servings >= 1 && servings <= 100 ? servings : null;
}

/** The recipe's name, or its site's host when the page gave none ("Recipe" without a link). */
function nameOf(imported: RecipeImportResponse): string {
  const name = imported.name.trim().replace(/\s+/g, ' ');
  if (name) return name;
  if (imported.sourceUrl === null) return 'Recipe';
  try {
    return new URL(imported.sourceUrl).hostname;
  } catch {
    return 'Recipe';
  }
}

/** The response's categories in the shape `applyResults` takes. */
function categorizeResults(imported: RecipeImportResponse): Record<string, CategorizeResult> {
  const results: Record<string, CategorizeResult> = {};
  for (const i of imported.ingredients) {
    results[i.ingredientName] = { status: i.status, category_id: i.categoryId, is_grocery_item: null };
  }
  return results;
}
