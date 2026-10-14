import { Alert } from 'react-native';

import { i18n } from '@/i18n';

import { createRecipe, getRecipe, updateRecipe } from './recipes';

/**
 * Asks for a recipe name with the system text prompt: renames `recipeId`, or creates a recipe
 * when it is null. Calls `onCreated` with the new recipe's id.
 * TODO(M9): Alert.prompt is iOS-only; use a sheet if Android ships.
 */
export function promptRecipeName(recipeId: string | null, current = '', onCreated?: (id: string) => void): void {
  Alert.prompt(
    i18n.t(recipeId ? 'recipes.prompt.rename' : 'recipes.prompt.new'),
    undefined,
    [
      { text: i18n.t('common.cancel'), style: 'cancel' },
      {
        text: i18n.t(recipeId ? 'recipes.prompt.save' : 'recipes.prompt.create'),
        isPreferred: true,
        onPress: (name?: string) => {
          if (!name?.trim()) return;
          if (!recipeId) return onCreated?.(createRecipe(name));
          const recipe = getRecipe(recipeId);
          if (recipe) updateRecipe(recipeId, { name, notes: recipe.notes ?? '', sourceUrl: recipe.sourceUrl ?? '' });
        },
      },
    ],
    'plain-text',
    current,
  );
}
