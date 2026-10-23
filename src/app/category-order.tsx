import { router, Stack, useLocalSearchParams } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { prominentButtonTint } from '@/components/appearance';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { getAccount } from '@/features/auth/account';
import { moveId } from '@/features/categories/aisle-order';
import { AisleOrderList } from '@/features/categories/aisle-order-list';
import { saveMyAisleOrder } from '@/features/categories/aisle-orders';
import { useAisleOrder } from '@/features/categories/use-aisle-order';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * "Aisle order" (spec 4.3.3, board 12): the aisles of the household `householdId` (its system
 * aisles plus its own custom ones) in the order the user follows there. Each move saves the whole
 * order as the user's own for that household. Opened from the household's screen (Settings →
 * Households → [Household] → Aisle order) or from a list's ⋯ menu in By aisle (Reorder aisles…).
 */
export default function CategoryOrderScreen() {
  const t = useT();
  const { spacing, colors, scheme } = useTheme();
  const userId = getAccount()?.userId ?? '';
  const { householdId = '' } = useLocalSearchParams<{ householdId?: string }>();
  const { categories: ordered } = useAisleOrder(userId, householdId);

  return (
    // A modal is its own native view tree, so the drag gesture needs its own root.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Screen>
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button variant="done" tintColor={prominentButtonTint(scheme, colors)} onPress={() => router.back()}>
            {t('common.done')}
          </Stack.Toolbar.Button>
        </Stack.Toolbar>
        <AisleOrderList
          aisles={ordered}
          onMove={(from, to) => {
            if (householdId) saveMyAisleOrder(householdId, moveId(ordered.map((c) => c.id), from, to));
          }}
          header={
            <>
              <ThemedText
                variant="screenTitle"
                accessibilityRole="header"
                style={{ paddingHorizontal: spacing.lg + spacing.xs, paddingTop: spacing.md + spacing.xxs, paddingBottom: spacing.xs }}>
                {t('aisleOrder.title')}
              </ThemedText>
              <ThemedText
                variant="callout"
                color="inkSecondary"
                style={{ paddingHorizontal: spacing.lg + spacing.xs, paddingBottom: spacing.lg }}>
                {t('aisleOrder.intro')}
              </ThemedText>
            </>
          }
        />
      </Screen>
    </GestureHandlerRootView>
  );
}
