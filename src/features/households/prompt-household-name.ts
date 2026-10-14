import { Alert } from 'react-native';

import { i18n } from '@/i18n';

/**
 * Asks for a household's new name with the system text prompt, prefilled with `current`. Save
 * calls `onSave` with the trimmed name; a blank name is ignored.
 * TODO(M9): Alert.prompt is iOS-only; use a sheet if Android ships.
 */
export function promptHouseholdName(current: string, onSave: (name: string) => void): void {
  Alert.prompt(
    i18n.t('households.screen.rename'),
    undefined,
    [
      { text: i18n.t('common.cancel'), style: 'cancel' },
      {
        text: i18n.t('common.save'),
        isPreferred: true,
        onPress: (name?: string) => {
          const trimmed = name?.trim();
          if (trimmed) onSave(trimmed);
        },
      },
    ],
    'plain-text',
    current,
  );
}
