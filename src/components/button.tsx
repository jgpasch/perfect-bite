import { Pressable, StyleSheet, type PressableProps } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

type Props = Omit<PressableProps, 'children' | 'style'> & {
  label: string;
  /** primary = accent (the only action colour); secondary = muted surface; plain = text-only link. */
  variant?: 'primary' | 'secondary' | 'plain';
  /** large = 64pt tall with 28pt corners. */
  size?: 'regular' | 'large';
};

export function Button({ label, variant = 'primary', size = 'regular', disabled, ...rest }: Props) {
  const { colors, spacing, rounded, sizes, opacity } = useTheme();
  const bg =
    variant === 'primary' ? colors.primary : variant === 'secondary' ? colors.surfaceMuted : 'transparent';
  const fg = variant === 'primary' ? 'onPrimary' : variant === 'secondary' ? 'ink' : 'primary';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        {
          minHeight: size === 'large' ? sizes.largeButton : sizes.minTapTarget,
          minWidth: sizes.minTapTarget,
          paddingHorizontal: variant === 'plain' ? spacing.xs : spacing.lg,
          borderRadius: size === 'large' ? rounded.xl : rounded.md,
          backgroundColor: bg,
          opacity: disabled ? opacity.disabled : pressed ? opacity.pressed : 1,
        },
      ]}
      {...rest}>
      <ThemedText variant="headline" color={fg}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
});
