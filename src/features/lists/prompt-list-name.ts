import { Alert } from 'react-native';

import { i18n } from '@/i18n';

import { createList, renameList } from './lists';

/**
 * Asks for a list name with the system text prompt: renames `listId`, or creates a list when it
 * is null (in `householdId`, else the first household). Calls `onCreated` with the new list's id.
 * TODO(M9): Alert.prompt is iOS-only; use a sheet if Android ships.
 */
export function promptListName(
  listId: string | null,
  current = '',
  onCreated?: (id: string) => void,
  householdId?: string,
): void {
  Alert.prompt(
    listId ? i18n.t('lists.prompt.rename') : i18n.t('lists.prompt.new'),
    undefined,
    [
      { text: i18n.t('common.cancel'), style: 'cancel' },
      {
        text: listId ? i18n.t('lists.prompt.save') : i18n.t('lists.prompt.create'),
        isPreferred: true,
        onPress: (name?: string) => {
          if (!name?.trim()) return;
          if (listId) renameList(listId, name);
          else onCreated?.(createList(name, householdId));
        },
      },
    ],
    'plain-text',
    current,
  );
}
