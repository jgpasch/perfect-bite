// The in-app notification for an import whose sheet was closed while it read (spec 4.10, 4.11). Pure
// content: the caller supplies what tapping does.

import { recipeHue } from '@/domain/aisle-color';
import type { AppNotification } from '@/features/notifications/notifications';
import { i18n } from '@/i18n';

import type { ImportRecipeError, ImportRecipeSuccess } from './import';
import { importErrorMessage } from './import-sheet';

type Content = Omit<AppNotification, 'onPress'>;

/** "Recipe added" · "Added Chicken tikka masala · 12 items to Groceries", the name in bold. */
export function importedNotification(result: ImportRecipeSuccess, listName: string): Content {
  const items = i18n.t('notifications.items', { count: result.added });
  return {
    id: `recipe-import-${result.recipeId}`,
    kind: 'recipeImport',
    icon: 'fork.knife',
    hue: recipeHue(result.recipeId),
    tone: 'success',
    title: i18n.t('notifications.recipeAdded'),
    body: i18n.t('notifications.recipeAddedBody', { name: result.recipeName, items, list: listName }),
    emphasis: result.recipeName,
    hint: i18n.t('notifications.opens', { name: listName }),
  };
}

/** A recipe-only import: "Recipe saved" · "Saved Chicken tikka masala to Smith home", the name in bold. */
export function savedNotification(result: ImportRecipeSuccess, householdName: string): Content {
  return {
    id: `recipe-import-${result.recipeId}`,
    kind: 'recipeImport',
    icon: 'fork.knife',
    hue: recipeHue(result.recipeId),
    tone: 'success',
    title: i18n.t('notifications.recipeSaved'),
    body: i18n.t('notifications.recipeSavedBody', { name: result.recipeName, household: householdName }),
    emphasis: result.recipeName,
    hint: i18n.t('notifications.opensRecipe'),
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
    title: i18n.t('notifications.importFailed'),
    body: importErrorMessage(error),
    hint: i18n.t('notifications.importFailedHint'),
  };
}

/**
 * A photo import's "Couldn't import recipe", with the sheet's reason for photos. Its photos are gone
 * with the sheet, so tapping it starts again from Add recipe; one id, so a retry replaces it.
 */
export function photoImportFailedNotification(error: ImportRecipeError): Content {
  return {
    ...importFailedNotification(error, 'photo'),
    body: importErrorMessage(error, 'photo'),
    hint: i18n.t('notifications.photoImportFailedHint'),
  };
}
