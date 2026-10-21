// Tag suggestion (spec 4.14, 6.7): sends a saved recipe, as the device has it, to the
// `suggest-recipe-tags` Edge Function and returns the tags it suggests. Nothing here writes to the
// recipe: the Tags sheet shows the suggestion and the person saves it.
import { getNetworkStateAsync } from 'expo-network';

import { isOnline } from '@/features/categories/catch-up';
import { i18n, onLanguageChanged } from '@/i18n';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { AiRecipeTags } from '@/shared/recipe-tags';
import {
  SuggestRecipeTagsErrorSchema,
  SuggestRecipeTagsResponseSchema,
  type SuggestRecipeTagsRequestInput,
} from '@/shared/schemas/suggest-recipe-tags';

import { getRecipe, recipeIngredientsQuery } from './recipes';

/**
 * `offline`: no connection, session or config. `no-ingredients`: the recipe has none, so nothing
 * was sent. `not-entitled`: an older server's plan answer (every plan suggests tags now, 4.12). `rate-limited`: the per-minute
 * limit. `daily-limit`: the user's suggestions today (the daily safety limit, 4.12).
 * `unavailable`: the kill switch or the model failed. `failed`: anything else.
 */
export type SuggestTagsError =
  | 'offline'
  | 'no-ingredients'
  | 'not-entitled'
  | 'rate-limited'
  | 'daily-limit'
  | 'unavailable'
  | 'failed';

/** A failed suggestion. Tag suggestions have no monthly limit (4.12). */
export type SuggestTagsFailure = { ok: false; error: SuggestTagsError };

export type SuggestTagsResult = { ok: true; tags: AiRecipeTags } | SuggestTagsFailure;

/** What to tell the person for each error. */
export let SUGGEST_TAGS_MESSAGES: Record<SuggestTagsError, string>;

/** The Tags sheet's line under Suggest tags once a suggestion comes back, and when nothing fit. */
export let SUGGESTED_NOTE = '';
export let NOTHING_SUGGESTED_NOTE = '';

// Module-level strings follow the app's language (live bindings, set once i18n is initialized).
onLanguageChanged(() => {
  SUGGEST_TAGS_MESSAGES = {
    offline: i18n.t('recipes.tags.errors.offline'),
    'no-ingredients': i18n.t('recipes.tags.errors.noIngredients'),
    'not-entitled': i18n.t('recipes.tags.errors.notEntitled'),
    'rate-limited': i18n.t('recipes.tags.errors.rateLimited'),
    'daily-limit': i18n.t('errors.dailyLimit'),
    unavailable: i18n.t('recipes.tags.errors.unavailable'),
    failed: i18n.t('recipes.tags.errors.unavailable'),
  };
  SUGGESTED_NOTE = i18n.t('recipes.tags.suggestedNote');
  NOTHING_SUGGESTED_NOTE = i18n.t('recipes.tags.nothingSuggested');
});

export function suggestTagsMessage(error: SuggestTagsError): string {
  return SUGGEST_TAGS_MESSAGES[error];
}

/** A failure's message. */
export function suggestTagsFailureMessage(failure: SuggestTagsFailure): string {
  return suggestTagsMessage(failure.error);
}

/**
 * The request for a recipe: its name, notes as stored, live ingredients in order and its household
 * (only recorded on the call's `ai_calls` row, spec 6.4). Null if it's gone.
 */
export function buildSuggestTagsRequest(recipeId: string): SuggestRecipeTagsRequestInput | null {
  const recipe = getRecipe(recipeId);
  if (!recipe) return null;
  return {
    name: recipe.name,
    notes: recipe.notes,
    ingredients: recipeIngredientsQuery(recipeId)
      .all()
      .map((i) => ({ name: i.displayName, quantity: i.quantity, unit: i.unit, note: i.note })),
    householdId: recipe.householdId,
  };
}

/** True only when the OS says there's no connection; unknown lets the call find out. */
export async function knownOffline(): Promise<boolean> {
  try {
    return !isOnline(await getNetworkStateAsync());
  } catch {
    return false;
  }
}

/** Asks the server to suggest tags for `recipeId`. Never throws and never writes to the recipe. */
export async function suggestRecipeTags(recipeId: string): Promise<SuggestTagsResult> {
  const body = buildSuggestTagsRequest(recipeId);
  if (!body) return { ok: false, error: 'failed' };
  if (body.ingredients.length === 0) return { ok: false, error: 'no-ingredients' };
  if (!isSupabaseConfigured || (await knownOffline())) return { ok: false, error: 'offline' };
  try {
    const { data: auth } = await supabase.auth.getSession();
    if (!auth.session) return { ok: false, error: 'offline' };
    const { data, error } = await supabase.functions.invoke('suggest-recipe-tags', { body });
    if (error) return await failure(error);
    const parsed = SuggestRecipeTagsResponseSchema.safeParse(data);
    if (!parsed.success) {
      console.warn('suggest-recipe-tags: unexpected response', parsed.error);
      return { ok: false, error: 'failed' };
    }
    return { ok: true, tags: parsed.data.tags };
  } catch (e) {
    console.warn('suggest-recipe-tags failed', e);
    return { ok: false, error: 'offline' };
  }
}

/** Maps a `functions.invoke` error: a network failure is offline, an HTTP error by its code, else its status. */
async function failure(error: unknown): Promise<SuggestTagsFailure> {
  const fail = (code: SuggestTagsError): SuggestTagsFailure => ({ ok: false, error: code });
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'FunctionsFetchError') return fail('offline');
  const response = (error as { context?: unknown } | null)?.context as
    | { status?: number; json?: () => Promise<unknown> }
    | undefined;
  let code: string | undefined;
  try {
    const parsed = SuggestRecipeTagsErrorSchema.safeParse(await response?.json?.());
    if (parsed.success) code = parsed.data.error;
  } catch {
    // Not a JSON body; fall back to the status.
  }
  const status = response?.status;
  // An older server's plan answer; every plan has tag suggestions now (spec 4.12).
  if (code === 'not_entitled' || (!code && status === 403)) return fail('not-entitled');
  if (code === 'daily_limit') return fail('daily-limit');
  if (code === 'rate_limited' || (!code && status === 429)) return fail('rate-limited');
  if (code === 'unavailable' || (!code && status === 503)) return fail('unavailable');
  console.warn('suggest-recipe-tags returned an error', error);
  return fail('failed');
}
