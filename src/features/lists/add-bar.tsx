import { useEffect, useMemo, useState } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

import { applySuggestion, getSuggestions } from './suggestions';

type Props = {
  householdId: string;
  /** Adds the text; return keeps the keyboard up for the next one (spec 4.2). */
  onAdd: (text: string) => void;
  placeholder: string;
  accessibilityLabel: string;
};

/**
 * The persistent add field at the bottom of a list or recipe, with autocomplete chips above it.
 * Put it last in a KeyboardAvoidingView.
 */
export function AddBar({ householdId, onAdd, placeholder, accessibilityLabel }: Props) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const [text, setText] = useState('');
  const suggestions = useMemo(() => getSuggestions(householdId, text), [householdId, text]);

  const add = (value: string) => {
    if (!value.trim()) return;
    onAdd(value);
    setText('');
  };

  return (
    <View
      style={{
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.sm,
        paddingBottom: keyboardVisible ? spacing.sm : Math.max(insets.bottom, spacing.sm),
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: colors.border,
        backgroundColor: colors.background,
      }}>
      {suggestions.length > 0 ? (
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
              onPress={() => add(applySuggestion(text, s))}
              style={({ pressed }) => [
                styles.chip,
                {
                  minHeight: sizes.minTapTarget,
                  paddingHorizontal: spacing.md,
                  borderRadius: rounded.full,
                  backgroundColor: colors.surfaceMuted,
                  opacity: pressed ? opacity.pressed : 1,
                },
              ]}>
              <ThemedText variant="callout">{s.displayName}</ThemedText>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <TextField
        value={text}
        onChangeText={setText}
        onSubmitEditing={() => add(text)}
        submitBehavior="submit"
        returnKeyType="done"
        placeholder={placeholder}
        accessibilityLabel={accessibilityLabel}
      />
    </View>
  );
}

function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => setVisible(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

const styles = StyleSheet.create({
  chip: { justifyContent: 'center', borderCurve: 'continuous' },
});
