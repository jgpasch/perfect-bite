import { Pressable, StyleSheet, type PressableProps } from 'react-native';

import { pillLook } from '@/components/appearance';
import { Icon, type IconName } from '@/components/icon';
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
  /** A solid `primary` outline with `primary` text: an action among choices (the aisle picker's "Show all"). */
  outline?: boolean;
  /** A `primarySoft` fill with bold `onPrimarySoft` text: an action in an empty card (the Method card's "Add steps"). */
  soft?: boolean;
  /** A leading SF Symbol in the label's colour (the recipe band's "Suggest tags"). */
  icon?: IconName;
  /** A trailing SF Symbol in the label's colour (the "Show all" chevron). */
  trailingIcon?: IconName;
};

/** A 40 pt choice pill: `surface` when off, an ink (or aisle) fill with light text when on. */
export function Pill({
  label,
  selected = false,
  hue,
  dashed = false,
  primary = false,
  outline = false,
  soft = false,
  icon,
  trailingIcon,
  disabled,
  accessibilityState,
  ...rest
}: Props) {
  const { colors, aisles, spacing, sizes, rounded, opacity } = useTheme();
  const look = pillLook({ selected, hue, dashed, primary, outline, soft }, colors, aisles);
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
          gap: spacing.xs,
          borderRadius: rounded.full,
          backgroundColor: look.fill,
          opacity: disabled ? opacity.disabled : pressed ? opacity.pressed : 1,
        },
        look.border
          ? {
              borderWidth: dashed ? sizes.checkBorder : sizes.chipBorder,
              borderStyle: dashed ? 'dashed' : 'solid',
              borderColor: look.border,
            }
          : null,
      ]}
      {...rest}>
      {icon ? <Icon name={icon} tint={look.text} size={sizes.iconSmall} weight="semibold" /> : null}
      <ThemedText variant="amount" style={[{ color: look.text }, selected || soft ? styles.selected : undefined]}>
        {label}
      </ThemedText>
      {trailingIcon ? <Icon name={trailingIcon} tint={look.text} size={sizes.iconSmall} weight="semibold" /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  selected: { fontWeight: '700' },
});
