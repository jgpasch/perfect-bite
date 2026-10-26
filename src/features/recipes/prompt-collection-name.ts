import { Alert } from 'react-native';

import { i18n } from '@/i18n';

import {
  COLLECTION_NAME_MAX,
  CollectionNameError,
  collectionNameProblem,
  createCollection,
  renameCollection,
} from './collections';

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
          explainRefusal(() => onCreated(createCollection(householdId, name ?? '')));
        },
      },
    ],
    'plain-text',
  );
}

/**
 * The Collections shelf's New collection tile: with one household, `promptNewCollection` in it; with several,
 * first an alert asking which (in `households`' order). None: nothing.
 */
export function promptNewCollectionIn(households: readonly { id: string; name: string }[], onCreated: (id: string) => void): void {
  if (households.length === 0) return;
  if (households.length === 1) return promptNewCollection(households[0].id, onCreated);
  Alert.alert(i18n.t('recipes.collections.newIn'), undefined, [
    ...households.map((h) => ({ text: h.name, onPress: () => promptNewCollection(h.id, onCreated) })),
    { text: i18n.t('common.cancel'), style: 'cancel' as const },
  ]);
}

/**
 * Rename on a collection's screen: the same prompt holding the current name, and the same checks (its own
 * name in another case is fine). A blank name keeps the old one.
 * TODO(M9): Alert.prompt is iOS-only; use a sheet if Android ships.
 */
export function promptRenameCollection(collection: { id: string; householdId: string; name: string }): void {
  Alert.prompt(
    i18n.t('recipes.collections.renameTitle'),
    undefined,
    [
      { text: i18n.t('common.cancel'), style: 'cancel' },
      {
        text: i18n.t('common.save'),
        isPreferred: true,
        onPress: (name?: string) => {
          if (collectionNameProblem(collection.householdId, name ?? '', collection.id) === 'empty') return;
          explainRefusal(() => renameCollection(collection.id, name ?? ''));
        },
      },
    ],
    'plain-text',
    collection.name,
  );
}

/** Runs a create or rename, showing why in an alert when it refuses the name. */
function explainRefusal(write: () => void): void {
  try {
    write();
  } catch (err) {
    if (!(err instanceof CollectionNameError)) throw err;
    const message = collectionNameMessage(err);
    if (message) Alert.alert(message);
  }
}
