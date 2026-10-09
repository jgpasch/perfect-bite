import { Alert } from 'react-native';

import { createList, renameList } from './lists';

/**
 * Asks for a list name with the system text prompt: renames `listId`, or creates a list when it
 * is null. Calls `onCreated` with the new list's id.
 * TODO(M9): Alert.prompt is iOS-only; use a sheet if Android ships.
 */
export function promptListName(listId: string | null, current = '', onCreated?: (id: string) => void): void {
  Alert.prompt(
    listId ? 'Rename list' : 'New list',
    undefined,
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: listId ? 'Save' : 'Create',
        isPreferred: true,
        onPress: (name?: string) => {
          if (!name?.trim()) return;
          if (listId) renameList(listId, name);
          else onCreated?.(createList(name));
        },
      },
    ],
    'plain-text',
    current,
  );
}
