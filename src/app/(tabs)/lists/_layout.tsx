import { Stack } from 'expo-router';

import { useStackScreenOptions } from '@/hooks/use-navigation-theme';

export default function ListsStackLayout() {
  const screenOptions = useStackScreenOptions();
  return (
    <Stack screenOptions={screenOptions}>
      {/* The current list (spec 4.1): its name is in the green band below the header, not the header. */}
      <Stack.Screen name="index" options={{ title: '' }} />
    </Stack>
  );
}
