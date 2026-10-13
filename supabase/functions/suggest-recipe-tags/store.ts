import type { SupabaseClient } from '@supabase/supabase-js';

import { requireFeature } from '../_shared/entitlements.ts';
import type { LimitResult } from '../categorize-ingredients/handler.ts';
import type { SuggestTagsStore } from './handler.ts';

/**
 * SuggestTagsStore over the service-role client. The plan check and the rate limit are per
 * `userId`, and the global limit is `dailyCap` suggestions a day. `ai_calls` has no user id.
 */
export function createSuggestTagsStore(admin: SupabaseClient, limits: { userId: string; dailyCap: number }): SuggestTagsStore {
  return {
    requireFeature(feature) {
      return requireFeature(admin, limits.userId, feature);
    },

    async checkLimit() {
      const { data, error } = await admin.rpc('check_recipe_tags_limit', {
        p_user_id: limits.userId,
        p_daily_cap: limits.dailyCap,
      });
      if (error) throw error;
      return data as LimitResult;
    },

    async logAiCall(call) {
      const { error } = await admin.from('ai_calls').insert(call);
      if (error) throw error;
    },
  };
}
