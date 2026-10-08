import { Stack } from 'expo-router';

import { useStackScreenOptions } from '@/hooks/use-navigation-theme';

export default function SettingsStackLayout() {
  const screenOptions = useStackScreenOptions();
  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name="index" options={{ title: 'Settings', headerLargeTitleEnabled: true }} />
      <Stack.Screen name="siri" options={{ title: 'Siri spike', headerBackButtonDisplayMode: 'minimal' }} />
    </Stack>
  );
}
