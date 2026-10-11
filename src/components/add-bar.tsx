import { useEffect, useState, type ReactNode } from 'react';
import { Keyboard, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  value: string;
  onChangeText: (text: string) => void;
  /**
   * Called by return and by the + button. Return keeps the keyboard up for the next one (spec 4.2);
   * on an empty field it hides the keyboard instead.
   */
  onSubmit: () => void;
  placeholder: string;
  accessibilityLabel: string;
  /** Shown above the input, e.g. autocomplete suggestions. */
  accessory?: ReactNode;
  /** Called when the input gains or loses focus. */
  onFocusChange?: (focused: boolean) => void;
};

/**
 * The bottom add bar: a white pill input with a round + button, pinned above the keyboard.
 * Put it last in a KeyboardAvoidingView.
 */
export function AddBar({
  value,
  onChangeText,
  onSubmit,
  placeholder,
  accessibilityLabel,
  accessory,
  onFocusChange,
}: Props) {
  const { colors, spacing, sizes, rounded, shadows, scheme, typography, opacity } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const [focused, setFocused] = useState(false);
  const empty = !value.trim();
  // While typing into an empty field the disabled + would be dead weight, so it hides the keyboard instead.
  const dismiss = focused && empty;
  const inset = (sizes.bar - sizes.barButton) / 2;

  return (
    <View
      style={{
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.md,
        paddingBottom: keyboardVisible ? spacing.sm : Math.max(insets.bottom, spacing.sm),
        backgroundColor: colors.background,
      }}>
      {accessory}
      <View
        style={[
          styles.field,
          scheme === 'light' ? { ...shadows.soft, shadowColor: colors.ink } : null,
          {
            minHeight: sizes.bar,
            borderRadius: rounded.full,
            backgroundColor: colors.surface,
            borderWidth: sizes.focusRing,
            borderColor: focused ? colors.primary : colors.surface,
            paddingLeft: spacing.lg + spacing.xxs - sizes.focusRing,
            paddingRight: inset - sizes.focusRing,
            gap: spacing.sm + spacing.xxs,
          },
        ]}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          onSubmitEditing={empty ? Keyboard.dismiss : onSubmit}
          onFocus={() => (setFocused(true), onFocusChange?.(true))}
          onBlur={() => (setFocused(false), onFocusChange?.(false))}
          submitBehavior="submit"
          returnKeyType="done"
          placeholder={placeholder}
          placeholderTextColor={colors.inkSecondary}
          selectionColor={colors.primary}
          accessibilityLabel={accessibilityLabel}
          style={[typography.body, styles.input, { color: colors.ink, minHeight: sizes.minTapTarget }]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={dismiss ? 'Hide keyboard' : 'Add'}
          accessibilityState={{ disabled: empty && !dismiss }}
          disabled={empty && !dismiss}
          onPress={dismiss ? Keyboard.dismiss : onSubmit}
          hitSlop={(sizes.minTapTarget - sizes.barButton) / 2}
          style={({ pressed }) => [
            styles.add,
            {
              width: sizes.barButton,
              height: sizes.barButton,
              borderRadius: rounded.full,
              backgroundColor: dismiss ? colors.surfaceMuted : colors.primary,
              opacity: empty && !dismiss ? opacity.disabled : pressed ? opacity.pressed : 1,
            },
          ]}>
          {dismiss ? (
            <Icon name="keyboard.chevron.compact.down" color="ink" weight="semibold" />
          ) : (
            <Icon name="plus" color="onPrimary" weight="bold" />
          )}
        </Pressable>
      </View>
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
  field: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
  input: { flex: 1 },
  add: { alignItems: 'center', justifyContent: 'center' },
});
