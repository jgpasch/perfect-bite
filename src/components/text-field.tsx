import { StyleSheet, TextInput, type TextInputProps } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

type Props = TextInputProps;

/** Text input: surface, hairline border, 12pt corners, 44pt min height. */
export function TextField({ style, ...rest }: Props) {
  const { colors, typography, spacing, rounded, sizes } = useTheme();
  return (
    <TextInput
      placeholderTextColor={colors.inkSecondary}
      selectionColor={colors.primary}
      style={[
        typography.body,
        styles.input,
        {
          color: colors.ink,
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderRadius: rounded.md,
          padding: spacing.md,
          minHeight: sizes.minTapTarget,
        },
        style,
      ]}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: StyleSheet.hairlineWidth, borderCurve: 'continuous' },
});
