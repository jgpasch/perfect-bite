import type { SupabaseClient } from '@supabase/supabase-js';

import type { LimitResult } from '../categorize-ingredients/handler.ts';
import type { SuggestTagsStore } from './handler.ts';

/**
 * SuggestTagsStore over the service-role client. The rate limit is per `userId`. Each `ai_calls`
 * row carries the caller from the handler.
 */
export function createSuggestTagsStore(admin: SupabaseClient, limits: { userId: string }): SuggestTagsStore {
  return {
    async checkLimit() {
      const { data, error } = await admin.rpc('check_recipe_tags_limit', { p_user_id: limits.userId });
      if (error) throw error;
      return data as LimitResult;
    },

    async logAiCall(call) {
      const { error } = await admin.from('ai_calls').insert(call);
      if (error) throw error;
    },
  };
}
