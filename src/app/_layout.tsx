import { Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { DatabaseProvider } from '@/db';
import { AppDataGate } from '@/features/app-data';
import { startAccount, useAccountState } from '@/features/auth/account';
import { useNavigationTheme, useStackScreenOptions } from '@/hooks/use-navigation-theme';
import { useTheme } from '@/hooks/use-theme';

export { ErrorBoundary } from 'expo-router';

// A deep link straight to a list (or Siri, later) still gets the tabs underneath to go back to.
export const unstable_settings = { initialRouteName: '(tabs)' };

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
          <AppDataGate>
            <Stack screenOptions={screenOptions}>
              <Stack.Protected guard={ready}>
                <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Lists' }} />
                <Stack.Screen name="list/[id]/index" options={{ title: '' }} />
                <Stack.Screen
                  name="list/[id]/item/[itemId]"
                  options={{
                    // Board 04: Cancel, grabber, Save; the item's name is the sheet's title below.
                    title: '',
                    presentation: 'formSheet',
                    sheetAllowedDetents: [0.6, 1],
                    sheetGrabberVisible: true,
                  }}
                />
                <Stack.Screen
                  name="list/[id]/add-to-recipe"
                  options={{ title: '', presentation: 'formSheet', sheetAllowedDetents: [0.6, 1], sheetGrabberVisible: true }}
                />
                {/* Board 12: "Aisle order" is the large title in the screen, under the Done button. */}
                <Stack.Screen name="category-order" options={{ title: '', presentation: 'modal' }} />
                {/* An invite link (spec 4.7): signed out, the guard sends it to sign-in instead. */}
                <Stack.Screen name="invite/[token]" options={{ title: '', presentation: 'modal' }} />
                <Stack.Screen name="recipe/[id]/index" options={{ title: '', headerBackTitle: 'Recipes' }} />
                <Stack.Screen
                  name="recipe/[id]/add-to-list"
                  options={{ title: '', presentation: 'formSheet', sheetAllowedDetents: [1], sheetGrabberVisible: true }}
                />
              </Stack.Protected>
              <Stack.Protected guard={!ready}>
                <Stack.Screen name="sign-in" options={{ headerShown: false }} />
              </Stack.Protected>
            </Stack>
          </AppDataGate>
        </DatabaseProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
