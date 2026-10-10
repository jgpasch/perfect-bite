import { router, Stack } from 'expo-router';
import { useMemo } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { prominentButtonTint } from '@/components/appearance';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { categories, userCategoryOrder } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { orderCategories } from '@/domain/category-resolver';
import { getAccount } from '@/features/auth/account';
import { AisleOrderList } from '@/features/categories/aisle-order-list';
import { categoriesQuery, moveCategory } from '@/features/categories/categories';
import { useTheme } from '@/hooks/use-theme';

/**
 * "Aisle order" (spec 4.3.3, board 12): the user's category order, used on every list. Opened from
 * a list's menu or from Settings.
 */
export default function CategoryOrderScreen() {
  const { spacing, colors, scheme } = useTheme();
  const userId = getAccount()?.userId ?? '';
  const { data } = useLiveQueryOn(categoriesQuery(userId), [categories, userCategoryOrder], [userId]);
  const ordered = useMemo(() => orderCategories(data), [data]);

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
          onMove={(from, to) => moveCategory(userId, from, to)}
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
