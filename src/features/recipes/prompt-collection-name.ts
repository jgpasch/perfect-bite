import { Alert } from 'react-native';

import { i18n } from '@/i18n';

import { COLLECTION_NAME_MAX, CollectionNameError, collectionNameProblem, createCollection } from './collections';

/** What a refused name shows: "There's already a collection called Mom's cookbook.", or the length limit. */
export function collectionNameMessage(error: CollectionNameError): string | null {
  if (error.problem === 'duplicate') return i18n.t('recipes.collections.duplicate', { name: error.name });
  if (error.problem === 'tooLong') return i18n.t('recipes.collections.tooLong', { max: COLLECTION_NAME_MAX });
  return null;
}

/**
 * Asks for a new collection's name with the system text prompt and creates it in the household, then
 * calls `onCreated` with its id. A blank name is dropped; a name already used (ignoring case and
 * accents) or too long shows why in an alert and creates nothing.
 * TODO(M9): Alert.prompt is iOS-only; use a sheet if Android ships.
 */
export function promptNewCollection(householdId: string, onCreated: (id: string) => void): void {
  Alert.prompt(
    i18n.t('recipes.collections.prompt'),
    undefined,
    [
      { text: i18n.t('common.cancel'), style: 'cancel' },
      {
        text: i18n.t('recipes.collections.create'),
        isPreferred: true,
        onPress: (name?: string) => {
          if (collectionNameProblem(householdId, name ?? '') === 'empty') return;
          try {
            onCreated(createCollection(householdId, name ?? ''));
          } catch (err) {
            if (!(err instanceof CollectionNameError)) throw err;
            const message = collectionNameMessage(err);
            if (message) Alert.alert(message);
          }
        },
      },
    ],
    'plain-text',
  );
}
