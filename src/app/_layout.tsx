import { Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { DatabaseProvider } from '@/db';
import { AppDataGate } from '@/features/app-data';
import { startAccount, useAccountState } from '@/features/auth/account';
import { wipeIfOtherUser } from '@/features/auth/sign-out';
import { NotificationHost } from '@/features/notifications/notification-host';
import { clearNotifications } from '@/features/notifications/notifications';
import { PageCaptureHost } from '@/features/recipes/page-capture-host';
import { loadFontSet } from '@/features/settings/font-set';
import { startupLanguage } from '@/features/settings/language';
import { useNavigationTheme, useStackScreenOptions } from '@/hooks/use-navigation-theme';
import { useTheme } from '@/hooks/use-theme';
import { initI18n, useT } from '@/i18n';

export { ErrorBoundary } from 'expo-router';

// A deep link (to a recipe, an invite) still gets the tabs underneath to go back to.
export const unstable_settings = { initialRouteName: '(tabs)' };

// The app's strings, in the language picked in Settings or else the phone's (spec 4.15), before anything renders.
initI18n(startupLanguage());
// The font set picked in Settings > Design trials, before anything renders.
loadFontSet();
SplashScreen.preventAutoHideAsync();
startAccount({ beforeReady: wipeIfOtherUser });

export default function RootLayout() {
  const t = useT();
  const navigationTheme = useNavigationTheme();
  const screenOptions = useStackScreenOptions();
  const { colors, scheme } = useTheme();
  const account = useAccountState();
  const ready = account.status === 'ready';

  useEffect(() => {
    if (account.status !== 'loading') SplashScreen.hideAsync();
  }, [account.status]);

  // In-app notifications are the signed-in user's (spec 4.11): none survive signing out.
  useEffect(() => {
    if (!ready) clearNotifications();
  }, [ready]);

  if (account.status === 'loading') return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <ThemeProvider value={navigationTheme}>
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
        <DatabaseProvider>
          <AppDataGate>
            <Stack screenOptions={screenOptions}>
              <Stack.Protected guard={ready}>
                <Stack.Screen name="(tabs)" options={{ headerShown: false, title: t('tabs.backTitle') }} />
                {/* A link to a list makes it current and shows the List tab (spec 4.1). */}
                <Stack.Screen name="list/[id]/index" options={{ headerShown: false, animation: 'none' }} />
                {/* Boards G, H: opened from the list's name. */}
                <Stack.Screen
                  name="lists-sheet"
                  options={{ title: '', presentation: 'formSheet', sheetAllowedDetents: [0.75, 1], sheetGrabberVisible: true }}
                />
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
                {/* From the list's ⋯ menu: Cancel, "Edit list", Done. */}
                <Stack.Screen
                  name="list/[id]/edit"
                  options={{ title: t('tabs.editList'), presentation: 'formSheet', sheetAllowedDetents: [0.75, 1], sheetGrabberVisible: true }}
                />
                <Stack.Screen
                  name="list/[id]/add-to-recipe"
                  options={{ title: '', presentation: 'formSheet', sheetAllowedDetents: [0.6, 1], sheetGrabberVisible: true }}
                />
                {/* Board 12: "Aisle order" is the large title in the screen, under the Done button. */}
                <Stack.Screen name="category-order" options={{ title: '', presentation: 'modal' }} />
                {/* Settings > Design trials > Fonts: the font trial's picker. */}
                <Stack.Screen
                  name="font-sets"
                  options={{ title: '', presentation: 'formSheet', sheetAllowedDetents: [0.75, 1], sheetGrabberVisible: true }}
                />
                {/* An invite link (spec 4.7): signed out, the guard sends it to sign-in instead. */}
                <Stack.Screen name="invite/[token]" options={{ title: '', presentation: 'modal' }} />
                {/* Designs S2, S3: "Invite someone" from the household screen. */}
                <Stack.Screen
                  name="household-invite"
                  options={{ title: '', presentation: 'formSheet', sheetAllowedDetents: [1], sheetGrabberVisible: true }}
                />
                <Stack.Screen name="recipe/[id]/index" options={{ title: '', headerBackTitle: t('recipes.tab.title') }} />
                <Stack.Screen
                  name="recipe/[id]/add-to-list"
                  options={{ title: '', presentation: 'formSheet', sheetAllowedDetents: [1], sheetGrabberVisible: true }}
                />
                {/* Spec 4.14: the recipe's tags and total time. */}
                <Stack.Screen
                  name="recipe/[id]/tags"
                  options={{ title: t('recipes.tags.title'), presentation: 'formSheet', sheetAllowedDetents: [1], sheetGrabberVisible: true }}
                />
                {/* Board 16: the recipe's method, one step per line; "Steps" is the large title in the sheet. */}
                <Stack.Screen
                  name="recipe/[id]/steps"
                  options={{ title: '', presentation: 'formSheet', sheetAllowedDetents: [1], sheetGrabberVisible: true }}
                />
                {/* Spec 4.5: Choose a photo, from the recipe screen's Add photo tile or Change photo…. */}
                <Stack.Screen
                  name="recipe/[id]/photo"
                  options={{ title: '', presentation: 'formSheet', sheetAllowedDetents: [0.75, 1], sheetGrabberVisible: true }}
                />
                {/* Board 19: cooking mode, full screen with its own top bar (✕ is Done). */}
                <Stack.Screen name="recipe/[id]/cook" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
                {/* Spec 4.5: the Recipes tab's +, name a recipe or import a link; as tall as its content. */}
                <Stack.Screen
                  name="add-recipe"
                  options={{ title: '', presentation: 'formSheet', sheetAllowedDetents: 'fitToContents', sheetGrabberVisible: true }}
                />
                {/* Spec 4.10: a small sheet; from the Recipes tab it also picks the list. */}
                <Stack.Screen
                  name="import-recipe"
                  options={{ title: '', presentation: 'formSheet', sheetAllowedDetents: [0.5, 1], sheetGrabberVisible: true }}
                />
                {/* Spec 4.16, board 2 F: filling a slot of the week; the day and meal are the title in the sheet. */}
                <Stack.Screen
                  name="plan-slot"
                  options={{ title: '', presentation: 'formSheet', sheetAllowedDetents: [0.75, 1], sheetGrabberVisible: true }}
                />
                {/* Spec 4.16: planning a recipe; its name is on the sheet's green header. Swiping it away writes nothing. */}
                <Stack.Screen
                  name="plan-recipe"
                  options={{ title: '', presentation: 'formSheet', sheetAllowedDetents: [1], sheetGrabberVisible: true }}
                />
                {/* Spec 4.16, board 3 G: Shop this week, from the week toolbar's cart. */}
                <Stack.Screen
                  name="plan-shop"
                  options={{ title: '', presentation: 'formSheet', sheetAllowedDetents: [0.75, 1], sheetGrabberVisible: true }}
                />
              </Stack.Protected>
              <Stack.Protected guard={!ready}>
                <Stack.Screen name="sign-in" options={{ headerShown: false }} />
              </Stack.Protected>
            </Stack>
          </AppDataGate>
        </DatabaseProvider>
        {ready && <PageCaptureHost />}
        {ready && <NotificationHost />}
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
