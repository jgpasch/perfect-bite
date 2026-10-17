import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { SoftDangerButton } from '@/components/button';
import { Card } from '@/components/card';
import { SettingsRow } from '@/components/settings-group';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { pickRecipePhoto, uploadRecipePhoto, type PhotoSource } from '@/features/recipes/photo-upload';
import { recipeLinkUrl } from '@/features/recipes/recipe-link';
import type { RecipePhotoFields } from '@/features/recipes/recipe-photo-source';
import {
  chooseRecipePhoto,
  loadPagePhotos,
  pagePhoto,
  photoAfterRemove,
  type PagePhotosResult,
} from '@/features/recipes/recipe-photos';
import { getRecipe } from '@/features/recipes/recipes';
import { knownOffline } from '@/features/recipes/suggest-tags';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/** Placeholder tiles while the page's photos load: two rows. */
const PLACEHOLDERS = 4;

/**
 * The Choose a photo sheet (spec 4.5), from the recipe screen's Add photo tile or Change photo….
 * **From the page**, only when the recipe's link opens: the page's photos (`recipe-photos`, up to
 * 12) in a two-column grid of 4:3 tiles, the current photo outlined in `primary`; picking one sets
 * it (and drops an own photo) and closes the sheet, and the recipe screen shows "Photo updated" with
 * Undo. **Photo library** and **Take photo** pick a photo, close the sheet and upload it as the
 * household's own (`photo-upload.ts`); offline they're disabled, "Needs a connection". **Remove
 * photo** when there is one: the own photo if set (the site's comes back), else the site's. A page
 * photo that fails to load is left out of the grid.
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

  // Photo library and Take photo upload, so they need a connection; null until known.
  const [offline, setOffline] = useState<boolean | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!link) return;
    let live = true;
    void loadPagePhotos(link).then((r) => live && setResult(r));
    return () => {
      live = false;
    };
  }, [link]);

  useEffect(() => {
    let live = true;
    void knownOffline().then((off) => live && setOffline(off));
    return () => {
      live = false;
    };
  }, []);

  if (!recipe) return <Screen />;

  const current = { imageUrl: recipe.imageUrl, photoPath: recipe.photoPath, photoCredit: recipe.photoCredit };
  const choose = (next: RecipePhotoFields) => {
    chooseRecipePhoto(recipe.id, current, next);
    router.back();
  };
  // Picks, then closes the sheet while it uploads; the recipe screen shows it with a spinner.
  const pick = async (from: PhotoSource) => {
    if (picking) return;
    setPicking(true);
    try {
      const picked = await pickRecipePhoto(from);
      if (picked.ok) {
        void uploadRecipePhoto(recipe.id, picked.uri);
        router.back();
      } else if (picked.reason === 'denied') {
        Alert.alert(t('recipes.photo.cameraDeniedTitle'), t('recipes.photo.cameraDenied'));
      }
    } catch (e) {
      console.warn('[photo] pick failed', e);
    } finally {
      setPicking(false);
    }
  };
  const needsConnection = offline === true ? t('recipes.photo.needsConnection') : undefined;
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
            // An own photo is shown instead of the site's, so no page photo is the current one.
            current={current.photoPath === null ? current.imageUrl : null}
            onPick={(url) => choose(pagePhoto(url))}
            onBroken={(url) => setBroken((prev) => new Set(prev).add(url))}
          />
        </View>
      ) : null}

      <Card>
        <SettingsRow
          label={t('recipes.photo.library')}
          detail={needsConnection}
          icon={{ name: 'photo.on.rectangle', hue: 'blue' }}
          onPress={() => void pick('library')}
          chevron={false}
          disabled={offline !== false || picking}
        />
        <SettingsRow
          label={t('recipes.photo.camera')}
          detail={needsConnection}
          icon={{ name: 'camera', hue: 'teal' }}
          onPress={() => void pick('camera')}
          chevron={false}
          disabled={offline !== false || picking}
          last
        />
      </Card>

      {current.imageUrl !== null || current.photoPath !== null ? (
        <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm }}>
          <SoftDangerButton label={t('recipes.photo.remove')} onPress={() => choose(photoAfterRemove(current))} />
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
