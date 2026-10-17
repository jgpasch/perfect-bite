import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { SoftDangerButton } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { recipeLinkUrl } from '@/features/recipes/recipe-link';
import { chooseRecipePhoto, loadPagePhotos, type PagePhotosResult } from '@/features/recipes/recipe-photos';
import { getRecipe } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/** Placeholder tiles while the page's photos load: two rows. */
const PLACEHOLDERS = 4;

/**
 * The Choose a photo sheet (spec 4.5), from the recipe screen's Add photo tile or Change photo….
 * **From the page**, only when the recipe's link opens: the page's photos (`recipe-photos`, up to
 * 12) in a two-column grid of 4:3 tiles, the current photo outlined in `primary`; picking one sets
 * it and closes the sheet, and the recipe screen shows "Photo updated" with Undo. **Remove photo**
 * when there is one. A page photo that fails to load is left out of the grid.
 */
export default function RecipePhotoSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useT();
  const { spacing } = useTheme();
  // A sheet is short-lived: read once rather than live.
  const [recipe] = useState(() => getRecipe(id));
  const link = recipeLinkUrl(recipe?.sourceUrl)?.href ?? null;
  const [result, setResult] = useState<PagePhotosResult | null>(null);
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!link) return;
    let live = true;
    void loadPagePhotos(link).then((r) => live && setResult(r));
    return () => {
      live = false;
    };
  }, [link]);

  if (!recipe) return <Screen />;

  const current = recipe.imageUrl;
  const choose = (imageUrl: string | null) => {
    chooseRecipePhoto(recipe.id, current, imageUrl);
    router.back();
  };
  const inset = { paddingHorizontal: spacing.lg + spacing.xs };

  return (
    <Screen scroll contentContainerStyle={{ paddingTop: spacing.xs, paddingBottom: spacing.xxl, gap: spacing.md }}>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>{t('common.cancel')}</Stack.Toolbar.Button>
      </Stack.Toolbar>

      <ThemedText variant="sheetTitle" accessibilityRole="header" style={inset}>
        {t('recipes.photo.sheetTitle')}
      </ThemedText>

      {link ? (
        <View style={{ gap: spacing.sm }}>
          <ThemedText variant="sectionLabel" color="inkSecondary" accessibilityRole="header" style={inset}>
            {t('recipes.photo.fromPage')}
          </ThemedText>
          <PageSection
            result={result}
            images={result?.ok ? result.images.filter((url) => !broken.has(url)) : []}
            current={current}
            onPick={choose}
            onBroken={(url) => setBroken((prev) => new Set(prev).add(url))}
          />
        </View>
      ) : null}

      {current !== null ? (
        <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm }}>
          <SoftDangerButton label={t('recipes.photo.remove')} onPress={() => choose(null)} />
        </View>
      ) : null}
    </Screen>
  );
}

/** The From the page section's body: placeholders while loading, a note when there's nothing, else the grid. */
function PageSection({
  result,
  images,
  current,
  onPick,
  onBroken,
}: {
  result: PagePhotosResult | null;
  images: string[];
  current: string | null;
  onPick: (url: string) => void;
  onBroken: (url: string) => void;
}) {
  const t = useT();
  const { spacing } = useTheme();
  const inset = { paddingHorizontal: spacing.lg + spacing.xs };

  if (result === null) {
    return (
      <View accessible accessibilityLabel={t('recipes.photo.loading')} testID="photo-placeholders">
        <Grid count={PLACEHOLDERS} render={(i) => <PlaceholderTile key={i} />} />
      </View>
    );
  }
  if (!result.ok && result.error !== 'none') {
    return (
      <ThemedText variant="callout" color="inkSecondary" style={inset}>
        {t(result.error === 'offline' ? 'recipes.photo.offline' : 'recipes.photo.failed')}
      </ThemedText>
    );
  }
  if (images.length === 0) {
    return (
      <ThemedText variant="callout" color="inkSecondary" style={inset}>
        {t('recipes.photo.noneFound')}
      </ThemedText>
    );
  }
  return (
    <Grid
      count={images.length}
      render={(i) => (
        <PhotoTile
          key={images[i]}
          url={images[i]}
          label={t('recipes.photo.tile', { index: i + 1, count: images.length })}
          selected={images[i] === current}
          onPress={() => onPick(images[i])}
          onError={() => onBroken(images[i])}
        />
      )}
    />
  );
}

/** Two columns, `sm` apart, 16 pt in; an odd last tile keeps its column's width. */
function Grid({ count, render }: { count: number; render: (index: number) => ReactNode }) {
  const { spacing } = useTheme();
  const rows = Array.from({ length: Math.ceil(count / 2) }, (_, r) => r * 2);
  return (
    <View style={{ gap: spacing.sm, paddingHorizontal: spacing.lg }}>
      {rows.map((first) => (
        <View key={first} style={[styles.row, { gap: spacing.sm }]}>
          {render(first)}
          {first + 1 < count ? render(first + 1) : <View style={styles.cell} />}
        </View>
      ))}
    </View>
  );
}

function PlaceholderTile() {
  const { colors, rounded } = useTheme();
  return <View style={[styles.cell, styles.tile, { borderRadius: rounded.md, backgroundColor: colors.surfaceMuted }]} />;
}

/** A page photo at 4:3, radius `md`; the current photo has a `primary` outline. VoiceOver: "Photo 3 of 8 from the page". */
function PhotoTile({
  url,
  label,
  selected,
  onPress,
  onError,
}: {
  url: string;
  label: string;
  selected: boolean;
  onPress: () => void;
  onError: () => void;
}) {
  const { colors, rounded, sizes, opacity } = useTheme();
  return (
    <Pressable
      testID="page-photo"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.cell,
        styles.tile,
        {
          borderRadius: rounded.md,
          backgroundColor: colors.surfaceMuted,
          borderWidth: sizes.focusRing,
          borderColor: selected ? colors.primary : 'transparent',
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <Image source={url} contentFit="cover" cachePolicy="disk" accessible={false} onError={onError} style={StyleSheet.absoluteFill} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  cell: { flex: 1 },
  tile: { aspectRatio: 4 / 3, overflow: 'hidden', borderCurve: 'continuous' },
});
