import type { SupabaseClient } from '@supabase/supabase-js';

import type { CategorizedAnswer, CategorizeStore, IngredientRow, LimitResult } from './handler.ts';

/**
 * CategorizeStore over the service-role client. `ingredients` is global: no user filter. The rate
 * limit is per `userId`.
 */
export function createCategorizeStore(admin: SupabaseClient, limits: { userId: string }): CategorizeStore {
  const ingredients = () => admin.from('ingredients');

  return {
    async getIngredients(names) {
      if (names.length === 0) return [];
      const { data, error } = await ingredients()
        .select('normalized_name, display_name, status, default_category_id, is_grocery_item, default_unit, attempts, lang, same_as, linked_by')
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
      // One update per (category, is_grocery_item, unit, lang) rather than one per name.
      const groups = new Map<string, CategorizedAnswer[]>();
      for (const row of rows) {
        const key = `${row.default_category_id}:${row.is_grocery_item}:${row.default_unit}:${row.lang}`;
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
            // An unknown language never clears a known one.
            ...(group[0].lang ? { lang: group[0].lang } : {}),
          })
          .in('normalized_name', group.map((r) => r.normalized_name))
          .neq('status', 'categorized');
        if (error) throw error;
      }
    },

    async saveFailed(names) {
      // `public.fail_ingredients`: one statement, as PostgREST can't express `attempts + 1`.
      if (names.length === 0) return;
      const { error } = await admin.rpc('fail_ingredients', { p_names: names });
      if (error) throw error;
    },

    async insertTwins(rows, categorizedBy) {
      if (rows.length === 0) return;
      const { error } = await ingredients().upsert(
        rows.map((r) => ({ ...r, status: 'categorized', categorized_by: categorizedBy, household_count: 0 })),
        { onConflict: 'normalized_name', ignoreDuplicates: true },
      );
      if (error) throw error;
    },

    async getLinkTargets(names) {
      if (names.length === 0) return [];
      const { data, error } = await ingredients().select('same_as').in('same_as', names);
      if (error) throw error;
      return [...new Set((data as { same_as: string }[]).map((r) => r.same_as))];
    },

    async link(name, target, linkedBy) {
      const { data, error } = await ingredients()
        .update({ same_as: target, linked_by: linkedBy })
        .eq('normalized_name', name)
        .is('same_as', null)
        .select('normalized_name');
      // The one-level trigger (check_violation) refuses a link a concurrent one made into a chain.
      if (error?.code === '23514') return false;
      if (error) throw error;
      return (data ?? []).length > 0;
    },

    async logAiCall(call) {
      const { error } = await admin.from('ai_calls').insert(call);
      if (error) throw error;
    },

    async checkLimit(newNames) {
      const { data, error } = await admin.rpc('check_categorize_limit', {
        p_user_id: limits.userId,
        p_new_names: newNames,
      });
      if (error) throw error;
      return data as LimitResult;
    },
  };
}
