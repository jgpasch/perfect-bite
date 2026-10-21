import type { SupabaseClient } from '@supabase/supabase-js';

import type { LimitResult } from '../categorize-ingredients/handler.ts';
import type { StepMatchStore } from './handler.ts';

/**
 * StepMatchStore over the service-role client. The rate limit is per `userId`. Each `ai_calls` row
 * carries the caller from the handler.
 */
export function createStepMatchStore(admin: SupabaseClient, limits: { userId: string }): StepMatchStore {
  return {
    async checkLimit() {
      const { data, error } = await admin.rpc('check_step_match_limit', { p_user_id: limits.userId });
      if (error) throw error;
      return data as LimitResult;
    },

    async logAiCall(call) {
      const { error } = await admin.from('ai_calls').insert(call);
      if (error) throw error;
    },
  };
}
