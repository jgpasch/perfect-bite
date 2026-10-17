import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { Button, SoftDangerButton } from '@/components/button';
import { Card } from '@/components/card';
import { SettingsRow } from '@/components/settings-group';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { appendPhotos, photoSearchQuery, searchPhotos, type PhotoSearchFailure } from '@/features/recipes/photo-search';
import { pickRecipePhoto, uploadRecipePhoto, uploadStockPhoto, type PhotoSource } from '@/features/recipes/photo-upload';
import { openRecipeLink, recipeLinkUrl } from '@/features/recipes/recipe-link';
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
import type { PhotoProviderInfo, PhotoSearchResult } from '@/shared/schemas/photo-search';

/** Placeholder tiles while the page's photos or a search load: two rows. */
const PLACEHOLDERS = 4;

/**
 * The Search photos section's state: a search running, its photos so far (`more` is the next
 * page's state), or a failed first page.
 */
type SearchState =
  | { status: 'loading'; query: string }
  | {
      status: 'done';
      query: string;
      /** Who the photos are from, as the first page's answer named it. */
      provider: PhotoProviderInfo;
      photos: PhotoSearchResult[];
      hasMore: boolean;
      page: number;
      more: 'idle' | 'loading' | PhotoSearchFailure;
    }
  | { status: 'failed'; query: string; error: PhotoSearchFailure };

/**
 * The Choose a photo sheet (spec 4.5), from the recipe screen's Add photo tile or Change photo….
 * **From the page**, only when the recipe's link opens: the page's photos (`recipe-photos`, up to
 * 12) in a two-column grid of 4:3 tiles, the current photo outlined in `primary`; picking one sets
 * it (and drops an own photo) and closes the sheet, and the recipe screen shows "Photo updated" with
 * Undo. **Search photos**: free stock photos (`photo-search.ts`; the server picks the provider), searched once on open
 * with the recipe's name and then only on Return, in the same grid with the photographer's name on
 * each tile, **Load more** while there are more pages, and "Photos provided by <provider>"; picking one
 * closes the sheet and uploads it as the household's own photo with its credit (`uploadStockPhoto`).
 * **Photo library** and **Take photo** pick a photo, close the sheet and upload it as the
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

  const [searchText, setSearchText] = useState(() => recipe?.name ?? '');
  // The search on open, with the recipe's name: it starts out loading.
  const [openingQuery] = useState(() => photoSearchQuery(searchText));
  const [search, setSearch] = useState<SearchState | null>(() =>
    openingQuery ? { status: 'loading', query: openingQuery } : null,
  );
  const [brokenSearch, setBrokenSearch] = useState<ReadonlySet<string>>(new Set());
  // Bumped by each new search, so a late answer to an older one is dropped.
  const searchRun = useRef(0);

  /** Asks for the first page of `query` as search `run`, and shows it if that's still the latest. */
  const firstPage = useCallback((query: string, run: number, live: () => boolean = () => true) => {
    void searchPhotos(query, 1).then((r) => {
      if (run !== searchRun.current || !live()) return;
      setSearch(
        r.ok
          ? { status: 'done', query, provider: r.provider, photos: r.photos, hasMore: r.hasMore, page: 1, more: 'idle' }
          : { status: 'failed', query, error: r.error },
      );
    });
  }, []);

  const runSearch = (text: string) => {
    const query = photoSearchQuery(text);
    if (!query) return;
    const run = ++searchRun.current;
    setSearch({ status: 'loading', query });
    setBrokenSearch(new Set());
    firstPage(query, run);
  };

  const loadMore = () => {
    if (search?.status !== 'done' || !search.hasMore || search.more === 'loading') return;
    const run = searchRun.current;
    const page = search.page + 1;
    setSearch({ ...search, more: 'loading' });
    void searchPhotos(search.query, page).then((r) => {
      if (run !== searchRun.current) return;
      setSearch((s) =>
        s?.status !== 'done'
          ? s
          : r.ok
            ? { ...s, photos: appendPhotos(s.photos, r.photos), hasMore: r.hasMore, page, more: 'idle' }
            : { ...s, more: r.error },
      );
    });
  };

  // Searches once on open with the recipe's name; after that, only Return searches.
  useEffect(() => {
    if (!openingQuery) return;
    let live = true;
    firstPage(openingQuery, ++searchRun.current, () => live);
    return () => {
      live = false;
    };
  }, [firstPage, openingQuery]);

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
  // A search result closes the sheet and downloads, shrinks and uploads it with its credit.
  const pickStock = (photo: PhotoSearchResult) => {
    if (picking || search?.status !== 'done') return;
    void uploadStockPhoto(recipe.id, { ...photo, provider: search.provider.name });
    router.back();
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

      <View style={{ gap: spacing.sm }}>
        <ThemedText variant="sectionLabel" color="inkSecondary" accessibilityRole="header" style={inset}>
          {t('recipes.photo.search')}
        </ThemedText>
        <SearchSection
          text={searchText}
          onChangeText={setSearchText}
          onSubmit={() => runSearch(searchText)}
          state={search}
          offline={offline === true || (search?.status === 'failed' && search.error === 'offline')}
          photos={search?.status === 'done' ? search.photos.filter((p) => !brokenSearch.has(p.id)) : []}
          onLoadMore={loadMore}
          onBroken={(photoId) => setBrokenSearch((prev) => new Set(prev).add(photoId))}
          onPick={pickStock}
        />
      </View>

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

/**
 * The Search photos section's body: the search field (disabled offline, "Needs a connection"), then
 * placeholders while searching, a note when there's nothing or it failed, else the grid and Load
 * more while there are more pages; the provider's link last, once a search has answered. `onPick`
 * picks a result.
 */
function SearchSection({
  text,
  onChangeText,
  onSubmit,
  state,
  offline,
  photos,
  onLoadMore,
  onBroken,
  onPick,
}: {
  text: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  state: SearchState | null;
  offline: boolean;
  photos: PhotoSearchResult[];
  onLoadMore: () => void;
  onBroken: (id: string) => void;
  onPick: (photo: PhotoSearchResult) => void;
}) {
  const t = useT();
  const { spacing, opacity } = useTheme();
  const inset = { paddingHorizontal: spacing.lg + spacing.xs };
  const note = (message: string) => (
    <ThemedText variant="callout" color="inkSecondary" style={inset}>
      {message}
    </ThemedText>
  );
  const failure = (error: PhotoSearchFailure) =>
    t(
      error === 'offline'
        ? 'recipes.photo.needsConnection'
        : error === 'rate_limited'
          ? 'recipes.photo.searchRateLimited'
          : 'recipes.photo.searchFailed',
    );

  const provider = state?.status === 'done' ? state.provider : null;
  let body: ReactNode = null;
  if (offline) {
    body = note(t('recipes.photo.needsConnection'));
  } else if (state?.status === 'loading') {
    body = (
      <View accessible accessibilityLabel={t('recipes.photo.searching')} testID="search-placeholders">
        <Grid count={PLACEHOLDERS} render={(i) => <PlaceholderTile key={i} />} />
      </View>
    );
  } else if (state?.status === 'failed') {
    body = note(failure(state.error));
  } else if (state?.status === 'done' && photos.length === 0) {
    body = note(t('recipes.photo.searchNone', { query: state.query }));
  } else if (state?.status === 'done') {
    body = (
      <>
        <Grid
          count={photos.length}
          render={(i) => (
            <SearchTile
              key={photos[i].id}
              photo={photos[i]}
              label={t(photos[i].alt ? 'recipes.photo.searchTileAlt' : 'recipes.photo.searchTile', {
                alt: photos[i].alt ?? '',
                author: photos[i].author,
                index: i + 1,
                count: photos.length,
              })}
              onPress={() => onPick(photos[i])}
              onError={() => onBroken(photos[i].id)}
            />
          )}
        />
        {state.more !== 'idle' && state.more !== 'loading' ? note(failure(state.more)) : null}
        {state.hasMore ? (
          <View style={{ paddingHorizontal: spacing.lg }}>
            <Button
              label={t('recipes.photo.loadMore')}
              onPress={onLoadMore}
              loading={state.more === 'loading'}
              disabled={state.more === 'loading'}
            />
          </View>
        ) : null}
      </>
    );
  }

  return (
    <>
      <View style={{ paddingHorizontal: spacing.lg }}>
        <TextField
          testID="photo-search-field"
          value={text}
          onChangeText={onChangeText}
          onSubmitEditing={onSubmit}
          returnKeyType="search"
          clearButtonMode="while-editing"
          autoCorrect={false}
          placeholder={t('recipes.photo.search')}
          accessibilityLabel={t('recipes.photo.search')}
          accessibilityState={{ disabled: offline }}
          editable={!offline}
          style={offline ? { opacity: opacity.disabled } : undefined}
        />
      </View>
      {body}
      {provider ? (
        <Pressable
          testID="provider-link"
          onPress={() => void openRecipeLink(provider.url)}
          accessibilityRole="link"
          accessibilityLabel={t('recipes.photo.provider', { provider: provider.name })}
          accessibilityHint={t('recipes.photo.providerHint', { provider: provider.name })}
          style={({ pressed }) => [inset, { opacity: pressed ? opacity.pressed : 1 }]}>
          <ThemedText variant="footnote" color="inkSecondary">
            {t('recipes.photo.provider', { provider: provider.name })}
          </ThemedText>
        </Pressable>
      ) : null}
    </>
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

/**
 * A search result at 4:3, radius `md`, the photographer's name on a `surface` chip over its bottom
 * edge. VoiceOver: "Photo by Jane Doe, 3 of 20", led by the provider's description when it has one.
 */
function SearchTile({
  photo,
  label,
  onPress,
  onError,
}: {
  photo: PhotoSearchResult;
  label: string;
  onPress: () => void;
  onError: () => void;
}) {
  const { colors, rounded, spacing, opacity } = useTheme();
  return (
    <Pressable
      testID="search-photo"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.cell,
        styles.tile,
        { borderRadius: rounded.md, backgroundColor: colors.surfaceMuted, opacity: pressed ? opacity.pressed : 1 },
      ]}>
      <Image source={photo.thumb} contentFit="cover" cachePolicy="disk" accessible={false} onError={onError} style={StyleSheet.absoluteFill} />
      <View style={[styles.authorRow, { left: spacing.sm, right: spacing.sm, bottom: spacing.sm }]}>
        <View
          testID="search-photo-author"
          style={[
            styles.authorChip,
            { paddingHorizontal: spacing.sm, paddingVertical: spacing.xxs, borderRadius: rounded.full, backgroundColor: colors.surface },
          ]}>
          <ThemedText variant="caption" color="inkSecondary" numberOfLines={1}>
            {photo.author}
          </ThemedText>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  authorRow: { position: 'absolute', alignItems: 'flex-start' },
  authorChip: { maxWidth: '100%' },
  row: { flexDirection: 'row' },
  cell: { flex: 1 },
  tile: { aspectRatio: 4 / 3, overflow: 'hidden', borderCurve: 'continuous' },
});
