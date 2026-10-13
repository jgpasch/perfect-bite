// Tag suggestion (spec 4.14, 6.7): sends a saved recipe, as the device has it, to the
// `suggest-recipe-tags` Edge Function and returns the tags it suggests. Nothing here writes to the
// recipe: the Tags sheet shows the suggestion and the person saves it.
import { getNetworkStateAsync } from 'expo-network';

import { isOnline } from '@/features/categories/catch-up';
import { lostFeature } from '@/features/plans/load';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { RecipeTags } from '@/shared/recipe-tags';
import {
  SuggestRecipeTagsErrorSchema,
  SuggestRecipeTagsResponseSchema,
  type SuggestRecipeTagsRequestInput,
} from '@/shared/schemas/suggest-recipe-tags';

import { getRecipe, recipeIngredientsQuery } from './recipes';

/**
 * `offline`: no connection, session or config. `no-ingredients`: the recipe has none, so nothing
 * was sent. `not-entitled`: the plan has no `recipe_tags` (4.12). `rate-limited`: the per-user
 * limit. `unavailable`: the global cap, the kill switch or the model failed. `failed`: anything else.
 */
export type SuggestTagsError = 'offline' | 'no-ingredients' | 'not-entitled' | 'rate-limited' | 'unavailable' | 'failed';

export type SuggestTagsResult = { ok: true; tags: RecipeTags } | { ok: false; error: SuggestTagsError };

/**
 * What to tell the person for each error. The server answers both the per-minute and the per-day
 * limit with the same `rate_limited`, so `rate-limited` has one message.
 */
export const SUGGEST_TAGS_MESSAGES: Record<SuggestTagsError, string> = {
  offline: "You're offline. Try again when you're connected.",
  'no-ingredients': "Add some ingredients first, so there's something to go on.",
  'not-entitled': "Tag suggestions aren't included in your plan.",
  'rate-limited': "That's a lot of suggestions. Try again in a minute.",
  unavailable: "Couldn't suggest tags right now. Try again later.",
  failed: "Couldn't suggest tags right now. Try again later.",
};

export function suggestTagsMessage(error: SuggestTagsError): string {
  return SUGGEST_TAGS_MESSAGES[error];
}

/** The request for a recipe: its name, notes as stored and live ingredients in order. Null if it's gone. */
export function buildSuggestTagsRequest(recipeId: string): SuggestRecipeTagsRequestInput | null {
  const recipe = getRecipe(recipeId);
  if (!recipe) return null;
  return {
    name: recipe.name,
    notes: recipe.notes,
    ingredients: recipeIngredientsQuery(recipeId)
      .all()
      .map((i) => ({ name: i.displayName, quantity: i.quantity, unit: i.unit, note: i.note })),
  };
}

/** True only when the OS says there's no connection; unknown lets the call find out. */
async function knownOffline(): Promise<boolean> {
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
    if (error) return { ok: false, error: await errorCode(error) };
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
async function errorCode(error: unknown): Promise<SuggestTagsError> {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'FunctionsFetchError') return 'offline';
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
  if (code === 'not_entitled' || (!code && status === 403)) {
    // The plan has no tag suggestions: hide the entry points now and reload the plan (spec 4.12).
    void lostFeature('recipe_tags');
    return 'not-entitled';
  }
  if (code === 'rate_limited' || (!code && status === 429)) return 'rate-limited';
  if (code === 'unavailable' || (!code && status === 503)) return 'unavailable';
  console.warn('suggest-recipe-tags returned an error', error);
  return 'failed';
}
