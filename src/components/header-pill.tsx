import { Pressable, StyleSheet } from 'react-native';

import { listHeaderColors } from '@/components/appearance';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

/**
 * A pill on the green header, styled like the list header's view button: a 32 pt fully rounded pill in
 * the 14% white wash with its label in `amount` `onHeader`, padded to a 44 pt hit area. `selected` (the
 * Recipes tab's Filters pill while some are on) fills it `onHeader` with `header` text.
 */
export function HeaderPill({
  label,
  accessibilityLabel,
  accessibilityHint,
  selected = false,
  onPress,
}: {
  label: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  selected?: boolean;
  onPress: () => void;
}) {
  const { colors, sizes, spacing, rounded, opacity } = useTheme();
  const look = listHeaderColors(colors).viewButton;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected }}
      hitSlop={(sizes.minTapTarget - sizes.viewButton) / 2}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        {
          minHeight: sizes.viewButton,
          borderRadius: rounded.full,
          paddingHorizontal: spacing.md,
          backgroundColor: selected ? colors.onHeader : look.fill,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <ThemedText variant="amount" style={[styles.label, { color: selected ? colors.header : look.text }]}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexShrink: 1, borderCurve: 'continuous' },
  label: { flexShrink: 1, textAlign: 'center' },
});
