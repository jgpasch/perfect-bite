import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { favoriteLabel, useRecipeFavorites } from '@/features/recipes/favorites';
import { recipeTagLine } from '@/features/recipes/recipe-tags-view';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';
import type { RecipeTags } from '@/shared/recipe-tags';

/**
 * The recipe band's tags (spec 4.14): one line, a tag glyph, then the values without facet names
 * ("Lunch · Dinner · Under 1 hour"; a favorite first as a heart, filled `primary` for the user's own,
 * outlined `inkSecondary` for only other members'), truncated at the tail, then a chevron. The whole
 * line is one button that opens the Tags sheet (`onEdit`). With no tag and no favorite, "Add tags"
 * instead, then " · Suggest tags" when given `onSuggest` (the plan has `recipe_tags` and there are
 * ingredients), which opens the sheet suggesting.
 */
export function RecipeTagRow({
  recipe,
  onEdit,
  onSuggest,
}: {
  recipe: { id: string; tags: RecipeTags | null; totalMinutes: number | null };
  onEdit: () => void;
  onSuggest?: () => void;
}) {
  const t = useT();
  const { spacing, sizes, opacity } = useTheme();
  const favorite = useRecipeFavorites().get(recipe.id);
  const line = recipeTagLine(
    recipe.tags,
    recipe.totalMinutes,
    favorite ? { mine: favorite.mine, label: favoriteLabel(favorite.mine, favorite.others) ?? '' } : null,
  );
  const pressedStyle = ({ pressed }: { pressed: boolean }) => [
    styles.row,
    { minHeight: sizes.minTapTarget, opacity: pressed ? opacity.pressed : 1 },
  ];

  if (!line) {
    return (
      <View style={[styles.row, { gap: spacing.xs }]}>
        <Icon name="tag" color="inkSecondary" size={sizes.iconSmall} />
        <Pressable accessibilityRole="button" accessibilityLabel={t('recipes.tags.add')} onPress={onEdit} style={pressedStyle}>
          <ThemedText variant="footnote" color="primary">
            {t('recipes.tags.add')}
          </ThemedText>
        </Pressable>
        {onSuggest ? (
          <>
            <ThemedText variant="footnote" color="inkSecondary" importantForAccessibility="no" accessible={false}>
              ·
            </ThemedText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('recipes.tags.suggest')}
              accessibilityHint={t('recipes.tags.suggestRowHint')}
              onPress={onSuggest}
              style={pressedStyle}>
              <ThemedText variant="footnote" color="primary">
                {t('recipes.tags.suggest')}
              </ThemedText>
            </Pressable>
          </>
        ) : null}
      </View>
    );
  }

  return (
    <Pressable
      testID="recipe-tag-line"
      accessibilityRole="button"
      accessibilityLabel={line.accessibilityLabel}
      accessibilityHint={t('recipes.tags.editHint')}
      onPress={onEdit}
      style={(state) => [pressedStyle(state), { gap: spacing.xs }]}>
      <Icon name="tag" color="inkSecondary" size={sizes.iconSmall} />
      {line.favorite === 'mine' ? (
        <Icon name="heart.fill" color="primary" size={sizes.iconSmall} />
      ) : line.favorite === 'others' ? (
        <Icon name="heart" color="inkSecondary" size={sizes.iconSmall} />
      ) : null}
      <ThemedText variant="footnote" color="inkSecondary" numberOfLines={1} ellipsizeMode="tail" style={styles.shrink}>
        {line.text}
      </ThemedText>
      <Icon name="chevron.right" color="inkSecondary" size={sizes.iconSmall} weight="semibold" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  shrink: { flexShrink: 1 },
});
