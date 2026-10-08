import { ScrollView, View, type ScrollViewProps, type ViewProps } from 'react-native';

import type { ColorToken } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ThemedViewProps = ViewProps & {
  /** Background color token. Defaults to `background` (paper). */
  background?: ColorToken;
};

export function ThemedView({ style, background = 'background', ...rest }: ThemedViewProps) {
  const { colors } = useTheme();
  return <View style={[{ backgroundColor: colors[background] }, style]} {...rest} />;
}

/** Full-screen container on the paper background. Use `scroll` for content that can overflow at large Dynamic Type sizes. */
export function Screen({
  scroll,
  style,
  contentContainerStyle,
  keyboardShouldPersistTaps,
  automaticallyAdjustKeyboardInsets,
  children,
  ...rest
}: ViewProps &
  Pick<ScrollViewProps, 'keyboardShouldPersistTaps' | 'automaticallyAdjustKeyboardInsets'> & {
    scroll?: boolean;
    contentContainerStyle?: ScrollViewProps['contentContainerStyle'];
  }) {
  const { colors } = useTheme();
  if (scroll) {
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={[{ flex: 1, backgroundColor: colors.background }, style]}
        contentContainerStyle={contentContainerStyle}
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
        automaticallyAdjustKeyboardInsets={automaticallyAdjustKeyboardInsets}
        {...rest}>
        {children}
      </ScrollView>
    );
  }
  return (
    <View style={[{ flex: 1, backgroundColor: colors.background }, style]} {...rest}>
      {children}
    </View>
  );
}
