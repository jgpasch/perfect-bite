import { useMemo, useState } from 'react';
import { ActionSheetIOS, Pressable, ScrollView, StyleSheet } from 'react-native';

import { AddBar } from '@/components/add-bar';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

import { applySuggestion, getSuggestions, type Suggestion } from './suggestions';
import { hideFromSuggestions } from './usage';

type Props = {
  householdId: string;
  /** Adds the text; return keeps the keyboard up for the next one (spec 4.2). */
  onAdd: (text: string) => void;
  placeholder: string;
  accessibilityLabel: string;
};

/**
 * The persistent add bar at the bottom of a list or recipe, with autocomplete chips above it.
 * Put it last in a KeyboardAvoidingView.
 */
export function ItemAddBar({ householdId, onAdd, placeholder, accessibilityLabel }: Props) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const [text, setText] = useState('');
  // Bumped after "Remove from suggestions" so the chips are read again.
  const [hiddenCount, setHiddenCount] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hiddenCount only forces a re-read
  const suggestions = useMemo(() => getSuggestions(householdId, text), [householdId, text, hiddenCount]);

  // Spec 4.2: only household history can be removed; catalog-only chips have no menu.
  const suggestionMenu = (s: Suggestion) => {
    if (s.source !== 'history') return;
    ActionSheetIOS.showActionSheetWithOptions(
      { title: s.displayName, options: ['Remove from suggestions', 'Cancel'], destructiveButtonIndex: 0, cancelButtonIndex: 1 },
      (index) => {
        if (index !== 0) return;
        hideFromSuggestions(householdId, s.key);
        setHiddenCount((n) => n + 1);
      },
    );
  };

  const add = (value: string) => {
    if (!value.trim()) return;
    onAdd(value);
    setText('');
  };

  return (
    <AddBar
      value={text}
      onChangeText={setText}
      onSubmit={() => add(text)}
      placeholder={placeholder}
      accessibilityLabel={accessibilityLabel}
      accessory={
        suggestions.length > 0 ? (
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.sm }}>
            {suggestions.map((s) => (
              <Pressable
                key={s.key}
                accessibilityRole="button"
                accessibilityLabel={`Add ${s.displayName}`}
                accessibilityHint={s.source === 'history' ? 'Long press to remove from suggestions' : undefined}
                onPress={() => add(applySuggestion(text, s))}
                onLongPress={s.source === 'history' ? () => suggestionMenu(s) : undefined}
                style={({ pressed }) => [
                  styles.chip,
                  {
                    minHeight: sizes.minTapTarget,
                    paddingHorizontal: spacing.md,
                    borderRadius: rounded.full,
                    backgroundColor: colors.surface,
                    opacity: pressed ? opacity.pressed : 1,
                  },
                ]}>
                <ThemedText variant="callout">{s.displayName}</ThemedText>
              </Pressable>
            ))}
          </ScrollView>
        ) : null
      }
    />
  );
}

const styles = StyleSheet.create({
  chip: { justifyContent: 'center', borderCurve: 'continuous' },
});
