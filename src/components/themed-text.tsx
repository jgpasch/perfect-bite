import { Text, type TextProps } from 'react-native';

import type { ColorToken, TypographyVariant } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ThemedTextProps = TextProps & {
  /** Typography style from the theme tokens. */
  variant?: TypographyVariant;
  /** Color token. Defaults to `ink`. */
  color?: ColorToken;
};

/** Text that follows the theme tokens. Font scaling (Dynamic Type) stays enabled. */
export function ThemedText({ style, variant = 'body', color = 'ink', ...rest }: ThemedTextProps) {
  const { colors, typography } = useTheme();
  return <Text style={[typography[variant], { color: colors[color] }, style]} {...rest} />;
}
