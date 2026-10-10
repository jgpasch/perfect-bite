import { Stack } from 'expo-router';

import { useStackScreenOptions } from '@/hooks/use-navigation-theme';
import { useTheme } from '@/hooks/use-theme';

export default function ListsStackLayout() {
  const screenOptions = useStackScreenOptions();
  const { colors, typography } = useTheme();
  const { fontFamily, fontSize, fontWeight } = typography.largeTitle;
  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen
        name="index"
        options={{
          title: 'Your lists',
          headerLargeTitleEnabled: true,
          // The native large title, set in the display face (board 01).
          headerLargeTitleStyle: { color: colors.ink, fontFamily, fontSize, fontWeight },
        }}
      />
    </Stack>
  );
}
