import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Badge } from '@/components/badge';
import { Button } from '@/components/button';
import { Icon, type IconName } from '@/components/icon';
import { FoldingSection } from '@/components/section-header';
import { ThemedText } from '@/components/themed-text';
import type { ColorToken } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

import { RecipePhotoCover } from './recipe-photo';
import { recipeSectionUnit } from './recipe-sort';
import type { RecipeShelf as Shelf, RecipeShelfItem, RecipeShelfKey } from './recipe-shelves';

/** Each shelf's glyph and its colour. */
export const SHELF_GLYPHS: Record<RecipeShelfKey, { name: IconName; color: ColorToken }> = {
  thisWeek: { name: 'calendar', color: 'inkSecondary' },
  recent: { name: 'clock', color: 'inkSecondary' },
  favorites: { name: 'heart.fill', color: 'primary' },
};

type ShelfRecipe = { id: string; name: string; imageUrl: string | null; photoPath: string | null };

/**
 * A shelf on the Recipes tab (spec 4.5): a header row (the glyph, the title, See all N) over a sideways row
 * of 140 pt tiles. The screen wraps each tile (`renderTile`) in its link and long-press menu. With `fold`
 * (while grouped) it's a folding row in the shelves' card: the glyph, title and count, opening to See all and
 * the tiles.
 */
export function RecipeShelf<R extends ShelfRecipe>({
  shelf,
  onSeeAll,
  renderTile,
  fold,
}: {
  shelf: Shelf<R>;
  onSeeAll: () => void;
  renderTile: (item: RecipeShelfItem<R>) => ReactNode;
  fold?: { open: boolean; onToggle: () => void };
}) {
  const t = useT();
  const { spacing } = useTheme();
  const glyph = SHELF_GLYPHS[shelf.key];
  const seeAll = (
    <Button
      testID={`recipe-shelf-${shelf.key}-see-all`}
      variant="plain"
      label={t('recipes.shelves.seeAll', { count: shelf.count })}
      onPress={onSeeAll}
    />
  );
  const tiles = (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: spacing.md, paddingHorizontal: spacing.lg }}>
      {shelf.items.map((item) => (
        <View key={item.recipe.id}>{renderTile(item)}</View>
      ))}
    </ScrollView>
  );
  if (fold) {
    return (
      <View testID={`recipe-shelf-${shelf.key}`}>
        <FoldingSection
          title={shelf.title}
          leading={<Icon name={glyph.name} color={glyph.color} />}
          count={shelf.count}
          countUnit={recipeSectionUnit()}
          hideCount={fold.open}
          trailing={fold.open ? seeAll : undefined}
          collapsed={!fold.open}
          onToggle={fold.onToggle}>
          <View style={{ paddingTop: spacing.xs, paddingBottom: spacing.lg }}>{tiles}</View>
        </FoldingSection>
      </View>
    );
  }
  return (
    <View testID={`recipe-shelf-${shelf.key}`} style={{ gap: spacing.sm }}>
      <View style={[styles.header, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
        <Icon name={glyph.name} color={glyph.color} />
        <ThemedText variant="sectionTitle" accessibilityRole="header" numberOfLines={1} style={styles.title}>
          {shelf.title}
        </ThemedText>
        {seeAll}
      </View>
      {tiles}
    </View>
  );
}

/** A shelf's tile: the photo at 4:3 with the "On <list>" badge over its corner, the name, then the caption. */
export function RecipeShelfTile({
  recipe,
  caption,
  onList,
}: {
  recipe: ShelfRecipe;
  caption: string | null;
  onList: string | null;
}) {
  const t = useT();
  const { spacing, sizes } = useTheme();
  return (
    <View testID="recipe-shelf-tile" style={{ width: sizes.shelfTile, gap: spacing.xxs }}>
      <View style={{ marginBottom: spacing.xs }}>
        <RecipePhotoCover recipeId={recipe.id} imageUrl={recipe.imageUrl} photoPath={recipe.photoPath} />
        {onList ? (
          <View style={[styles.badge, { top: spacing.xs, end: spacing.xs }]}>
            <Badge label={t('recipes.tab.onList', { name: onList })} />
          </View>
        ) : null}
      </View>
      <ThemedText variant="headline" numberOfLines={2}>
        {recipe.name}
      </ThemedText>
      {caption ? (
        <ThemedText variant="footnote" color="inkSecondary" numberOfLines={1}>
          {caption}
        </ThemedText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center' },
  title: { flex: 1, flexShrink: 1 },
  badge: { position: 'absolute', maxWidth: '80%' },
});
