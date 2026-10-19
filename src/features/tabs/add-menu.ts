import { router } from 'expo-router';
import { ActionSheetIOS } from 'react-native';

import type { IconName } from '@/components/icon';
import { pressAddButton } from '@/features/tabs/add-button';
import { markAddHintSeen } from '@/features/tabs/add-hint';
import { i18n } from '@/i18n';

/** The long-press menu on the tab bar's + (spec 4.1), in order. */
export type AddMenuKey = 'item' | 'recipe';

export type AddMenuEntry = { key: AddMenuKey; label: string; icon: IconName; onPress: () => void };

const ICONS: Record<AddMenuKey, IconName> = { item: 'plus', recipe: 'book' };

/** The menu's items. The link and photo imports live in the Add recipe sheet (4.5), not here. */
export const ADD_MENU_KEYS: readonly AddMenuKey[] = ['item', 'recipe'];

/** Does an item: Add item is the same as a tap on +; Add recipe opens the Add recipe sheet (4.5). */
export function runAddMenuItem(key: AddMenuKey) {
  if (key === 'item') pressAddButton();
  else router.push('/add-recipe');
}

/** The items with their labels, icons and actions, for the menu. */
export function addMenuEntries(keys: readonly AddMenuKey[]): AddMenuEntry[] {
  return keys.map((key) => ({ key, label: i18n.t(`tabs.addMenu.${key}`), icon: ICONS[key], onPress: () => runAddMenuItem(key) }));
}

/** The menu was opened by a long-press on +: the + hint (spec 4.1) has done its job, so it never shows. */
export function addMenuOpened() {
  markAddHintSeen();
}

/** VoiceOver's "More ways to add": the native menu can't be opened from code, so the same items as a sheet. */
export function showAddMenuSheet(keys: readonly AddMenuKey[]) {
  addMenuOpened();
  const options = [...keys.map((key) => i18n.t(`tabs.addMenu.${key}`)), i18n.t('common.cancel')];
  ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: keys.length }, (index) => {
    const key = keys[index];
    if (key) runAddMenuItem(key);
  });
}
