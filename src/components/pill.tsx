import { Pressable, StyleSheet, type PressableProps } from 'react-native';

import { pillLook } from '@/components/appearance';
import { ThemedText } from '@/components/themed-text';
import type { AisleHue } from '@/domain/aisle-color';
import { useTheme } from '@/hooks/use-theme';

type Props = Omit<PressableProps, 'children' | 'style'> & {
  label: string;
  selected?: boolean;
  /** Fill the selected pill in this aisle's colour instead of ink (the item sheet's aisle picker). */
  hue?: AisleHue;
  /** A dashed "+ New" outline. */
  dashed?: boolean;
  /** Fill the selected pill in `primary` instead of ink (the Recipes tab's active Filters pill). */
  primary?: boolean;
};

/** A 40 pt choice pill: `surface` when off, an ink (or aisle) fill with light text when on. */
export function Pill({
  label,
  selected = false,
  hue,
  dashed = false,
  primary = false,
  disabled,
  accessibilityState,
  ...rest
}: Props) {
  const { colors, aisles, spacing, sizes, rounded, opacity } = useTheme();
  const look = pillLook({ selected, hue, dashed, primary }, colors, aisles);
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
          backgroundColor: look.fill,
          opacity: disabled ? opacity.disabled : pressed ? opacity.pressed : 1,
        },
        look.border ? { borderWidth: sizes.checkBorder, borderStyle: 'dashed', borderColor: look.border } : null,
      ]}
      {...rest}>
      <ThemedText variant="amount" style={[{ color: look.text }, selected ? styles.selected : undefined]}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  selected: { fontWeight: '700' },
});
