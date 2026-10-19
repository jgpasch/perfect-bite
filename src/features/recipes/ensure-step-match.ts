// Background step matching (spec 4.5, 6.8): sends a recipe's steps and live ingredients to the
// `match-recipe-steps` Edge Function and saves the answer as `recipes.step_ingredients`. Called
// after an import saves, after the Steps sheet's Save, 2 s after the last ingredient edit on the
// recipe screen, and when the recipe or cook screen opens (how older recipes get matched; there's
// no launch backfill). Silent: errors show nothing. Two household devices may both match; the last
// writer wins.
import { eq } from 'drizzle-orm';
import { useEffect } from 'react';

import { db, recipes } from '@/db';
import { hasFeature } from '@/features/plans/features';
import { lostFeature } from '@/features/plans/load';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { stepIngredientsBasis, stepTexts } from '@/shared';
import {
  MatchRecipeStepsErrorSchema,
  MatchRecipeStepsResponseSchema,
  type MatchRecipeStepsRequestInput,
} from '@/shared/schemas/match-recipe-steps';
import { updateRows } from '@/sync/mutate';

import { getRecipe, recipeIngredientsQuery } from './recipes';
import { stepMatch } from './step-match';
import { knownOffline } from './suggest-tags';

/** How long `unavailable` and `rate-limited` pause all matching. */
export const STEP_MATCH_PAUSE_MS = 60 * 60 * 1000;
/** The wait after the last ingredient edit on the recipe screen. */
export const STEP_MATCH_EDIT_DELAY_MS = 2000;

// In memory only: a relaunch starts afresh.
let pausedUntil = 0;
let stopped = false;
const inFlight = new Map<string, Promise<void>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** For tests: forgets the pauses, the session stop, the calls in flight and the edit timers. */
export function resetStepMatching(): void {
  pausedUntil = 0;
  stopped = false;
  inFlight.clear();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

/**
 * Matches `recipeId` if it needs it: skipped when matching is paused or stopped, the plan has no
 * `step_ingredients`, the recipe has no steps or no ingredients, its match is fresh, it's offline,
 * or a call for it is already in flight (that call's promise is returned). Never throws.
 */
export function ensureStepMatch(recipeId: string): Promise<void> {
  const running = inFlight.get(recipeId);
  if (running) return running;
  const run = match(recipeId).finally(() => inFlight.delete(recipeId));
  inFlight.set(recipeId, run);
  return run;
}

/** `ensureStepMatch` 2 s after the last call for the recipe: for ingredient edits. */
export function ensureStepMatchSoon(recipeId: string): void {
  clearTimeout(timers.get(recipeId));
  timers.set(
    recipeId,
    setTimeout(() => {
      timers.delete(recipeId);
      void ensureStepMatch(recipeId);
    }, STEP_MATCH_EDIT_DELAY_MS),
  );
}

/** Matches the recipe when a screen showing it opens. */
export function useEnsureStepMatch(recipeId: string | undefined): void {
  useEffect(() => {
    if (recipeId) void ensureStepMatch(recipeId);
  }, [recipeId]);
}

/** The request and its basis, or null when the recipe needs no call. */
function pending(recipeId: string): { body: MatchRecipeStepsRequestInput; basis: string } | null {
  const recipe = getRecipe(recipeId);
  if (!recipe) return null;
  // Only the step strings are sent, so the answer lines up with them.
  const steps = stepTexts(recipe.steps);
  if (!steps.some((s) => s.trim() !== '')) return null;
  const ingredients = recipeIngredientsQuery(recipeId).all();
  if (ingredients.length === 0) return null;
  if (stepMatch(recipe, ingredients).state === 'fresh') return null;
  return {
    basis: stepIngredientsBasis(
      steps,
      ingredients.map((i) => i.id),
    ),
    body: {
      steps,
      ingredients: ingredients.map((i) => ({
        id: i.id,
        name: i.displayName,
        quantity: i.quantity,
        unit: i.unit,
        note: i.note,
      })),
    },
  };
}

/** The recipe's basis as it is now; null once it's gone. */
function currentBasis(recipeId: string): string | null {
  const recipe = getRecipe(recipeId);
  if (!recipe) return null;
  return stepIngredientsBasis(
    recipe.steps,
    recipeIngredientsQuery(recipeId)
      .all()
      .map((i) => i.id),
  );
}

async function match(recipeId: string): Promise<void> {
  if (stopped || Date.now() < pausedUntil || !hasFeature('step_ingredients')) return;
  const request = pending(recipeId);
  if (!request || !isSupabaseConfigured || (await knownOffline())) return;
  try {
    const { data: auth } = await supabase.auth.getSession();
    if (!auth.session) return;
    const { data, error } = await supabase.functions.invoke('match-recipe-steps', { body: request.body });
    if (error) return await onError(error);
    const parsed = MatchRecipeStepsResponseSchema.safeParse(data);
    if (!parsed.success || parsed.data.steps.length !== request.body.steps.length) {
      console.warn('match-recipe-steps: unexpected response', parsed.error);
      return;
    }
    // The steps or ingredients changed during the call: this answer is for a recipe that's gone.
    if (currentBasis(recipeId) !== request.basis) return;
    updateRows(db, recipes, eq(recipes.id, recipeId), {
      stepIngredients: { v: 1, basis: request.basis, steps: parsed.data.steps },
    });
  } catch (e) {
    console.warn('match-recipe-steps failed', e);
  }
}

/**
 * `not_entitled` stops matching for the session, and so does `limit_reached` (the plan's monthly
 * matches are used up, spec 4.12; silent, as this is background work); `rate_limited` and
 * `unavailable` pause it for an hour.
 */
async function onError(error: unknown): Promise<void> {
  if ((error as { name?: unknown } | null)?.name === 'FunctionsFetchError') return;
  const response = (error as { context?: unknown } | null)?.context as
    | { status?: number; json?: () => Promise<unknown> }
    | undefined;
  let code: string | undefined;
  try {
    const parsed = MatchRecipeStepsErrorSchema.safeParse(await response?.json?.());
    if (parsed.success) code = parsed.data.error;
  } catch {
    // Not a JSON body; fall back to the status.
  }
  const status = response?.status;
  if (code === 'not_entitled' || (!code && status === 403)) {
    stopped = true;
    void lostFeature('step_ingredients');
    return;
  }
  if (code === 'limit_reached') {
    stopped = true;
    return;
  }
  if (code === 'rate_limited' || code === 'unavailable' || (!code && (status === 429 || status === 503))) {
    pausedUntil = Date.now() + STEP_MATCH_PAUSE_MS;
    return;
  }
  console.warn('match-recipe-steps returned an error', error);
}
