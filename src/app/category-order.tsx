import { router, Stack, useLocalSearchParams } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { prominentButtonTint } from '@/components/appearance';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { households } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { getAccount } from '@/features/auth/account';
import { moveId } from '@/features/categories/aisle-order';
import { AisleOrderList } from '@/features/categories/aisle-order-list';
import { saveMyAisleOrder } from '@/features/categories/aisle-orders';
import { useAisleOrder } from '@/features/categories/use-aisle-order';
import { householdsQuery } from '@/features/households/households';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * "Aisle order" (spec 4.3.3, board 12): one household's aisles (`householdId`, else the user's
 * first household) in the order the user follows there. Each move saves the whole order as the
 * user's own for that household. Opened from Settings (Store aisle order) or from a list's ⋯ menu
 * in By aisle (Reorder aisles…).
 */
export default function CategoryOrderScreen() {
  const t = useT();
  const { spacing, colors, scheme } = useTheme();
  const userId = getAccount()?.userId ?? '';
  const params = useLocalSearchParams<{ householdId?: string }>();
  const { data: householdRows } = useLiveQueryOn(householdsQuery(), [households], []);
  const householdId = params.householdId ?? householdRows[0]?.id ?? '';
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
