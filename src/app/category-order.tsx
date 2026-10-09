import { Host, List, Text as SwiftText } from '@expo/ui/swift-ui';
import { deleteDisabled, environment } from '@expo/ui/swift-ui/modifiers';
import { router, Stack } from 'expo-router';
import { useMemo } from 'react';
import { StyleSheet } from 'react-native';

import { Screen } from '@/components/themed-view';
import { categories, userCategoryOrder } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { orderCategories } from '@/domain/category-resolver';
import { getAccount } from '@/features/auth/account';
import { categoriesQuery, moveCategory } from '@/features/categories/categories';
import { useTheme } from '@/hooks/use-theme';

/**
 * "Reorder sections" (spec 4.3.3): the user's category order, used on every list. Opened from a
 * list's menu or from Settings.
 */
export default function CategoryOrderScreen() {
  const { scheme, colors } = useTheme();
  const userId = getAccount()?.userId ?? '';
  const { data } = useLiveQueryOn(categoriesQuery(userId), [categories, userCategoryOrder], [userId]);
  const ordered = useMemo(() => orderCategories(data), [data]);

  return (
    <Screen>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button variant="done" onPress={() => router.back()}>
          Done
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Host style={styles.flex} colorScheme={scheme} seedColor={colors.primary}>
        <List modifiers={[environment('editMode', 'active')]}>
          {/* SwiftUI's onMove destination is the index to insert before. */}
          <List.ForEach
            onMove={(from, destination) => {
              const source = from[0];
              moveCategory(userId, source, destination > source ? destination - 1 : destination);
            }}>
            {ordered.map((c) => (
              <SwiftText key={c.id} modifiers={[deleteDisabled()]}>{c.name}</SwiftText>
            ))}
          </List.ForEach>
        </List>
      </Host>
    </Screen>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
