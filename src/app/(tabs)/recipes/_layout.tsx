import { Stack } from 'expo-router';

import { listHeaderColors } from '@/components/appearance';
import { useStackScreenOptions } from '@/hooks/use-navigation-theme';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

export default function RecipesStackLayout() {
  const t = useT();
  const screenOptions = useStackScreenOptions();
  const header = listHeaderColors(useTheme().colors);
  return (
    <Stack screenOptions={screenOptions}>
      {/* Spec 4.5: the List tab's green header; "Recipes" is in the green band below it, not the header. */}
      <Stack.Screen
        name="index"
        options={{ title: '', headerStyle: { backgroundColor: header.ground }, headerTintColor: header.title }}
      />
      {/* Spec 4.14, mockup C: the tab's filters. */}
      <Stack.Screen
        name="filter"
        options={{ title: t('recipes.filters.title'), presentation: 'formSheet', sheetAllowedDetents: [1], sheetGrabberVisible: true }}
      />
    </Stack>
  );
}
