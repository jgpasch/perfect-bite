import { ActivityIndicator, Pressable, StyleSheet, type PressableProps } from 'react-native';

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

/** The main action on the `header` green (the sign-in screen): a 54 pt `onHeader` pill with `header` text, in both schemes. */
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
          backgroundColor: colors.onHeader,
          opacity: disabled ? opacity.disabled : pressed ? opacity.pressed : 1,
        },
      ]}
      {...rest}>
      {icon ? <Icon name={icon} color="header" weight="semibold" /> : null}
      <ThemedText variant="headline" color="header">
        {label}
      </ThemedText>
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
 * An optional leading SF Symbol; `loading` swaps it for a spinner (pass `disabled` too while it runs).
 */
export function Button({
  label,
  variant = 'secondary',
  color,
  icon,
  loading = false,
  disabled,
  ...rest
}: Props & { variant?: 'secondary' | 'plain'; color?: ColorToken; icon?: IconName; loading?: boolean }) {
  const { colors, spacing, rounded, sizes, opacity } = useTheme();
  const textColor = color ?? (variant === 'secondary' ? 'ink' : 'primary');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: loading }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        {
          minHeight: sizes.minTapTarget,
          minWidth: sizes.minTapTarget,
          paddingHorizontal: variant === 'plain' ? spacing.xs : spacing.lg,
          gap: spacing.sm,
          borderRadius: rounded.md,
          backgroundColor: variant === 'secondary' ? colors.surfaceMuted : 'transparent',
          opacity: disabled ? opacity.disabled : pressed ? opacity.pressed : 1,
        },
      ]}
      {...rest}>
      {loading ? (
        <ActivityIndicator color={colors[textColor]} />
      ) : icon ? (
        <Icon name={icon} color={textColor} weight="semibold" />
      ) : null}
      <ThemedText variant="headline" color={textColor}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
});
