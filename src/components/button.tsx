import { ActivityIndicator, Pressable, StyleSheet, type PressableProps } from 'react-native';

import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import type { ColorToken } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type Props = Omit<PressableProps, 'children' | 'style'> & {
  label: string;
};

/**
 * The primary CTA: 54 pt, `primary`, full radius, full width, with an optional leading SF Symbol.
 * `loading` swaps the glyph for a spinner (pass `disabled` too while it runs).
 */
export function PrimaryButton({ label, icon, loading = false, disabled, ...rest }: Props & { icon?: IconName; loading?: boolean }) {
  const { colors, spacing, rounded, sizes, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: loading }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        {
          minHeight: sizes.cta,
          paddingHorizontal: spacing.lg,
          gap: spacing.sm,
          borderRadius: rounded.full,
          backgroundColor: colors.primary,
          // A busy button stays solid; the others dim while it runs.
          opacity: disabled && !loading ? opacity.disabled : pressed ? opacity.pressed : 1,
        },
      ]}
      {...rest}>
      {loading ? (
        <ActivityIndicator color={colors.onPrimary} />
      ) : icon ? (
        <Icon name={icon} color="onPrimary" weight="semibold" />
      ) : null}
      <ThemedText variant="headline" color="onPrimary" style={styles.label}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

/**
 * The main action on the `header` green (the sign-in screen): a 54 pt `onHeader` pill with `header` text, in both schemes.
 * On `surface` it's the action beside a `PrimaryButton` on the screen's ground (Cook): a `surface` pill with `ink` text.
 * `iconTint` colours the glyph alone, e.g. the recipe hue's `strong`.
 * `layout="stacked"` is the compact form beside a `PrimaryButton` in a dock (the recipe's Cook and Plan): 64 pt wide,
 * at least 44 pt tall, a `surfaceMuted` pill with the glyph over a `caption` label in `ink`; it grows taller when the
 * label wraps. `on` doesn't apply to it.
 */
export function SurfaceButton({
  label,
  icon,
  iconTint,
  on = 'header',
  layout = 'inline',
  disabled,
  ...rest
}: Props & { icon?: IconName; iconTint?: string; on?: 'header' | 'surface'; layout?: 'inline' | 'stacked' }) {
  const { colors, spacing, rounded, sizes, opacity } = useTheme();
  const text: ColorToken = on === 'header' && layout === 'inline' ? 'header' : 'ink';
  if (layout === 'stacked') {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: !!disabled }}
        disabled={disabled}
        style={({ pressed }) => [
          styles.stacked,
          {
            width: sizes.stackedButton,
            minHeight: sizes.minTapTarget,
            paddingVertical: spacing.xs,
            paddingHorizontal: spacing.xxs,
            gap: spacing.xxs,
            borderRadius: rounded.full,
            backgroundColor: colors.surfaceMuted,
            opacity: disabled ? opacity.disabled : pressed ? opacity.pressed : 1,
          },
        ]}
        {...rest}>
        {icon ? <Icon name={icon} color={text} tint={iconTint} weight="semibold" /> : null}
        <ThemedText variant="caption" color={text} style={styles.label}>
          {label}
        </ThemedText>
      </Pressable>
    );
  }
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
          backgroundColor: on === 'header' ? colors.onHeader : colors.surface,
          opacity: disabled ? opacity.disabled : pressed ? opacity.pressed : 1,
        },
      ]}
      {...rest}>
      {icon ? <Icon name={icon} color={text} tint={iconTint} weight="semibold" /> : null}
      <ThemedText variant="headline" color={text} style={styles.label}>
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
      <ThemedText variant="headline" color="danger" style={styles.label}>
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
      <ThemedText variant="headline" color={textColor} style={styles.label}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  stacked: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  // A label longer than the button's room (Spanish, large Dynamic Type) wraps inside it rather than overflowing.
  label: { flexShrink: 1, textAlign: 'center' },
});
