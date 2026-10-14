import { Stack } from 'expo-router';

import { useStackScreenOptions } from '@/hooks/use-navigation-theme';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

export default function RecipesStackLayout() {
  const t = useT();
  const screenOptions = useStackScreenOptions();
  const { colors, typography } = useTheme();
  const { fontFamily, fontSize, fontWeight } = typography.largeTitle;
  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen
        name="index"
        options={{
          title: t('recipes.tab.title'),
          headerLargeTitleEnabled: true,
          // A header background colour hides the large title on iOS 26+; the screen's own background shows through.
          headerStyle: { backgroundColor: 'transparent' },
          // The native large title, set in the display face (board 05).
          headerLargeTitleStyle: { color: colors.ink, fontFamily, fontSize, fontWeight },
        }}
      />
      {/* Spec 4.14, mockup C: the tab's filters. */}
      <Stack.Screen
        name="filter"
        options={{ title: t('recipes.filters.title'), presentation: 'formSheet', sheetAllowedDetents: [1], sheetGrabberVisible: true }}
      />
    </Stack>
  );
}
