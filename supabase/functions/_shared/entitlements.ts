// Plan checks for Edge Functions (spec 4.12). Every check goes through `public.has_feature`, the
// only place a plan is resolved, so plans can go per household by changing only that function.
import type { SupabaseClient } from '@supabase/supabase-js';

/** The features a plan can grant (`plan_features.feature`). */
export type Feature =
  | 'categorize'
  | 'recipe_import'
  | 'recipe_import_photo'
  | 'recipe_photo_ai'
  | 'recipe_tags'
  | 'step_ingredients';

/** The caller's plan doesn't include `feature`. Functions answer 403 `not_entitled`. */
export class NotEntitledError extends Error {
  override name = 'NotEntitledError';
  constructor(readonly feature: Feature) {
    super(`Your plan doesn't include ${feature}`);
  }
}

/**
 * Throws NotEntitledError unless `userId`'s plan has `feature`. `householdId` is the household the
 * action is in, when known; `has_feature` ignores it today. A database error is thrown as is.
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
