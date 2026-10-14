import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** What shows between the buttons, e.g. "For 4"; also what VoiceOver reads as the value. */
  label: string;
  /** What VoiceOver calls the whole control, e.g. "Servings". */
  accessibilityLabel: string;
  /** The round buttons' size; defaults to `sizes.stepperButton` (34). */
  buttonSize?: number;
  /** Leaves the value out from between the buttons when it shows nearby (Add to list's servings card). */
  hideValue?: boolean;
};

/**
 * A − / + stepper: a `surfaceMuted` track (radius `full`, a 3 pt inset) holding round `surface` buttons
 * with the value in `amount` 700 between them. Each button's hit area is at least 44 pt, and a button
 * is disabled at its end of the range. VoiceOver reads it as one adjustable control: swipe up or down.
 */
export function Stepper({ value, min, max, onChange, label, accessibilityLabel, buttonSize, hideValue }: Props) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const size = buttonSize ?? sizes.stepperButton;
  const step = (direction: 1 | -1) => {
    const next = Math.min(max, Math.max(min, value + direction));
    if (next !== value) onChange(next);
  };

  const button = (direction: 1 | -1) => {
    const disabled = direction === 1 ? value >= max : value <= min;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={direction === 1 ? 'More' : 'Fewer'}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => step(direction)}
        hitSlop={Math.max(0, (sizes.minTapTarget - size) / 2)}
        style={({ pressed }) => [
          styles.button,
          {
            width: size,
            height: size,
            borderRadius: rounded.full,
            backgroundColor: colors.surface,
            opacity: disabled ? opacity.disabled : pressed ? opacity.pressed : 1,
          },
        ]}>
        <Icon name={direction === 1 ? 'plus' : 'minus'} size={sizes.iconSmall} weight="bold" />
      </Pressable>
    );
  };

  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ text: label }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === 'increment') step(1);
        else if (nativeEvent.actionName === 'decrement') step(-1);
      }}
      style={[
        styles.track,
        { padding: sizes.stepperInset, gap: spacing.xxs, borderRadius: rounded.full, backgroundColor: colors.surfaceMuted },
      ]}>
      {button(-1)}
      {hideValue ? null : (
        <ThemedText variant="amount" style={[styles.value, { paddingHorizontal: spacing.sm }]}>
          {label}
        </ThemedText>
      )}
      {button(1)}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
  button: { alignItems: 'center', justifyContent: 'center' },
  value: { fontWeight: '700', textAlign: 'center' },
});
