import { router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card } from '@/components/card';
import { ThemedText } from '@/components/themed-text';
import { Toast, type ToastAction } from '@/components/toast';
import { Screen } from '@/components/themed-view';
import { households } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { householdsQuery } from '@/features/households/households';
import { CollectionRow } from '@/features/recipes/collection-row';
import { collectionsByHousehold, useCollections } from '@/features/recipes/collections';
import { useDeletedCollectionToast } from '@/features/recipes/deleted-collection-result';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * Every collection (recipe collections board A's See all): the Add to collection sheet's rows without ticks,
 * A–Z, each opening the collection's screen. With several households, a card per household that has any,
 * under its name, households oldest first. A collection deleted on its screen comes back here with Undo.
 */
export default function CollectionsScreen() {
  const t = useT();
  const { spacing } = useTheme();
  const collections = useCollections();
  const { data: householdRows } = useLiveQueryOn(householdsQuery(), [households]);
  const [toast, setToast] = useState<{ key: string; message: string; emphasis?: string; actions: ToastAction[] } | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);
  useDeletedCollectionToast(setToast);

  const groups = useMemo(() => collectionsByHousehold(collections, householdRows), [collections, householdRows]);
  const labelHouseholds = groups.length > 1;
  const open = (id: string) => router.push({ pathname: '/collection/[id]', params: { id } });

  return (
    <Screen>
      <ScrollView
        style={styles.flex}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingTop: spacing.xs, paddingBottom: spacing.xxl, gap: spacing.lg }}>
        <ThemedText variant="screenTitle" accessibilityRole="header" style={{ paddingHorizontal: spacing.lg }}>
          {t('recipes.collections.allTitle')}
        </ThemedText>
        {groups.map((group) => (
          <View key={group.householdId} style={{ gap: spacing.sm }}>
            {labelHouseholds ? (
              <ThemedText
                variant="sectionLabel"
                color="inkSecondary"
                accessibilityRole="header"
                style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
                {group.name}
              </ThemedText>
            ) : null}
            <Card>
              {group.collections.map((c, i) => (
                <CollectionRow key={c.id} collection={c} first={i === 0} onPress={() => open(c.id)} />
              ))}
            </Card>
          </View>
        ))}
      </ScrollView>
      {toast ? (
        <SafeAreaView edges={['bottom']} pointerEvents="box-none" style={[styles.toast, { paddingBottom: spacing.sm }]}>
          <Toast key={toast.key} message={toast.message} emphasis={toast.emphasis} actions={toast.actions} onDismiss={dismissToast} />
        </SafeAreaView>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  toast: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
