import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

import { CollectionCover } from './collection-cover';
import { collectionLabel } from './collection-row';
import type { CollectionSummary } from './collections';

/** The shelf tiles' cover: as wide as a recipe tile, at the recipe photo's 4:3. */
function useTileCover() {
  const { sizes } = useTheme();
  return { width: sizes.shelfTile, height: (sizes.shelfTile * 3) / 4 };
}

/**
 * A collection's tile on the Collections shelf (board A): the 2×2 cover at 4:3, the name on one line, then
 * "N recipes". One button opening the collection (VoiceOver "Mom's cookbook, 12 recipes").
 */
export function CollectionShelfTile({ collection, onPress }: { collection: CollectionSummary; onPress: () => void }) {
  const t = useT();
  const { spacing, opacity } = useTheme();
  const cover = useTileCover();
  return (
    <Pressable
      testID="collection-shelf-tile"
      accessibilityRole="button"
      accessibilityLabel={collectionLabel(collection)}
      accessibilityHint={t('recipes.collections.opensCollection')}
      onPress={onPress}
      style={({ pressed }) => ({ width: cover.width, gap: spacing.xxs, opacity: pressed ? opacity.pressed : 1 })}>
      <View style={{ marginBottom: spacing.xs }}>
        <CollectionCover cover={collection.cover} size={cover.width} height={cover.height} />
      </View>
      <ThemedText variant="headline" numberOfLines={1}>
        {collection.name}
      </ThemedText>
      <ThemedText variant="footnote" color="inkSecondary" numberOfLines={1}>
        {t('recipes.collections.count', { count: collection.recipeCount })}
      </ThemedText>
    </Pressable>
  );
}

/** The shelf's last tile (board A): a dashed outline the size of a cover, a plus over "New collection", in `primary`. */
export function NewCollectionTile({ onPress }: { onPress: () => void }) {
  const t = useT();
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const cover = useTileCover();
  return (
    <Pressable
      testID="collection-shelf-new"
      accessibilityRole="button"
      accessibilityLabel={t('recipes.collections.newTile')}
      onPress={onPress}
      style={({ pressed }) => [
        styles.newTile,
        {
          width: cover.width,
          height: cover.height,
          gap: spacing.xs,
          borderRadius: rounded.md,
          borderWidth: sizes.checkBorder,
          borderColor: colors.controlBorder,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <Icon name="plus" color="primary" weight="semibold" />
      <ThemedText variant="subhead" color="primary" style={styles.bold} numberOfLines={1}>
        {t('recipes.collections.newTile')}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  newTile: { alignItems: 'center', justifyContent: 'center', borderStyle: 'dashed', borderCurve: 'continuous' },
  bold: { fontWeight: '600' },
});
