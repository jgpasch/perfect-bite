// The in-app notification for an import whose sheet was closed while it read (spec 4.10, 4.11). Pure
// content: the caller supplies what tapping does.

import { recipeHue } from '@/domain/aisle-color';
import type { AppNotification } from '@/features/notifications/notifications';

import type { ImportRecipeError, ImportRecipeSuccess } from './import';
import { importErrorMessage } from './import-sheet';

type Content = Omit<AppNotification, 'onPress'>;

/** "Recipe added" · "Added Chicken tikka masala · 12 items to Groceries", the name in bold. */
export function importedNotification(result: ImportRecipeSuccess, listName: string): Content {
  const items = `${result.added} ${result.added === 1 ? 'item' : 'items'}`;
  return {
    id: `recipe-import-${result.recipeId}`,
    kind: 'recipeImport',
    icon: 'fork.knife',
    hue: recipeHue(result.recipeId),
    tone: 'success',
    title: 'Recipe added',
    body: `Added ${result.recipeName} · ${items} to ${listName}`,
    emphasis: result.recipeName,
    hint: `Opens ${listName}`,
  };
}

/** "Couldn't import recipe" with the sheet's plain-words reason. Keyed by link, so a retry replaces it. */
export function importFailedNotification(error: ImportRecipeError, url: string): Content {
  return {
    id: `recipe-import-failed-${url}`,
    kind: 'recipeImport',
    icon: 'exclamationmark.triangle.fill',
    hue: 'rose',
    tone: 'warning',
    title: "Couldn't import recipe",
    body: importErrorMessage(error),
    hint: 'Opens the link again to try once more',
  };
}
