import type { SupabaseClient } from '@supabase/supabase-js';

import type { LimitResult } from '../categorize-ingredients/handler.ts';
import type { RecipePhotosStore } from './handler.ts';

/**
 * RecipePhotosStore over the service-role client. The rate limit is per `userId`.
 */
export function createRecipePhotosStore(admin: SupabaseClient, limits: { userId: string }): RecipePhotosStore {
  return {
    async checkLimit() {
      const { data, error } = await admin.rpc('check_recipe_photos_limit', { p_user_id: limits.userId });
      if (error) throw error;
      return data as LimitResult;
    },
  };
}
