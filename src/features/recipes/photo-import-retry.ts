// An in-app import's result notification (spec 4.10, 4.11), and a failed photo import's Try again
// and review sheet (spec 4.10 **Failed photo imports**): the kept pages go to `import-recipe-photo`
// again with "Importing your recipe" and its result, as for a new photo import.
import { router } from 'expo-router';

import { openList } from '@/features/lists/current-list';
import { getList } from '@/features/lists/lists';
import { setRecipeAddResult } from '@/features/lists/recipe-add-result';
import { dismissNotification, notify, type AppNotification } from '@/features/notifications/notifications';
import { i18n } from '@/i18n';

import { failedImportEntry, getFailedImport, householdName, retryFailedImport } from './failed-imports';
import type { ImportRecipePhotosError, ImportRecipePhotosResult } from './import';
import {
  importedNotification,
  importingNotification,
  importNotificationId,
  photoImportFailedNotification,
  savedNotification,
} from './import-notifications';
import { collectImportPhotos, photosParam } from './photo-import';
import { askForAnother, cameraDenied, chooseSource } from './photo-import-prompts';

/** What a failure posts (its own id is replaced by the import's), with what tapping it does. */
export type ImportFailure = (error: ImportRecipePhotosError) => AppNotification;

/**
 * Posts an import's result under the Importing banner's `id`, so it replaces it: "Recipe added"
 * (tapping opens the list with its toast), "Recipe saved" into `householdName` (opens the recipe),
 * or `failure`'s notification.
 */
export function postImportResult(
  id: string,
  result: ImportRecipePhotosResult,
  householdName: string,
  failure: ImportFailure,
): void {
  if (!result.ok) {
    notify({ ...failure(result), id });
    return;
  }
  const addedTo = result.listId;
  if (addedTo === null) {
    notify({
      ...savedNotification(result, householdName),
      id,
      onPress: () => router.push({ pathname: '/recipe/[id]', params: { id: result.recipeId } }),
    });
    return;
  }
  const listName = getList(addedTo)?.name ?? i18n.t('recipes.import.yourList');
  notify({
    ...importedNotification(result, listName),
    id,
    // Its toast (Undo, View recipe) shows on the list, which may be the one showing already.
    onPress: () => {
      setRecipeAddResult({
        kind: 'imported',
        listId: addedTo,
        recipeId: result.recipeId,
        recipeName: result.recipeName,
        count: result.added,
        undo: result.undo,
      });
      openList(addedTo);
    },
  });
}

/**
 * Opens a failed photo import's review sheet (board D), with `photos` in place of its kept pages
 * when given (Use other photos). Without a row (its pages couldn't be kept), Add recipe.
 */
export function openFailedPhotoImport(failedImportId: string | undefined, photos?: readonly string[]): void {
  if (!failedImportId) {
    router.push('/add-recipe');
    return;
  }
  router.push({
    pathname: '/import-recipe',
    params: { failed: failedImportId, ...(photos ? { photos: photosParam(photos) } : {}) },
  });
}

/** A photo import's failure notification, opening its review sheet. */
export const photoImportFailure: ImportFailure = (error) => ({
  ...photoImportFailedNotification(error),
  onPress: () => openFailedPhotoImport(error.failedImportId),
});

/**
 * Try again for a failed photo import, on the card or in the review sheet: "Importing your recipe",
 * then the result in its place. Null (and the banner taken down) when nothing was tried: a retry
 * already running, or the row or its pages gone.
 */
export async function retryFailedPhotoImport(failedImportId: string, userId: string): Promise<ImportRecipePhotosResult | null> {
  const row = getFailedImport(failedImportId);
  if (!row) return null;
  // For "Recipe saved", the household a recipe-only Try again saves into.
  const householdId = failedImportEntry(row, userId).householdId;
  const savedTo = (householdId && householdName(householdId)) || i18n.t('recipes.import.yourRecipes');
  const id = importNotificationId();
  notify(importingNotification(id));
  const result = await retryFailedImport(failedImportId, userId);
  if (!result) {
    dismissNotification(id);
    return null;
  }
  postImportResult(id, result, savedTo, photoImportFailure);
  return result;
}

/** Use other photos (board E): Take photo / Choose from library, then the review sheet with the new pages. */
export function pickOtherPhotos(failedImportId: string): void {
  chooseSource(async (from) => {
    try {
      const photos = await collectImportPhotos(from, { askForAnother, onDenied: cameraDenied });
      if (photos) openFailedPhotoImport(failedImportId, photos);
    } catch (e) {
      console.warn('[photo import] pick failed', e);
    }
  });
}
