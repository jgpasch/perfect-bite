// Recipe import from a link (spec 4.10, 6.6): calls the `import-recipe` Edge Function, then saves
// the recipe and puts its ingredients on a list in one local transaction.
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { v5 } from 'uuid';

import { db, households, lists, recipes } from '@/db';
import { applyResults, type CategorizeResult } from '@/features/categories/categorization';
import { addItemsBulk, undoAdds, type BulkAdd } from '@/features/lists/items';
import { lostFeature } from '@/features/plans/load';
import { newId } from '@/lib/id';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import {
  canonicalRecipeUrl,
  RecipeImportErrorSchema,
  RecipeImportResponseSchema,
  type RecipeImportRequest,
  type RecipeImportResponse,
} from '@/shared/schemas/recipe-import';
import type { Exec } from '@/sync/clock';
import { insertRow } from '@/sync/mutate';

import { capturePage, toRequestPage } from './page-capture';
import { addParsedRecipeIngredients, deleteRecipe } from './recipes';

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
 * `not_entitled`: the user's plan doesn't have `recipe_import` (spec 4.12).
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

  try {
    return save(input, recipe, userId);
  } catch (e) {
    console.warn('Saving the imported recipe failed', e);
    return { ok: false, error: 'failed' };
  }
}

/** One call to `import-recipe`: the recipe, or the error it answered with. */
async function requestImport(body: RecipeImportRequest): Promise<RecipeImportResponse | ImportRecipeError> {
  const { data, error } = await supabase.functions.invoke('import-recipe', { body });
  if (error) return await errorResult(error);
  const parsed = RecipeImportResponseSchema.safeParse(data);
  if (!parsed.success) {
    console.warn('import-recipe: unexpected response', parsed.error);
    return { ok: false, error: 'failed' };
  }
  return parsed.data;
}

function isFetchFailed(result: RecipeImportResponse | ImportRecipeError): boolean {
  return 'ok' in result && result.error === 'failed' && result.reason === 'fetch_failed';
}

/** Maps a `functions.invoke` error to a result: a network failure is offline, an HTTP error by its code. */
async function errorResult(error: unknown): Promise<ImportRecipeError> {
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
    // The plan has no recipe import: hide its entry points now and reload the plan (spec 4.12).
    void lostFeature('recipe_import');
    return { ok: false, error: 'not_entitled' };
  }
  if (code === 'not_a_recipe' || (!code && status === 422)) return { ok: false, error: 'not_a_recipe' };
  if (code === 'rate_limited' || code === 'unavailable' || (!code && (status === 429 || status === 503))) {
    return { ok: false, error: 'rate_limited' };
  }
  if (code === 'invalid_url' || code === 'fetch_failed') return { ok: false, error: 'failed', reason: code };
  console.warn('import-recipe returned an error', error);
  return { ok: false, error: 'failed' };
}

function save(input: ImportRecipeInput, imported: RecipeImportResponse, userId: string): ImportRecipeSuccess {
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
 * a live one with the same canonical source URL.
 */
function findRecipe(
  exec: Exec,
  householdId: string,
  sourceUrl: string,
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
    steps: imported.steps.length > 0 ? imported.steps : null,
    servings: servingsOf(imported.servings),
    imageUrl: imported.imageUrl,
  });
  return id;
}

/** `recipes.servings`: a whole number from 1 to 100, else null. */
function servingsOf(servings: number | null): number | null {
  return servings !== null && Number.isInteger(servings) && servings >= 1 && servings <= 100 ? servings : null;
}

/** The recipe's name, or its site's host when the page gave none. */
function nameOf(imported: RecipeImportResponse): string {
  const name = imported.name.trim().replace(/\s+/g, ' ');
  if (name) return name;
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
