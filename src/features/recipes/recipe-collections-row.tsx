import { Pressable, StyleSheet } from 'react-native';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { useRecipeCollections } from '@/features/recipes/collections';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * The recipe screen's collections line (board F), under the tags: a stacked-folders glyph, the collections
 * the recipe is in A–Z joined with " · ", truncated at the tail, then a chevron, as one button opening the
 * Add to collection sheet (`onEdit`). In none, nothing.
 */
export function RecipeCollectionsRow({ recipeId, onEdit }: { recipeId: string; onEdit: () => void }) {
  const t = useT();
  const { spacing, sizes, opacity } = useTheme();
  const collections = useRecipeCollections(recipeId);
  if (collections.length === 0) return null;
  const names = collections.map((c) => c.name);
  return (
    <Pressable
      testID="recipe-collections-line"
      accessibilityRole="button"
      accessibilityLabel={t('recipes.collections.line', { names: names.join(', ') })}
      accessibilityHint={t('recipes.collections.lineHint')}
      onPress={onEdit}
      style={({ pressed }) => [styles.row, { gap: spacing.xs, minHeight: sizes.minTapTarget, opacity: pressed ? opacity.pressed : 1 }]}>
      <Icon name="rectangle.stack" color="inkSecondary" size={sizes.iconSmall} />
      <ThemedText variant="footnote" color="inkSecondary" numberOfLines={1} ellipsizeMode="tail" style={styles.shrink}>
        {names.join(' · ')}
      </ThemedText>
      <Icon name="chevron.right" color="inkSecondary" size={sizes.iconSmall} weight="semibold" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  shrink: { flexShrink: 1 },
});
