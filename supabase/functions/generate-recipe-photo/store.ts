import type { SupabaseClient } from '@supabase/supabase-js';

import { requireFeature } from '../_shared/entitlements.ts';
import type { RecipePhotoStore } from './handler.ts';

export const RECIPE_PHOTOS_BUCKET = 'recipe-photos';

/**
 * RecipePhotoStore over the service-role client. The plan check and the reservation are for
 * `userId` (the reservation also checks they're in the recipe's household). Each `ai_calls` row
 * carries the caller from the handler.
 */
export function createRecipePhotoStore(admin: SupabaseClient, limits: { userId: string }): RecipePhotoStore {
  return {
    requireFeature(feature) {
      return requireFeature(admin, limits.userId, feature);
    },

    async reserve(recipeId) {
      const { data, error } = await admin.rpc('reserve_recipe_photo_ai', {
        p_user_id: limits.userId,
        p_recipe_id: recipeId,
      });
      if (error) throw error;
      const row = (data as { status: string; household_id: string | null }[])[0];
      if (row?.status === 'ok' && row.household_id) return { status: 'ok', householdId: row.household_id };
      if (
        row?.status === 'blocked' ||
        row?.status === 'not_found' ||
        row?.status === 'already_generated' ||
        row?.status === 'user_limit' ||
        row?.status === 'daily_limit' ||
        row?.status === 'monthly_limit'
      ) {
        return { status: row.status };
      }
      throw new Error(`reserve_recipe_photo_ai answered ${JSON.stringify(data)}`);
    },

    // Only what the description needs: never steps, notes or the other tags.
    async readRecipe(recipeId, householdId) {
      const { data: recipe, error } = await admin
        .from('recipes')
        .select('name, tags')
        .eq('id', recipeId)
        .eq('household_id', householdId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error) throw error;
      if (!recipe) return null;
      const { data: rows, error: ingredientsError } = await admin
        .from('recipe_ingredients')
        .select('display_name')
        .eq('recipe_id', recipeId)
        .eq('household_id', householdId)
        .is('deleted_at', null)
        .order('position');
      if (ingredientsError) throw ingredientsError;
      return { name: recipe.name as string, tags: recipe.tags, ingredients: (rows ?? []).map((r) => r.display_name as string) };
    },

    async upload(path, bytes) {
      const { error } = await admin.storage.from(RECIPE_PHOTOS_BUCKET).upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
      if (error) throw error;
    },

    async complete(recipeId, description, path) {
      const { data, error } = await admin.rpc('complete_recipe_photo_ai', { p_recipe_id: recipeId, p_description: description, p_path: path });
      if (error) throw error;
      return data === true;
    },

    async release(recipeId) {
      const { error } = await admin.rpc('release_recipe_photo_ai', { p_recipe_id: recipeId });
      if (error) throw error;
    },

    async logAiCall(call) {
      const { error } = await admin.from('ai_calls').insert(call);
      if (error) throw error;
    },
  };
}
