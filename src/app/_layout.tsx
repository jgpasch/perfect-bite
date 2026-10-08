import { Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { DatabaseProvider } from '@/db';
import { startAccount, useAccountState } from '@/features/auth/account';
import { useNavigationTheme, useStackScreenOptions } from '@/hooks/use-navigation-theme';
import { useTheme } from '@/hooks/use-theme';

export { ErrorBoundary } from 'expo-router';

SplashScreen.preventAutoHideAsync();
startAccount();

export default function RootLayout() {
  const navigationTheme = useNavigationTheme();
  const screenOptions = useStackScreenOptions();
  const { colors, scheme } = useTheme();
  const account = useAccountState();
  const ready = account.status === 'ready';

  useEffect(() => {
    if (account.status !== 'loading') SplashScreen.hideAsync();
  }, [account.status]);

  if (account.status === 'loading') return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <ThemeProvider value={navigationTheme}>
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
        <DatabaseProvider>
          <Stack screenOptions={screenOptions}>
            <Stack.Protected guard={ready}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            </Stack.Protected>
            <Stack.Protected guard={!ready}>
              <Stack.Screen name="sign-in" options={{ headerShown: false }} />
            </Stack.Protected>
          </Stack>
        </DatabaseProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
