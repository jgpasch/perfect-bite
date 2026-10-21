import type { SupabaseClient } from '@supabase/supabase-js';

import { requireFeature } from '../_shared/entitlements.ts';
import type { LimitResult } from '../categorize-ingredients/handler.ts';
import type { CachedImport, RecipeImportStore } from './handler.ts';

/**
 * RecipeImportStore over the service-role client. `recipe_imports` has no user id; the plan check
 * and the rate limit are per `userId`.
 */
export function createRecipeImportStore(admin: SupabaseClient, limits: { userId: string }): RecipeImportStore {
  return {
    async checkLimit(householdId) {
      const { data, error } = await admin.rpc('check_recipe_import_limit', {
        p_user_id: limits.userId,
        p_household_id: householdId,
      });
      if (error) throw error;
      return data as LimitResult;
    },

    async getCached(urlKey, promptVersion) {
      const { data, error } = await admin
        .from('recipe_imports')
        .select('result, is_recipe, created_at')
        .eq('url_key', urlKey)
        .eq('prompt_version', promptVersion)
        .maybeSingle();
      if (error) throw error;
      return data as CachedImport | null;
    },

    async saveCached(urlKey, promptVersion, result) {
      const { error } = await admin.from('recipe_imports').upsert(
        {
          url_key: urlKey,
          prompt_version: promptVersion,
          result,
          is_recipe: result.is_recipe,
          created_at: new Date().toISOString(),
        },
        { onConflict: 'url_key,prompt_version' },
      );
      if (error) throw error;
    },

    async logAiCall(call) {
      const { error } = await admin.from('ai_calls').insert(call);
      if (error) throw error;
    },

    requireFeature(feature, householdId) {
      return requireFeature(admin, limits.userId, feature, householdId);
    },
  };
}
