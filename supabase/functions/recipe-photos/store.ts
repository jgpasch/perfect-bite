import type { SupabaseClient } from '@supabase/supabase-js';

import type { LimitResult } from '../categorize-ingredients/handler.ts';
import type { RecipePhotosStore } from './handler.ts';

/**
 * RecipePhotosStore over the service-role client. The rate limit is per `userId`, and the global
 * limit is `dailyCap` requests a day.
 */
export function createRecipePhotosStore(admin: SupabaseClient, limits: { userId: string; dailyCap: number }): RecipePhotosStore {
  return {
    async checkLimit() {
      const { data, error } = await admin.rpc('check_recipe_photos_limit', {
        p_user_id: limits.userId,
        p_daily_cap: limits.dailyCap,
      });
      if (error) throw error;
      return data as LimitResult;
    },
  };
}
