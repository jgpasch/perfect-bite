import { router } from 'expo-router';
import { ActionSheetIOS, Alert } from 'react-native';

import { collectImportPhotos, photosParam } from '@/features/recipes/photo-import';
import type { PhotoSource } from '@/features/recipes/photo-upload';
import { i18n } from '@/i18n';

/** From photo… (spec 4.5): Take photo / Choose from library / Cancel. */
export function chooseSource(run: (from: PhotoSource) => void) {
  const sources: PhotoSource[] = ['camera', 'library'];
  const options = [i18n.t('recipes.add.takePhoto'), i18n.t('recipes.add.chooseFromLibrary'), i18n.t('common.cancel')];
  ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: sources.length }, (index) => {
    const from = sources[index];
    if (from) run(from);
  });
}

/** After a camera shot: Add another page, or Use photos. */
export function askForAnother(): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(i18n.t('recipes.add.anotherPage'), undefined, [
      { text: i18n.t('recipes.add.usePhotos'), style: 'cancel', onPress: () => resolve(false) },
      { text: i18n.t('recipes.add.addAnotherPage'), onPress: () => resolve(true) },
    ]),
  );
}

export function cameraDenied() {
  Alert.alert(i18n.t('recipes.photo.cameraDeniedTitle'), i18n.t('recipes.photo.cameraDenied'));
}

/**
 * From photo… away from the Add recipe sheet (the tab bar's + menu, spec 4.1): the same choices, then the
 * pages go to the import sheet (4.10).
 */
export function importRecipeFromPhoto() {
  chooseSource(async (from) => {
    try {
      const photos = await collectImportPhotos(from, { askForAnother, onDenied: cameraDenied });
      if (photos) router.push({ pathname: '/import-recipe', params: { photos: photosParam(photos) } });
    } catch (e) {
      console.warn('[photo import] pick failed', e);
    }
  });
}
