import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import { recipeHue } from '@/domain/aisle-color';
import type { CollectionCoverRecipe } from '@/features/recipes/collections';
import { useRecipePhoto } from '@/features/recipes/recipe-photo-source';
import { useTheme } from '@/hooks/use-theme';

/**
 * A collection's cover (board C): a square, radius `md`, split 2×2 with an `xxs` gap, one cell per recipe of
 * `cover` (its first four A–Z). A cell shows the recipe's photo (own, else the site's) over its aisle-colour
 * tile, which shows alone without a photo or when it fails; cells past the last recipe are `surfaceMuted`.
 * `size` is the side, `sizes.recipeTile` (48) by default. Decorative.
 */
export function CollectionCover({ cover, size }: { cover: readonly CollectionCoverRecipe[]; size?: number }) {
  const { colors, sizes, spacing, rounded } = useTheme();
  const side = size ?? sizes.recipeTile;
  const cell = (side - spacing.xxs) / 2;
  return (
    <View
      testID="collection-cover"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[
        styles.grid,
        { width: side, height: side, gap: spacing.xxs, borderRadius: rounded.md, backgroundColor: colors.surface },
      ]}>
      {[0, 1, 2, 3].map((i) => {
        const recipe = cover[i];
        return recipe ? (
          <CoverCell key={recipe.id} recipe={recipe} side={cell} />
        ) : (
          <View key={`empty-${i}`} testID="collection-cover-empty" style={{ width: cell, height: cell, backgroundColor: colors.surfaceMuted }} />
        );
      })}
    </View>
  );
}

function CoverCell({ recipe, side }: { recipe: CollectionCoverRecipe; side: number }) {
  const { aisles } = useTheme();
  const { source, onError } = useRecipePhoto({ imageUrl: recipe.imageUrl, photoPath: recipe.photoPath });
  return (
    <View testID="collection-cover-cell" style={{ width: side, height: side, backgroundColor: aisles[recipeHue(recipe.id)].soft }}>
      {source !== null ? (
        <Image
          testID="recipe-photo"
          source={source}
          contentFit="cover"
          cachePolicy="disk"
          accessible={false}
          onError={onError}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', overflow: 'hidden', borderCurve: 'continuous' },
});
