// import-recipe (spec §6.6): pure logic behind a store interface, so it runs in Deno tests with a
// fake store, a fake fetch and MockLanguageModelV4. index.ts wires the real store.
import {
  canonicalRecipeUrl,
  cleanImageUrl,
  emptyAiRecipeTags,
  ExtractedRecipeSchema,
  findRecipe,
  jsonLdImageCandidates,
  MAX_RECIPE_NAME_LENGTH,
  normalizeIngredientName,
  stepTexts,
  type ExtractedRecipe,
  type RecipeImportErrorCode,
  type RecipeImportRequest,
  type RecipeImportResponse,
} from '@shared/index.ts';
import { NoObjectGeneratedError, type LanguageModel } from 'ai';

import { buildExtractRecipePrompt, EXTRACT_RECIPE_PROMPT_VERSION, truncateText } from '../_shared/ai/prompts/extract-recipe.v6.ts';
import { runAiTask, type AiCaller, type AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { cleanExtractedRecipe, isAiEnabled } from '../_shared/ai/tasks.ts';
import { NotEntitledError, type Feature } from '../_shared/entitlements.ts';
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
   * Counts one import against the per-user limits (`public.check_recipe_import_limit`).
   * Called once per request, before the cache is read.
   */
  checkLimit(): Promise<LimitResult>;
  /** The `recipe_imports` row for this URL and prompt version, whatever its age; null if none. */
  getCached(urlKey: string, promptVersion: string): Promise<CachedImport | null>;
  /** Inserts or replaces the row, with `created_at` now. */
  saveCached(urlKey: string, promptVersion: string, result: ExtractedRecipe): Promise<void>;
  /** Writes one `ai_calls` row. */
  logAiCall(call: AiCallRecord): Promise<void>;
  /**
   * Throws NotEntitledError unless the plan of `householdId` (the household the recipe is saved to)
   * has `feature` and the caller is in it (`requireFeature` in `_shared/entitlements.ts`). No
   * household (old builds): any of the caller's households. Called first, before the rate limit,
   * the cache or any fetch.
   */
  requireFeature(feature: Feature, householdId?: string): Promise<void>;
}

export type ImportDeps = {
  store: RecipeImportStore;
  /**
   * The shared `categorize()`, bound to its own store and the caller's limits. `caller` is the
   * request's (with its household), recorded on each `ai_calls` row.
   */
  categorize: (names: string[], caller?: AiCaller) => Promise<CategorizeResponse>;
  /** `fetchPage` from `_shared/fetch-page.ts`; tests inject one with a fake resolver and fetch. */
  fetchPage: (url: string) => Promise<FetchedPage>;
  /** Tests inject a MockLanguageModelV4 for extract-recipe; otherwise the task's env model. */
  model?: { instance: LanguageModel; modelId: string };
  /** The signed-in caller, recorded on each `ai_calls` row with the request's `householdId`. */
  caller?: AiCaller;
  now?: () => number;
};

/** Why an import failed; request.ts turns it into the HTTP status. */
export type ImportFailure =
  | { code: Exclude<RecipeImportErrorCode, 'rate_limited' | 'daily_limit' | 'limit_reached' | 'unavailable'> }
  | { code: 'rate_limited' }
  | { code: 'daily_limit' }
  | { code: 'limit_reached' }
  | { code: 'unavailable'; reason: 'ai_off' | 'ai_failed' };

export class ImportRecipeError extends Error {
  override name = 'ImportRecipeError';
  constructor(
    readonly failure: ImportFailure,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The page to extract from: what the client sent, or what the server fetched. `url` resolves a
 * relative JSON-LD image; `imageUrl` is the page's best photo (spec 6.6 step 5), already cleaned.
 */
type Page = { url: string; title: string | null; jsonLd: string[]; text: string; imageUrl: string | null };

/**
 * A client-sent page's photo, by the chain `readImageCandidates` uses as far as the client sent it
 * (no markup): the JSON-LD rungs from its blocks, then its `imageUrl`, which the device read from the
 * page's meta, link and microdata tags in the same order (`CAPTURE_SCRIPT`, `Preprocess.js`).
 */
export function clientPageImage(jsonLd: readonly string[], imageUrl: string | undefined, url: string): string | null {
  return jsonLdImageCandidates(jsonLd, url)[0] ?? cleanImageUrl(imageUrl, url);
}

/** Unsafe or unparseable URLs are the request's fault; anything else about the fetch isn't. */
function fetchFailure(err: FetchPageError): ImportRecipeError {
  if (err.reason === 'invalid_url' || err.reason === 'blocked_address') {
    return new ImportRecipeError({ code: 'invalid_url' }, err.message);
  }
  return new ImportRecipeError({ code: 'fetch_failed' }, err.message);
}

/**
 * One extract-recipe call: JSON-LD ingredient lines and steps when `findRecipe` finds a recipe,
 * otherwise the page text. A page with neither is not a recipe, without a call. Any model failure
 * (provider error, timeout, invalid output) is `unavailable`. Steps are JSON-LD's when it has the
 * recipe (the model gets them only to match), else the model's; either way the model's step match
 * comes with them, or null when it doesn't line up, and its `choice_sections` mark the headings that
 * are alternatives (v5). The photo is the JSON-LD recipe's, else the page's best photo.
 */
async function extract(page: Page, deps: ImportDeps): Promise<ExtractedRecipe> {
  const jsonLd = findRecipe(page.jsonLd, page.url);
  if (!jsonLd && !page.text.trim()) {
    return {
      is_recipe: false,
      name: '',
      servings: null,
      ingredients: [],
      tags: emptyAiRecipeTags(),
      total_minutes: null,
      steps: [],
      step_ingredients: null,
      image_url: null,
    };
  }
  const input = jsonLd
    ? { title: jsonLd.name ?? page.title, ingredientLines: jsonLd.ingredientLines, steps: jsonLd.steps }
    : { title: page.title, text: page.text };
  let output;
  try {
    ({ output } = await runAiTask('extractRecipe', buildExtractRecipePrompt(input), {
      model: deps.model,
      caller: deps.caller,
      onCall: (call) => deps.store.logAiCall(call),
    }));
  } catch (err) {
    const invalid = NoObjectGeneratedError.isInstance(err);
    if (!invalid && !isProviderFailure(err)) throw err;
    const what = invalid ? 'invalid output' : 'provider error or timeout';
    throw new ImportRecipeError({ code: 'unavailable', reason: 'ai_failed' }, `Recipe extraction failed: ${what}`);
  }
  const recipe = cleanExtractedRecipe(output, jsonLd ? jsonLd.steps : null);
  if (!recipe.is_recipe) return { ...recipe, steps: [], step_ingredients: null };
  // JSON-LD's own name, yield and time are what the site published; the model's fill the gaps.
  const fallbackName = (jsonLd?.name ?? page.title ?? '').replace(/\s+/g, ' ').trim();
  return {
    ...recipe,
    name: recipe.name || truncateText(fallbackName, MAX_RECIPE_NAME_LENGTH).trimEnd(),
    servings: jsonLd?.servings ?? recipe.servings,
    total_minutes: jsonLd?.totalMinutes ?? recipe.total_minutes,
    image_url: jsonLd?.imageUrl ?? page.imageUrl,
  };
}

/**
 * Imports one recipe link (spec §6.6 flow). Throws `ImportRecipeError` for every expected failure.
 * Only extractions of pages the server fetched are cached, `not_a_recipe` answers included.
 */
export async function importRecipe(request: RecipeImportRequest, deps: ImportDeps): Promise<RecipeImportResponse> {
  try {
    // A household the caller isn't in is refused here too.
    await deps.store.requireFeature('recipe_import', request.householdId);
  } catch (err) {
    if (err instanceof NotEntitledError) {
      throw new ImportRecipeError({ code: 'not_entitled' }, "Recipe import isn't included in your plan");
    }
    throw err;
  }
  const caller = callerIn(deps.caller, request.householdId);
  const now = deps.now ?? Date.now;
  const urlKey = canonicalRecipeUrl(request.url);
  if (!urlKey) throw new ImportRecipeError({ code: 'invalid_url' }, 'Not an http(s) URL');
  if (!isAiEnabled('extractRecipe')) {
    throw new ImportRecipeError({ code: 'unavailable', reason: 'ai_off' }, 'Recipe import is turned off');
  }

  const limit = await deps.store.checkLimit();
  if (limit === 'user_limit') throw new ImportRecipeError({ code: 'rate_limited' }, 'Too many imports; try again later');
  if (limit === 'daily_limit') throw new ImportRecipeError({ code: 'daily_limit' }, "Today's recipe imports are used up");
  if (limit === 'monthly_limit') throw new ImportRecipeError({ code: 'limit_reached' }, "This month's recipe imports are used up");

  let recipe: ExtractedRecipe | null = null;
  const cached = await deps.store.getCached(urlKey, EXTRACT_RECIPE_PROMPT_VERSION);
  if (cached && now() - Date.parse(cached.created_at) < CACHE_MAX_AGE_MS) {
    const parsed = ExtractedRecipeSchema.safeParse(cached.result);
    if (parsed.success) recipe = parsed.data;
  }

  if (!recipe) {
    let page: Page;
    if (request.page) {
      const url = request.url.trim();
      const jsonLd = request.page.jsonLd ?? [];
      page = {
        url,
        title: request.page.title ?? null,
        jsonLd,
        text: request.page.text ?? '',
        imageUrl: clientPageImage(jsonLd, request.page.imageUrl, url),
      };
    } else {
      try {
        const fetched = await deps.fetchPage(request.url.trim());
        page = { ...fetched, url: fetched.finalUrl };
      } catch (err) {
        if (err instanceof FetchPageError) throw fetchFailure(err);
        throw err;
      }
    }
    recipe = await extract(page, { ...deps, caller });
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
  return importResponse(recipe, urlKey, (names) => deps.categorize(names, caller));
}

/**
 * The caller as an import's `ai_calls` rows record it: in the household the recipe is saved to,
 * which `requireFeature` has checked they're in (none from old builds).
 */
export function callerIn(caller: AiCaller | undefined, householdId: string | undefined): AiCaller | undefined {
  return caller && { ...caller, householdId: householdId ?? null };
}

/**
 * Steps 6 and 7 of the flow (spec 6.6), shared with a photo import (6.10): the ingredient names go
 * to `categorize` (whose own limits only leave them `pending`), then the response. `sourceUrl` is
 * the canonical URL, or null for a photo.
 */
export async function importResponse(
  recipe: ExtractedRecipe,
  sourceUrl: string | null,
  categorize: ImportDeps['categorize'],
): Promise<RecipeImportResponse> {
  const lines = recipe.ingredients.map((item) => ({ ...item, key: normalizeIngredientName(item.name) }));
  let categories: CategorizeResponse['results'] = {};
  try {
    categories = (await categorize(lines.map((l) => l.name))).results;
  } catch (err) {
    // Categorize's own limits (per minute or per day): the recipe still imports, and the app sorts
    // the names later.
    if (!(err instanceof CategorizeLimitError)) throw err;
  }

  return {
    name: recipe.name,
    sourceUrl,
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
    tags: recipe.tags,
    totalMinutes: recipe.total_minutes,
    steps: recipe.steps,
    stepIngredients: stepIngredients(recipe),
    imageUrl: recipe.image_url,
  };
}

/**
 * The step match as the app reads it: indexes into the response's `ingredients`, which are the
 * extraction's in the same order. Null with no match, or when it no longer lines up with the steps
 * and ingredients (a cached row is checked again here).
 */
function stepIngredients(recipe: ExtractedRecipe): RecipeImportResponse['stepIngredients'] {
  const match = recipe.step_ingredients;
  // One entry per step string: headings aren't steps.
  if (!match || match.length === 0 || match.length !== stepTexts(recipe.steps).length) return null;
  if (match.some((uses) => uses.some((use) => use.ingredient >= recipe.ingredients.length))) return null;
  return match.map((uses) => uses.map((use) => ({ index: use.ingredient, quantity: use.quantity })));
}
