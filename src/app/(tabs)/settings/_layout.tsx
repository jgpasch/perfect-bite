import { Stack } from 'expo-router';

import { useStackScreenOptions } from '@/hooks/use-navigation-theme';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

export default function SettingsStackLayout() {
  const screenOptions = useStackScreenOptions();
  const { colors, aisles, typography } = useTheme();
  const t = useT();
  const { fontFamily, fontSize, fontWeight } = typography.largeTitle;
  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen
        name="index"
        options={{
          title: t('settings.title'),
          headerLargeTitleEnabled: true,
          // A header background colour hides the large title on iOS 26+; the screen's own background shows through.
          headerStyle: { backgroundColor: 'transparent' },
          // The native large title, set in the display face (board 10).
          headerLargeTitleStyle: { color: colors.ink, fontFamily, fontSize, fontWeight },
        }}
      />
      <Stack.Screen
        name="households/[id]"
        // Board 11: the header sits on the household's amber band.
        options={{ title: '', headerBackButtonDisplayMode: 'minimal', headerStyle: { backgroundColor: aisles.amber.soft } }}
      />
      <Stack.Screen name="always-have" options={{ title: t('settings.alwaysHave'), headerBackButtonDisplayMode: 'minimal' }} />
      <Stack.Screen name="sync"options={{ title: t('settings.syncStatus'), headerBackButtonDisplayMode: 'minimal' }} />
      <Stack.Screen name="aisle-colors" options={{ title: t('settings.aisleColours'), headerBackButtonDisplayMode: 'minimal' }} />
      <Stack.Screen name="siri" options={{ title: t('settings.siri'), headerBackButtonDisplayMode: 'minimal' }} />
      <Stack.Screen name="developer" options={{ title: t('settings.developer'), headerBackButtonDisplayMode: 'minimal' }} />
    </Stack>
  );
}
