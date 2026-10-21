// Plan checks for Edge Functions (spec 4.12). Every check goes through `public.has_feature`, the
// only place a plan is resolved. Plans are per household: `has_feature` resolves the plan of the
// household the action is in. Only recipe import (link and photo share `recipe_import`) and AI
// photos are plan features; categorizing, tag suggestions and step ingredients are for everyone
// and aren't checked.
import type { SupabaseClient } from '@supabase/supabase-js';

/** The features a plan can grant (`plan_features.feature`). */
export type Feature = 'recipe_import' | 'recipe_photo_ai';

/** The household's plan doesn't include `feature`. Functions answer 403 `not_entitled`. */
export class NotEntitledError extends Error {
  override name = 'NotEntitledError';
  constructor(readonly feature: Feature) {
    super(`Your plan doesn't include ${feature}`);
  }
}

/**
 * Throws NotEntitledError unless the household's plan has `feature`. `householdId` is the
 * household the action is in, when known: `has_feature` answers false unless `userId` is a member
 * of it. With no household, it answers true when any of the user's households' plans has
 * `feature`. A database error is thrown as is.
 */
export async function requireFeature(
  admin: Pick<SupabaseClient, 'rpc'>,
  userId: string,
  feature: Feature,
  householdId?: string,
): Promise<void> {
  const { data, error } = await admin.rpc('has_feature', {
    p_user_id: userId,
    p_feature: feature,
    p_household_id: householdId ?? null,
  });
  if (error) throw error;
  if (data !== true) throw new NotEntitledError(feature);
}

/**
 * Whether `userId` is a member of `householdId`. For functions that only record a request's
 * household on `ai_calls` (tags, step matching): a household the caller isn't in is left off.
 */
export async function isHouseholdMember(
  admin: Pick<SupabaseClient, 'from'>,
  userId: string,
  householdId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from('household_members')
    .select('household_id')
    .eq('household_id', householdId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}
