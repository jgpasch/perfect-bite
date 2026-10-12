import { OTHER_CATEGORY_ID } from '@shared/index.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

import { requireFeature } from '../_shared/entitlements.ts';
import type { CategorizedAnswer, CategorizeStore, IngredientRow, LimitResult } from './handler.ts';

/**
 * CategorizeStore over the service-role client. `ingredients` is global: no user filter. The plan
 * check and the rate limit are per `userId`; the global limit is `dailyNameCap` new names a day.
 */
export function createCategorizeStore(
  admin: SupabaseClient,
  limits: { userId: string; dailyNameCap: number },
): CategorizeStore {
  const ingredients = () => admin.from('ingredients');

  return {
    async getIngredients(names) {
      if (names.length === 0) return [];
      const { data, error } = await ingredients()
        .select('normalized_name, status, default_category_id, is_grocery_item, default_unit, attempts')
        .in('normalized_name', names);
      if (error) throw error;
      return data as IngredientRow[];
    },

    async insertPending(rows) {
      const { error } = await ingredients().upsert(
        rows.map((r) => ({ ...r, status: 'pending' })),
        { onConflict: 'normalized_name', ignoreDuplicates: true },
      );
      if (error) throw error;
    },

    async saveCategorized(rows, categorizedBy) {
      // One update per (category, is_grocery_item, unit) rather than one per name.
      const groups = new Map<string, CategorizedAnswer[]>();
      for (const row of rows) {
        const key = `${row.default_category_id}:${row.is_grocery_item}:${row.default_unit}`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      for (const group of groups.values()) {
        const { error } = await ingredients()
          .update({
            status: 'categorized',
            default_category_id: group[0].default_category_id,
            is_grocery_item: group[0].is_grocery_item,
            default_unit: group[0].default_unit,
            categorized_by: categorizedBy,
          })
          .in('normalized_name', group.map((r) => r.normalized_name))
          .neq('status', 'categorized');
        if (error) throw error;
      }
    },

    async saveFailed(names) {
      // PostgREST can't express `attempts + 1`, so read and write back. The `attempts` match makes
      // a concurrent increment win instead of being counted twice.
      const { data, error } = await ingredients()
        .select('normalized_name, attempts')
        .in('normalized_name', names)
        .neq('status', 'categorized');
      if (error) throw error;
      for (const row of data as { normalized_name: string; attempts: number }[]) {
        const { error: updateError } = await ingredients()
          .update({ status: 'failed', default_category_id: OTHER_CATEGORY_ID, attempts: row.attempts + 1 })
          .eq('normalized_name', row.normalized_name)
          .eq('attempts', row.attempts)
          .neq('status', 'categorized');
        if (updateError) throw updateError;
      }
    },

    async logAiCall(call) {
      const { error } = await admin.from('ai_calls').insert(call);
      if (error) throw error;
    },

    async checkLimit(newNames) {
      const { data, error } = await admin.rpc('check_categorize_limit', {
        p_user_id: limits.userId,
        p_new_names: newNames,
        p_daily_cap: limits.dailyNameCap,
      });
      if (error) throw error;
      return data as LimitResult;
    },

    requireFeature(feature) {
      return requireFeature(admin, limits.userId, feature);
    },
  };
}
