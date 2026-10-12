import { useId, useState, type ReactNode } from 'react';
import { InputAccessoryView, Keyboard, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { addBarButton } from '@/components/appearance';
import { Icon } from '@/components/icon';
import { useKeyboardVisible } from '@/hooks/use-keyboard-visible';
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
  /**
   * The keyboard's top row while the input is focused (an `InputAccessoryView` on iOS), e.g. suggestion chips. It
   * takes the place of iOS's QuickType bar, so autocorrect and spell check are off on this input. Elsewhere it's
   * shown above the input like `accessory`.
   */
  keyboardRow?: ReactNode;
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
  keyboardRow,
  onFocusChange,
}: Props) {
  const { colors, spacing, sizes, rounded, shadows, scheme, typography, opacity } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const [focused, setFocused] = useState(false);
  const button = addBarButton(value);
  const empty = button.disabled;
  const inset = (sizes.bar - sizes.barButton) / 2;
  const keyboardRowId = useId();
  const onKeyboard = keyboardRow !== undefined && Platform.OS === 'ios';

  return (
    <View
      style={{
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.md,
        paddingBottom: keyboardVisible ? spacing.sm : Math.max(insets.bottom, spacing.sm),
        backgroundColor: colors.background,
      }}>
      {accessory}
      {onKeyboard ? (
        <InputAccessoryView nativeID={keyboardRowId} backgroundColor={colors.keyboard}>
          {keyboardRow}
        </InputAccessoryView>
      ) : (
        keyboardRow
      )}
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
          // Names are stored as typed and shown in sentence case (spec 4.2), so don't capitalize.
          autoCapitalize="none"
          inputAccessoryViewID={onKeyboard ? keyboardRowId : undefined}
          autoCorrect={keyboardRow === undefined}
          spellCheck={keyboardRow === undefined}
          autoComplete={keyboardRow === undefined ? undefined : 'off'}
          placeholder={placeholder}
          placeholderTextColor={colors.inkSecondary}
          selectionColor={colors.primary}
          accessibilityLabel={accessibilityLabel}
          style={[typography.body, styles.input, { color: colors.ink, minHeight: sizes.minTapTarget }]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={button.label}
          accessibilityState={{ disabled: empty }}
          disabled={empty}
          onPress={onSubmit}
          hitSlop={(sizes.minTapTarget - sizes.barButton) / 2}
          style={({ pressed }) => [
            styles.add,
            {
              width: sizes.barButton,
              height: sizes.barButton,
              borderRadius: rounded.full,
              backgroundColor: colors.primary,
              opacity: empty ? opacity.disabled : pressed ? opacity.pressed : 1,
            },
          ]}>
          <Icon name="plus" color="onPrimary" weight="bold" />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
  input: { flex: 1 },
  add: { alignItems: 'center', justifyContent: 'center' },
});
