import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Icon } from '@/components/icon';
import { IconTile } from '@/components/icon-tile';
import { recipeHue } from '@/domain/aisle-color';
import { useTheme } from '@/hooks/use-theme';

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
 * A recipe row's tile (board 18): the site's photo filling the icon tile's square at its radius, over the
 * icon tile, which shows while it loads and stays if loading fails. Without a photo, just the icon tile.
 * `size` is the side, `sizes.recipeTile` (48) by default. Decorative.
 */
export function RecipePhotoTile({ recipeId, imageUrl, size }: { recipeId: string; imageUrl: string | null; size?: number }) {
  const { sizes, rounded } = useTheme();
  const { failed, onError } = usePhotoFailed(imageUrl);
  const tile = <IconTile hue={recipeHue(recipeId)} name="fork.knife" size={size ?? sizes.recipeTile} />;
  if (imageUrl === null || failed) return tile;
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      {tile}
      <Image
        testID="recipe-photo"
        source={imageUrl}
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
export function RecipePhotoCover({ recipeId, imageUrl }: { recipeId: string; imageUrl: string | null }) {
  const { aisles, sizes, rounded } = useTheme();
  const { failed, onError } = usePhotoFailed(imageUrl);
  const hue = aisles[recipeHue(recipeId)];
  return (
    <View
      testID="recipe-photo-cover"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[styles.cover, { borderRadius: rounded.md, backgroundColor: hue.soft }]}>
      <Icon name="fork.knife" tint={hue.dot} size={sizes.recipeTile * 0.55} weight="semibold" />
      {imageUrl !== null && !failed ? (
        <Image
          testID="recipe-photo"
          source={imageUrl}
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
 * it loads. `onError` tells the screen to drop it, so the band and its tinted header come back. Decorative.
 */
export function RecipePhotoHeader({ imageUrl, tint, onError }: { imageUrl: string; tint: string; onError: () => void }) {
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[styles.header, { backgroundColor: tint }]}>
      <Image
        testID="recipe-photo"
        source={imageUrl}
        contentFit="cover"
        cachePolicy="disk"
        accessible={false}
        onError={onError}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: { width: '100%', aspectRatio: 16 / 9, overflow: 'hidden' },
  cover: { width: '100%', aspectRatio: 4 / 3, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
});
