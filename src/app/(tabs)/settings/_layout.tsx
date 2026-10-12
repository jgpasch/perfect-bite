import { Stack } from 'expo-router';

import { useStackScreenOptions } from '@/hooks/use-navigation-theme';
import { useTheme } from '@/hooks/use-theme';

export default function SettingsStackLayout() {
  const screenOptions = useStackScreenOptions();
  const { colors, aisles, typography } = useTheme();
  const { fontFamily, fontSize, fontWeight } = typography.largeTitle;
  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen
        name="index"
        options={{
          title: 'Settings',
          headerLargeTitleEnabled: true,
          // The native large title, set in the display face (board 10).
          headerLargeTitleStyle: { color: colors.ink, fontFamily, fontSize, fontWeight },
        }}
      />
      <Stack.Screen
        name="households/[id]"
        // Board 11: the header sits on the household's amber band.
        options={{ title: '', headerBackButtonDisplayMode: 'minimal', headerStyle: { backgroundColor: aisles.amber.soft } }}
      />
      <Stack.Screen name="sync" options={{ title: 'Sync status', headerBackButtonDisplayMode: 'minimal' }} />
      <Stack.Screen name="aisle-colors" options={{ title: 'Aisle colours', headerBackButtonDisplayMode: 'minimal' }} />
      <Stack.Screen name="siri" options={{ title: 'Siri', headerBackButtonDisplayMode: 'minimal' }} />
      <Stack.Screen name="developer" options={{ title: 'Developer', headerBackButtonDisplayMode: 'minimal' }} />
    </Stack>
  );
}
