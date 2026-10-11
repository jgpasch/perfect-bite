// import-recipe (spec §6.6): pure logic behind a store interface, so it runs in Deno tests with a
// fake store, a fake fetch and MockLanguageModelV4. index.ts wires the real store.
import {
  canonicalRecipeUrl,
  ExtractedRecipeSchema,
  findRecipe,
  MAX_RECIPE_NAME_LENGTH,
  normalizeIngredientName,
  type ExtractedRecipe,
  type RecipeImportErrorCode,
  type RecipeImportRequest,
  type RecipeImportResponse,
} from '@shared/index.ts';
import { NoObjectGeneratedError, type LanguageModel } from 'ai';

import { buildExtractRecipePrompt, EXTRACT_RECIPE_PROMPT_VERSION, truncateText } from '../_shared/ai/prompts/extract-recipe.v1.ts';
import { runAiTask, type AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { cleanExtractedRecipe, isAiEnabled } from '../_shared/ai/tasks.ts';
import { FetchPageError, type FetchedPage } from '../_shared/fetch-page.ts';
import {
  CategorizeLimitError,
  isProviderFailure,
  type CategorizeResponse,
  type LimitResult,
} from '../categorize-ingredients/handler.ts';

/** Cache rows older than this are misses (and are deleted daily by pg_cron). */
export const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** A `recipe_imports` row. `result` is the cleaned `ExtractedRecipe`. */
export type CachedImport = { result: unknown; is_recipe: boolean; created_at: string };

/** The tables import-recipe uses, as it sees them. index.ts implements it with the service role. */
export interface RecipeImportStore {
  /**
   * Counts one import against the per-user and global limits (`public.check_recipe_import_limit`).
   * Called once per request, before the cache is read.
   */
  checkLimit(): Promise<LimitResult>;
  /** The `recipe_imports` row for this URL and prompt version, whatever its age; null if none. */
  getCached(urlKey: string, promptVersion: string): Promise<CachedImport | null>;
  /** Inserts or replaces the row, with `created_at` now. */
  saveCached(urlKey: string, promptVersion: string, result: ExtractedRecipe): Promise<void>;
  /** Writes one `ai_calls` row. */
  logAiCall(call: AiCallRecord): Promise<void>;
}

export type ImportDeps = {
  store: RecipeImportStore;
  /** The shared `categorize()`, bound to its own store and the caller's limits. */
  categorize: (names: string[]) => Promise<CategorizeResponse>;
  /** `fetchPage` from `_shared/fetch-page.ts`; tests inject one with a fake resolver and fetch. */
  fetchPage: (url: string) => Promise<FetchedPage>;
  /** Tests inject a MockLanguageModelV4 for extract-recipe; otherwise the task's env model. */
  model?: { instance: LanguageModel; modelId: string };
  now?: () => number;
};

/** Why an import failed; request.ts turns it into the HTTP status. */
export type ImportFailure =
  | { code: Exclude<RecipeImportErrorCode, 'rate_limited' | 'unavailable'> }
  | { code: 'rate_limited' }
  | { code: 'unavailable'; reason: 'global_cap' | 'ai_off' | 'ai_failed' };

export class ImportRecipeError extends Error {
  override name = 'ImportRecipeError';
  constructor(
    readonly failure: ImportFailure,
    message: string,
  ) {
    super(message);
  }
}

/** The page to extract from: what the client sent, or what the server fetched. */
type Page = { title: string | null; jsonLd: string[]; text: string };

/** Unsafe or unparseable URLs are the request's fault; anything else about the fetch isn't. */
function fetchFailure(err: FetchPageError): ImportRecipeError {
  if (err.reason === 'invalid_url' || err.reason === 'blocked_address') {
    return new ImportRecipeError({ code: 'invalid_url' }, err.message);
  }
  return new ImportRecipeError({ code: 'fetch_failed' }, err.message);
}

/**
 * One extract-recipe call: JSON-LD ingredient lines when `findRecipe` finds a recipe, otherwise
 * the page text. A page with neither is not a recipe, without a call. Any model failure (provider
 * error, timeout, invalid output) is `unavailable`.
 */
async function extract(page: Page, deps: ImportDeps): Promise<ExtractedRecipe> {
  const jsonLd = findRecipe(page.jsonLd);
  if (!jsonLd && !page.text.trim()) return { is_recipe: false, name: '', servings: null, ingredients: [] };
  const input = jsonLd
    ? { title: jsonLd.name ?? page.title, ingredientLines: jsonLd.ingredientLines }
    : { title: page.title, text: page.text };
  let output;
  try {
    ({ output } = await runAiTask('extractRecipe', buildExtractRecipePrompt(input), {
      model: deps.model,
      onCall: (call) => deps.store.logAiCall(call),
    }));
  } catch (err) {
    const invalid = NoObjectGeneratedError.isInstance(err);
    if (!invalid && !isProviderFailure(err)) throw err;
    const what = invalid ? 'invalid output' : 'provider error or timeout';
    throw new ImportRecipeError({ code: 'unavailable', reason: 'ai_failed' }, `Recipe extraction failed: ${what}`);
  }
  const recipe = cleanExtractedRecipe(output);
  if (!recipe.is_recipe) return recipe;
  // JSON-LD's own name and yield are what the site published; the model's fill the gaps.
  const fallbackName = (jsonLd?.name ?? page.title ?? '').replace(/\s+/g, ' ').trim();
  return {
    ...recipe,
    name: recipe.name || truncateText(fallbackName, MAX_RECIPE_NAME_LENGTH).trimEnd(),
    servings: jsonLd?.servings ?? recipe.servings,
  };
}

/**
 * Imports one recipe link (spec §6.6 flow). Throws `ImportRecipeError` for every expected failure.
 * Only extractions of pages the server fetched are cached, `not_a_recipe` answers included.
 */
export async function importRecipe(request: RecipeImportRequest, deps: ImportDeps): Promise<RecipeImportResponse> {
  const now = deps.now ?? Date.now;
  const urlKey = canonicalRecipeUrl(request.url);
  if (!urlKey) throw new ImportRecipeError({ code: 'invalid_url' }, 'Not an http(s) URL');
  if (!isAiEnabled('extractRecipe')) {
    throw new ImportRecipeError({ code: 'unavailable', reason: 'ai_off' }, 'Recipe import is turned off');
  }

  const limit = await deps.store.checkLimit();
  if (limit === 'user_limit') throw new ImportRecipeError({ code: 'rate_limited' }, 'Too many imports; try again later');
  if (limit === 'global_cap') {
    throw new ImportRecipeError({ code: 'unavailable', reason: 'global_cap' }, 'Recipe import is paused for now');
  }

  let recipe: ExtractedRecipe | null = null;
  const cached = await deps.store.getCached(urlKey, EXTRACT_RECIPE_PROMPT_VERSION);
  if (cached && now() - Date.parse(cached.created_at) < CACHE_MAX_AGE_MS) {
    const parsed = ExtractedRecipeSchema.safeParse(cached.result);
    if (parsed.success) recipe = parsed.data;
  }

  if (!recipe) {
    let page: Page;
    if (request.page) {
      page = { title: request.page.title ?? null, jsonLd: request.page.jsonLd ?? [], text: request.page.text ?? '' };
    } else {
      try {
        page = await deps.fetchPage(request.url.trim());
      } catch (err) {
        if (err instanceof FetchPageError) throw fetchFailure(err);
        throw err;
      }
    }
    recipe = await extract(page, deps);
    // Client-supplied pages are never cached, so one user can't poison the cache for others.
    if (!request.page) {
      try {
        await deps.store.saveCached(urlKey, EXTRACT_RECIPE_PROMPT_VERSION, recipe);
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', event: 'recipe_cache_save_failed', error: String(err).slice(0, 200) }));
      }
    }
  }

  if (!recipe.is_recipe) throw new ImportRecipeError({ code: 'not_a_recipe' }, 'That page is not a recipe');

  const lines = recipe.ingredients.map((item) => ({ ...item, key: normalizeIngredientName(item.name) }));
  let categories: CategorizeResponse['results'] = {};
  try {
    categories = (await deps.categorize(lines.map((l) => l.name))).results;
  } catch (err) {
    // Categorize's own limits: the recipe still imports, and the app sorts the names later.
    if (!(err instanceof CategorizeLimitError)) throw err;
  }

  return {
    name: recipe.name,
    sourceUrl: urlKey,
    servings: recipe.servings,
    ingredients: lines.map((l) => ({
      ingredientName: l.key,
      displayName: l.name,
      quantity: l.quantity,
      unit: l.unit,
      note: l.note,
      categoryId: categories[l.key]?.category_id ?? null,
      status: categories[l.key]?.status ?? 'pending',
    })),
  };
}
