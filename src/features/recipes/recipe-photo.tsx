import { Image } from 'expo-image';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/icon';
import { IconTile } from '@/components/icon-tile';
import { recipeHue } from '@/domain/aisle-color';
import { RecipeCredit } from '@/features/recipes/recipe-credit';
import { useRecipePhoto, type RecipeImageSource } from '@/features/recipes/recipe-photo-source';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * The URL that failed to load, so a dead link or hotlink blocking falls back for good in this view; a
 * new `imageUrl` gets its own try.
 */
export function usePhotoFailed(imageUrl: string | null) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = imageUrl !== null && failedUrl === imageUrl;
  return { failed, onError: () => setFailedUrl(imageUrl) };
}

/**
 * A recipe row's tile (board 18): the recipe's photo (its own `photoPath`, else the site's `imageUrl`,
 * spec 4.5) filling the icon tile's square at its radius, over the icon tile, which shows while it
 * loads and stays if loading fails. Without a photo, just the icon tile. `size` is the side,
 * `sizes.recipeTile` (48) by default. Decorative.
 */
export function RecipePhotoTile({
  recipeId,
  imageUrl,
  photoPath = null,
  size,
}: {
  recipeId: string;
  imageUrl: string | null;
  photoPath?: string | null;
  size?: number;
}) {
  const { sizes, rounded } = useTheme();
  const { source, onError } = useRecipePhoto({ imageUrl, photoPath });
  const tile = <IconTile hue={recipeHue(recipeId)} name="fork.knife" size={size ?? sizes.recipeTile} />;
  if (source === null) return tile;
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      {tile}
      <Image
        testID="recipe-photo"
        source={source}
        contentFit="cover"
        cachePolicy="disk"
        accessible={false}
        onError={onError}
        style={[StyleSheet.absoluteFill, { borderRadius: rounded.md }]}
      />
    </View>
  );
}

/**
 * A large-photos tile's photo (spec 4.5): the column's width at 4:3, radius `md`, over the `recipeHue`
 * icon tile's colour and glyph, which show while it loads, if it fails, or without a photo. Decorative.
 */
export function RecipePhotoCover({
  recipeId,
  imageUrl,
  photoPath = null,
}: {
  recipeId: string;
  imageUrl: string | null;
  photoPath?: string | null;
}) {
  const { aisles, sizes, rounded } = useTheme();
  const { source, onError } = useRecipePhoto({ imageUrl, photoPath });
  const hue = aisles[recipeHue(recipeId)];
  return (
    <View
      testID="recipe-photo-cover"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[styles.cover, { borderRadius: rounded.md, backgroundColor: hue.soft }]}>
      <Icon name="fork.knife" tint={hue.dot} size={sizes.recipeTile * 0.55} weight="semibold" />
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

/**
 * The recipe screen's photo header (board 13): full width at 16:9 above the band, in the band's tint while
 * it loads. `onError` tells the screen, which retries or drops it, so the band and its tinted header come
 * back. The photo is decorative; its bottom-right corner credits it (spec 4.5) with the source credit
 * (`sourceUrl`), for a site's photo only (the screen passes none for the household's own).
 * `uploading`: a photo being uploaded, shown from the device with a spinner over it and no credit.
 */
export function RecipePhotoHeader({
  source,
  tint,
  sourceUrl,
  uploading = false,
  onError,
}: {
  source: RecipeImageSource;
  tint: string;
  sourceUrl?: string | null;
  uploading?: boolean;
  onError: (event?: { error?: string }) => void;
}) {
  const { colors, rounded, spacing } = useTheme();
  const t = useT();
  return (
    // The credit is the photo's sibling, so VoiceOver still reaches it; it's placed over the photo's corner.
    <View>
      <View
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        style={[styles.header, { backgroundColor: tint }]}>
        <Image
          testID="recipe-photo"
          source={source}
          contentFit="cover"
          cachePolicy="disk"
          accessible={false}
          onError={onError}
          style={StyleSheet.absoluteFill}
        />
      </View>
      {uploading ? (
        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
          <View
            testID="photo-uploading"
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={t('recipes.photo.uploading')}
            style={{ backgroundColor: colors.toast, borderRadius: rounded.md, padding: spacing.sm }}>
            <ActivityIndicator color={colors.onToast} />
          </View>
        </View>
      ) : (
        <RecipeCredit sourceUrl={sourceUrl} onPhoto />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { width: '100%', aspectRatio: 16 / 9, overflow: 'hidden' },
  cover: { width: '100%', aspectRatio: 4 / 3, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  center: { alignItems: 'center', justifyContent: 'center' },
});
