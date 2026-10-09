import { Alert } from 'react-native';

import { createRecipe, getRecipe, updateRecipe } from './recipes';

/**
 * Asks for a recipe name with the system text prompt: renames `recipeId`, or creates a recipe
 * when it is null. Calls `onCreated` with the new recipe's id.
 * TODO(M9): Alert.prompt is iOS-only; use a sheet if Android ships.
 */
export function promptRecipeName(recipeId: string | null, current = '', onCreated?: (id: string) => void): void {
  Alert.prompt(
    recipeId ? 'Rename recipe' : 'New recipe',
    undefined,
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: recipeId ? 'Save' : 'Create',
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
