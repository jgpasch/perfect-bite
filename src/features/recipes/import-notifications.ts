// The in-app notifications for an import from the sheet (spec 4.10, 4.11): "Importing your recipe" as
// the sheet closes, then its result. Pure content: the caller supplies what tapping does, and posts the
// result with the Importing one's id so it replaces that banner in place.

import { recipeHue } from '@/domain/aisle-color';
import type { AppNotification } from '@/features/notifications/notifications';
import { i18n } from '@/i18n';
import { newId } from '@/lib/id';

import type { ImportRecipeError, ImportRecipeSuccess } from './import';
import { importErrorMessage } from './import-sheet';

type Content = Omit<AppNotification, 'onPress'>;

/** A new id for one import's notifications: the Importing banner and then its result. */
export function importNotificationId(): string {
  return `recipe-import-${newId()}`;
}

/** "Importing your recipe" · "We'll let you know when it's ready.", as the sheet closes. Tapping only dismisses it. */
export function importingNotification(id: string): Content {
  return {
    id,
    kind: 'recipeImport',
    icon: 'fork.knife',
    hue: recipeHue(id),
    tone: 'success',
    title: i18n.t('notifications.importing'),
    body: i18n.t('notifications.importingBody'),
  };
}

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
