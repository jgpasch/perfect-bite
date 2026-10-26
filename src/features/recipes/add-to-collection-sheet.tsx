import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { prominentButtonTint } from '@/components/appearance';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

import { toggled } from './add-sheet';
import { CollectionRow, CollectionRowFrame } from './collection-row';
import { useHouseholdCollections } from './collections';
import { promptNewCollection } from './prompt-collection-name';

/**
 * Add to collection (boards C and D): `subtitle` under the title (the recipe's name, or "4 recipes"), then one
 * row per collection of the household (the cover, the name and "N recipes") with a round tick, starting
 * ticked for the ones in `before`, then New collection…, which asks for a name and creates the collection at
 * once, ticked. Done hands the ticks to `onDone`; Cancel drops them (a collection made here stays, empty).
 * The footnote says collections are shared.
 */
export function AddToCollectionSheet({
  householdId,
  subtitle,
  before,
  onDone,
}: {
  householdId: string;
  subtitle: string;
  before: ReadonlySet<string>;
  onDone: (ticked: ReadonlySet<string>) => void;
}) {
  const t = useT();
  const { colors, spacing, scheme } = useTheme();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(before);
  // Live, so a new collection shows.
  const collections = useHouseholdCollections(householdId);
  const inset = { paddingHorizontal: spacing.lg + spacing.xs };

  return (
    <Screen>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>{t('common.cancel')}</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button variant="done" tintColor={prominentButtonTint(scheme, colors)} onPress={() => onDone(ticked)}>
          {t('common.done')}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ScrollView
        style={styles.flex}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ gap: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.xxl }}>
        <View style={[inset, { gap: spacing.xs }]}>
          <ThemedText variant="title" accessibilityRole="header">
            {t('recipes.collections.title')}
          </ThemedText>
          <ThemedText variant="subhead" color="inkSecondary" numberOfLines={1}>
            {subtitle}
          </ThemedText>
        </View>
        <View style={{ gap: spacing.sm }}>
          <Card>
            {collections.map((c, i) => (
              <CollectionRow
                key={c.id}
                collection={c}
                ticked={ticked.has(c.id)}
                first={i === 0}
                onPress={() => setTicked((current) => toggled(current, c.id))}
              />
            ))}
            <NewCollectionRow
              first={collections.length === 0}
              onPress={() => promptNewCollection(householdId, (created) => setTicked((current) => new Set([...current, created])))}
            />
          </Card>
          <ThemedText variant="footnote" color="inkSecondary" style={inset}>
            {t('recipes.collections.footnote')}
          </ThemedText>
        </View>
      </ScrollView>
    </Screen>
  );
}

/** New collection…: a plus in a `primarySoft` well, in `primary`. */
function NewCollectionRow({ first, onPress }: { first: boolean; onPress: () => void }) {
  const t = useT();
  const { colors, sizes, rounded } = useTheme();
  return (
    <CollectionRowFrame first={first} onPress={onPress} accessibilityRole="button" accessibilityLabel={t('recipes.collections.new')}>
      <View
        style={[
          styles.well,
          { width: sizes.recipeTile, height: sizes.recipeTile, borderRadius: rounded.md, backgroundColor: colors.primarySoft },
        ]}>
        <Icon name="plus" color="primary" weight="semibold" />
      </View>
      <ThemedText variant="headline" color="primary" style={styles.flex}>
        {t('recipes.collections.new')}
      </ThemedText>
    </CollectionRowFrame>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  well: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
});
