import type { PhotoSearchResponse } from '@shared/index.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { LimitResult } from '../categorize-ingredients/handler.ts';
import type { PhotoSearchStore } from './handler.ts';

/**
 * PhotoSearchStore over the service-role client. The rate limit is per `userId`, and the global
 * limit is `dailyCap` searches a day. The cache has no user id.
 */
export function createPhotoSearchStore(admin: SupabaseClient, limits: { userId: string; dailyCap: number }): PhotoSearchStore {
  return {
    async checkLimit(cached) {
      const { data, error } = await admin.rpc('check_photo_search_limit', {
        p_user_id: limits.userId,
        p_daily_cap: limits.dailyCap,
        p_cached: cached,
      });
      if (error) throw error;
      return data as LimitResult;
    },

    async getCached(queryKey, page) {
      const { data, error } = await admin.rpc('get_photo_search_cache', { p_query_key: queryKey, p_page: page });
      if (error) throw error;
      return (data ?? null) as PhotoSearchResponse | null;
    },

    async saveCached(queryKey, page, answer) {
      const { error } = await admin.rpc('save_photo_search_cache', { p_query_key: queryKey, p_page: page, p_answer: answer });
      if (error) throw error;
    },
  };
}
