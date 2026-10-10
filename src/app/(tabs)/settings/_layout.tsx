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
      <Stack.Screen name="siri" options={{ title: 'Siri spike', headerBackButtonDisplayMode: 'minimal' }} />
    </Stack>
  );
}
