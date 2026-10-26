import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { CheckCircle } from '@/components/check-circle';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { i18n, useT } from '@/i18n';

import { CollectionCover } from './collection-cover';
import type { CollectionSummary } from './collections';

/** VoiceOver's name for a collection: "Mom's cookbook, 12 recipes". */
export function collectionLabel(collection: { name: string; recipeCount: number }): string {
  return i18n.t('recipes.collections.row', {
    name: collection.name,
    count: i18n.t('recipes.collections.count', { count: collection.recipeCount }),
  });
}

/**
 * A collection's row (boards C, A): its cover, name and "N recipes". With `ticked` (the Add to collection sheet)
 * a round tick on the right and VoiceOver reads a checkbox; without (See all) a chevron, and it's a button
 * opening the collection.
 */
export function CollectionRow({
  collection,
  ticked,
  first,
  onPress,
}: {
  collection: CollectionSummary;
  ticked?: boolean;
  first: boolean;
  onPress: () => void;
}) {
  const t = useT();
  const { sizes } = useTheme();
  const picking = ticked !== undefined;
  return (
    <CollectionRowFrame
      first={first}
      onPress={onPress}
      accessibilityRole={picking ? 'checkbox' : 'button'}
      accessibilityState={picking ? { checked: ticked } : undefined}
      accessibilityHint={picking ? undefined : t('recipes.collections.opensCollection')}
      accessibilityLabel={collectionLabel(collection)}>
      <CollectionCover cover={collection.cover} />
      <View style={styles.flex}>
        <ThemedText variant="headline" numberOfLines={1}>
          {collection.name}
        </ThemedText>
        <ThemedText variant="footnote" color="inkSecondary">
          {t('recipes.collections.count', { count: collection.recipeCount })}
        </ThemedText>
      </View>
      {picking ? <CheckCircle checked={ticked} /> : <Icon name="chevron.right" color="inkSecondary" size={sizes.iconSmall} />}
    </CollectionRowFrame>
  );
}

/** A row in a card of collections: 44 pt or taller, a hairline above all but the first. */
export function CollectionRowFrame({
  first,
  children,
  ...rest
}: {
  first: boolean;
  children: ReactNode;
  onPress: () => void;
  accessibilityRole: 'checkbox' | 'button';
  accessibilityLabel: string;
  accessibilityHint?: string;
  accessibilityState?: { checked: boolean };
}) {
  const { colors, spacing, sizes, opacity } = useTheme();
  return (
    <Pressable
      {...rest}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: sizes.cardRowMin,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.sm,
          gap: spacing.md,
          borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
});
