import { Stack } from 'expo-router';

import { listHeaderColors } from '@/components/appearance';
import { useStackScreenOptions } from '@/hooks/use-navigation-theme';
import { useTheme } from '@/hooks/use-theme';

export default function PlanStackLayout() {
  const screenOptions = useStackScreenOptions();
  const header = listHeaderColors(useTheme().colors);
  return (
    <Stack screenOptions={screenOptions}>
      {/* Spec 4.16: the Recipes tab's green header; "This week" is in the green band below it, not the header. */}
      <Stack.Screen
        name="index"
        options={{ title: '', headerStyle: { backgroundColor: header.ground }, headerTintColor: header.title }}
      />
    </Stack>
  );
}
