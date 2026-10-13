import { Alert } from 'react-native';

/**
 * Asks for a household's new name with the system text prompt, prefilled with `current`. Save
 * calls `onSave` with the trimmed name; a blank name is ignored.
 * TODO(M9): Alert.prompt is iOS-only; use a sheet if Android ships.
 */
export function promptHouseholdName(current: string, onSave: (name: string) => void): void {
  Alert.prompt(
    'Rename household',
    undefined,
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Save',
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
