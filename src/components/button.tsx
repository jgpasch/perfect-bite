import { Pressable, StyleSheet, type PressableProps } from 'react-native';

import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import type { ColorToken } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type Props = Omit<PressableProps, 'children' | 'style'> & {
  label: string;
};

/** The primary CTA: 54 pt, `primary`, full radius, full width, with an optional leading SF Symbol. */
export function PrimaryButton({ label, icon, disabled, ...rest }: Props & { icon?: IconName }) {
  const { colors, spacing, rounded, sizes, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        {
          minHeight: sizes.cta,
          paddingHorizontal: spacing.lg,
          gap: spacing.sm,
          borderRadius: rounded.full,
          backgroundColor: colors.primary,
          opacity: disabled ? opacity.disabled : pressed ? opacity.pressed : 1,
        },
      ]}
      {...rest}>
      {icon ? <Icon name={icon} color="onPrimary" weight="semibold" /> : null}
      <ThemedText variant="headline" color="onPrimary">
        {label}
      </ThemedText>
    </Pressable>
  );
}

/** The main action on a `primary` ground (the sign-in screen): a 54 pt `surface` pill with `ink` text. */
export function SurfaceButton({ label, icon, disabled, ...rest }: Props & { icon?: IconName }) {
  const { colors, spacing, rounded, sizes, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        {
          minHeight: sizes.cta,
          paddingHorizontal: spacing.lg,
          gap: spacing.sm,
          borderRadius: rounded.full,
          backgroundColor: colors.surface,
          opacity: disabled ? opacity.disabled : pressed ? opacity.pressed : 1,
        },
      ]}
      {...rest}>
      {icon ? <Icon name={icon} color="ink" weight="semibold" /> : null}
      <ThemedText variant="headline">{label}</ThemedText>
    </Pressable>
  );
}

/** A soft destructive button ("Delete item"): `dangerSoft` fill, `danger` text, 48 pt. */
export function SoftDangerButton({ label, disabled, ...rest }: Props) {
  const { colors, spacing, rounded, sizes, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        {
          minHeight: sizes.softButton,
          paddingHorizontal: spacing.lg,
          borderRadius: rounded.full,
          backgroundColor: colors.dangerSoft,
          opacity: disabled ? opacity.disabled : pressed ? opacity.pressed : 1,
        },
      ]}
      {...rest}>
      <ThemedText variant="headline" color="danger">
        {label}
      </ThemedText>
    </Pressable>
  );
}

/**
 * Secondary actions: secondary = muted surface; plain = text-only link. Use `PrimaryButton` for the main action.
 * `color` overrides the text colour: `danger` for Sign out, `onPrimary` for a link on a `primary` ground.
 */
export function Button({
  label,
  variant = 'secondary',
  color,
  disabled,
  ...rest
}: Props & { variant?: 'secondary' | 'plain'; color?: ColorToken }) {
  const { colors, spacing, rounded, sizes, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        {
          minHeight: sizes.minTapTarget,
          minWidth: sizes.minTapTarget,
          paddingHorizontal: variant === 'plain' ? spacing.xs : spacing.lg,
          borderRadius: rounded.md,
          backgroundColor: variant === 'secondary' ? colors.surfaceMuted : 'transparent',
          opacity: disabled ? opacity.disabled : pressed ? opacity.pressed : 1,
        },
      ]}
      {...rest}>
      <ThemedText variant="headline" color={color ?? (variant === 'secondary' ? 'ink' : 'primary')}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
});
