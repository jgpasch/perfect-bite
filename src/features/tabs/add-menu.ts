import { router } from 'expo-router';
import { ActionSheetIOS } from 'react-native';

import type { IconName } from '@/components/icon';
import { importRecipeFromPhoto } from '@/features/recipes/photo-import-prompts';
import { pressAddButton } from '@/features/tabs/add-button';
import { i18n } from '@/i18n';

/** The long-press menu on the tab bar's + (spec 4.1), in order. */
export type AddMenuKey = 'item' | 'recipe' | 'link' | 'photo';

export type AddMenuEntry = { key: AddMenuKey; label: string; icon: IconName; onPress: () => void };

const ICONS: Record<AddMenuKey, IconName> = { item: 'plus', recipe: 'book', link: 'link', photo: 'camera' };

/** The menu's items: Add item and Add recipe always; the link and photo imports only with their features (4.12). */
export function addMenuKeys(features: { recipeImport: boolean; recipeImportPhoto: boolean }): AddMenuKey[] {
  return [
    'item',
    'recipe',
    ...(features.recipeImport ? (['link'] as const) : []),
    ...(features.recipeImportPhoto ? (['photo'] as const) : []),
  ];
}

/** Does an item: Add item is the same as a tap on +; the rest open the Add recipe sheet (4.5) or From photo…. */
export function runAddMenuItem(key: AddMenuKey) {
  if (key === 'item') pressAddButton();
  else if (key === 'recipe') router.push('/add-recipe');
  else if (key === 'link') router.push({ pathname: '/add-recipe', params: { focus: 'link' } });
  else importRecipeFromPhoto();
}

/** The items with their labels, icons and actions, for the menu. */
export function addMenuEntries(keys: readonly AddMenuKey[]): AddMenuEntry[] {
  return keys.map((key) => ({ key, label: i18n.t(`tabs.addMenu.${key}`), icon: ICONS[key], onPress: () => runAddMenuItem(key) }));
}

/** VoiceOver's "More ways to add": the native menu can't be opened from code, so the same items as a sheet. */
export function showAddMenuSheet(keys: readonly AddMenuKey[]) {
  const options = [...keys.map((key) => i18n.t(`tabs.addMenu.${key}`)), i18n.t('common.cancel')];
  ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: keys.length }, (index) => {
    const key = keys[index];
    if (key) runAddMenuItem(key);
  });
}
