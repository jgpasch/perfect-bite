import { Pressable, StyleSheet, type PressableProps } from 'react-native';

import { pillColors } from '@/components/appearance';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

type Props = Omit<PressableProps, 'children' | 'style'> & {
  label: string;
  selected?: boolean;
};

/** A 40 pt choice pill: `surface` when off, an ink fill with white text when on. */
export function Pill({ label, selected = false, disabled, accessibilityState, ...rest }: Props) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const look = pillColors(selected);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled: !!disabled, ...accessibilityState }}
      disabled={disabled}
      hitSlop={(sizes.minTapTarget - sizes.pill) / 2}
      style={({ pressed }) => [
        styles.pill,
        {
          minHeight: sizes.pill,
          paddingHorizontal: spacing.md + spacing.xxs,
          borderRadius: rounded.full,
          backgroundColor: colors[look.fill],
          opacity: disabled ? opacity.disabled : pressed ? opacity.pressed : 1,
        },
      ]}
      {...rest}>
      <ThemedText variant="amount" color={look.text} style={selected ? styles.selected : undefined}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  selected: { fontWeight: '700' },
});
