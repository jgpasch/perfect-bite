import { DarkTheme, DefaultTheme, type Stack, type Theme } from 'expo-router';
import type { ComponentProps } from 'react';

import { useTheme } from '@/hooks/use-theme';

/** React Navigation theme built from the theme tokens. */
export function useNavigationTheme(): Theme {
  const { scheme, colors } = useTheme();
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: colors.primary,
      background: colors.background,
      card: colors.background,
      text: colors.ink,
      border: colors.border,
      notification: colors.danger,
    },
  };
}

type StackScreenOptions = NonNullable<ComponentProps<typeof Stack>['screenOptions']>;

/** Shared native-stack header styling for every Stack in the app. */
export function useStackScreenOptions(): Extract<StackScreenOptions, object> {
  const { colors } = useTheme();
  return {
    headerStyle: { backgroundColor: colors.background },
    headerTintColor: colors.primary,
    headerTitleStyle: { color: colors.ink },
    headerLargeTitleStyle: { color: colors.ink },
    headerShadowVisible: false,
    headerLargeTitleShadowVisible: false,
    contentStyle: { backgroundColor: colors.background },
  };
}
