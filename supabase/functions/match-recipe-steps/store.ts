import type { SupabaseClient } from '@supabase/supabase-js';

import { requireFeature } from '../_shared/entitlements.ts';
import type { LimitResult } from '../categorize-ingredients/handler.ts';
import type { StepMatchStore } from './handler.ts';

/**
 * StepMatchStore over the service-role client. The plan check and the rate limit are per
 * `userId`, and the global limit is `dailyCap` matches a day. `ai_calls` has no user id.
 */
export function createStepMatchStore(admin: SupabaseClient, limits: { userId: string; dailyCap: number }): StepMatchStore {
  return {
    requireFeature(feature) {
      return requireFeature(admin, limits.userId, feature);
    },

    async checkLimit() {
      const { data, error } = await admin.rpc('check_step_match_limit', {
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
