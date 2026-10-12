import { router, Stack } from 'expo-router';
import { useMemo } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { prominentButtonTint } from '@/components/appearance';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { categories, households, userCategoryOrder } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { orderCategories } from '@/domain/category-resolver';
import { getAccount } from '@/features/auth/account';
import { aisleHouseholdLine } from '@/features/categories/aisle-copy';
import { AisleOrderList } from '@/features/categories/aisle-order-list';
import { categoriesQuery, moveCategory } from '@/features/categories/categories';
import { householdsQuery } from '@/features/households/households';
import { useTheme } from '@/hooks/use-theme';

/**
 * "Aisle order" (spec 4.3.3, board 12): the user's category order, used on every list. Opened from
 * a list's menu or from Settings.
 */
export default function CategoryOrderScreen() {
  const { spacing, colors, scheme } = useTheme();
  const userId = getAccount()?.userId ?? '';
  // System aisles plus the custom aisles of every household the user is in (spec 4.3.3).
  const { data: householdRows } = useLiveQueryOn(householdsQuery(), [households], []);
  const householdIds = useMemo(() => householdRows.map((h) => h.id), [householdRows]);
  const { data } = useLiveQueryOn(
    categoriesQuery(userId, householdIds),
    [categories, userCategoryOrder],
    [userId, householdIds.join()],
  );
  // With more than one household, a custom aisle shows its household's name (two "Costco"s).
  const ordered = useMemo(
    () => orderCategories(data).map((c) => ({ ...c, household: aisleHouseholdLine(c.householdId, householdRows) })),
    [data, householdRows],
  );

  return (
    // A modal is its own native view tree, so the drag gesture needs its own root.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Screen>
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button variant="done" tintColor={prominentButtonTint(scheme, colors)} onPress={() => router.back()}>
            Done
          </Stack.Toolbar.Button>
        </Stack.Toolbar>
        <AisleOrderList
          aisles={ordered}
          onMove={(from, to) => moveCategory(userId, householdIds, from, to)}
          header={
            <>
              <ThemedText
                variant="screenTitle"
                accessibilityRole="header"
                style={{ paddingHorizontal: spacing.lg + spacing.xs, paddingTop: spacing.md + spacing.xxs, paddingBottom: spacing.xs }}>
                Aisle order
              </ThemedText>
              <ThemedText
                variant="callout"
                color="inkSecondary"
                style={{ paddingHorizontal: spacing.lg + spacing.xs, paddingBottom: spacing.lg }}>
                Drag aisles into the order you walk the store. Only you see this order.
              </ThemedText>
            </>
          }
        />
      </Screen>
    </GestureHandlerRootView>
  );
}
