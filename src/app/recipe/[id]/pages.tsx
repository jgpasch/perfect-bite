import { Button as SwiftButton, Host, Menu, RNHostView } from '@expo/ui/swift-ui';
import { accessibilityLabel } from '@expo/ui/swift-ui/modifiers';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { recipes } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { deleteRecipePages, shareRecipePage } from '@/features/recipes/recipe-pages';
import { useRecipePage } from '@/features/recipes/recipe-photo-source';
import { recipeQuery } from '@/features/recipes/recipes';
import { useOnline } from '@/hooks/use-online';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

// Pinching or double-tapping zooms a page up to this.
const MAX_ZOOM = 4;
const DOUBLE_TAP_MS = 300;

/**
 * A photo import's original pages (spec 4.5, board B), full screen on `photoViewer.background`: ✕ (Done),
 * the recipe's name over "Page 1 of 2", and ⋯ (Share page, Delete pages) in a top bar; the pages in a
 * horizontal paging scroll, each fitted to the screen and zoomable; dots under them when there's more than one.
 */
export default function RecipePagesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useT();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { spacing, sizes, rounded, opacity, photoViewer } = useTheme();
  const { data: rows } = useLiveQueryOn(recipeQuery(id), [recipes], [id]);
  const recipe = rows[0];
  const pages = recipe?.sourcePages ?? [];
  const [index, setIndex] = useState(0);
  const current = Math.min(index, Math.max(pages.length - 1, 0));

  const share = async () => {
    const path = pages[current];
    if (path && !(await shareRecipePage(path))) Alert.alert(t('recipes.pages.shareFailed'));
  };

  const confirmDelete = () =>
    Alert.alert(t('recipes.pages.deleteTitle'), t('recipes.pages.deleteMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          deleteRecipePages(id);
          router.back();
        },
      },
    ]);

  const roundButton = { width: sizes.minTapTarget, height: sizes.minTapTarget, borderRadius: rounded.full, backgroundColor: photoViewer.button };

  return (
    <View testID="recipe-pages" style={[styles.flex, { backgroundColor: photoViewer.background }]} onAccessibilityEscape={() => router.back()}>
      <View
        style={[
          styles.row,
          { gap: spacing.md, paddingTop: insets.top + spacing.xs, paddingBottom: spacing.md, paddingHorizontal: spacing.lg },
        ]}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel={t('recipes.pages.done')}
          style={({ pressed }) => [styles.center, roundButton, { opacity: pressed ? opacity.pressed : 1 }]}>
          <Icon name="xmark" tint={photoViewer.text} weight="semibold" />
        </Pressable>
        <View style={styles.title}>
          <ThemedText variant="headline" accessibilityRole="header" numberOfLines={1} style={[styles.centred, { color: photoViewer.text }]}>
            {recipe?.name ?? ''}
          </ThemedText>
          {pages.length > 0 ? (
            <ThemedText variant="footnote" style={[styles.centred, { color: photoViewer.textSecondary }]}>
              {t('recipes.pages.pageOf', { page: current + 1, count: pages.length })}
            </ThemedText>
          ) : null}
        </View>
        <Host matchContents colorScheme="dark">
          <Menu
            label={
              <RNHostView matchContents>
                <View style={[styles.center, roundButton]}>
                  <Icon name="ellipsis" tint={photoViewer.text} weight="bold" />
                </View>
              </RNHostView>
            }
            modifiers={[accessibilityLabel(t('recipes.pages.more'))]}>
            <SwiftButton label={t('recipes.pages.share')} systemImage="square.and.arrow.up" onPress={() => void share()} />
            <SwiftButton label={t('recipes.pages.delete')} systemImage="trash" role="destructive" onPress={confirmDelete} />
          </Menu>
        </Host>
      </View>

      <ScrollView
        testID="recipe-pages-pager"
        horizontal
        pagingEnabled
        style={styles.flex}
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / width))}>
        {pages.map((path, i) => (
          <PageView key={path} path={path} width={width} label={t('recipes.pages.pageOf', { page: i + 1, count: pages.length })} />
        ))}
      </ScrollView>

      <View style={[styles.dots, { gap: spacing.sm, paddingTop: spacing.lg, paddingBottom: insets.bottom + spacing.lg }]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants">
        {pages.length > 1
          ? pages.map((path, i) => (
              <View
                key={path}
                testID={i === current ? 'page-dot-current' : 'page-dot'}
                style={{
                  width: spacing.sm,
                  height: spacing.sm,
                  borderRadius: rounded.full,
                  backgroundColor: i === current ? photoViewer.dot : photoViewer.dotInactive,
                }}
              />
            ))
          : null}
      </View>
    </View>
  );
}

/**
 * One page, fitted to the screen in its own zooming scroll view (pinch, or double-tap, up to 4×). VoiceOver
 * reads it as "Page 1 of 2". A page that can't load says so in its place ("Needs a connection" offline).
 */
function PageView({ path, width, label }: { path: string; width: number; label: string }) {
  const t = useT();
  const { spacing, photoViewer } = useTheme();
  const online = useOnline();
  const page = useRecipePage(path);
  const zoom = useRef<ScrollView>(null);
  const zoomScale = useRef(1);
  const size = useRef({ width, height: 0 });
  const lastTap = useRef(0);

  // A second tap within `DOUBLE_TAP_MS` zooms in on the tapped point, or back out when zoomed.
  const tap = (e: GestureResponderEvent) => {
    const now = Date.now();
    if (now - lastTap.current > DOUBLE_TAP_MS) {
      lastTap.current = now;
      return;
    }
    lastTap.current = 0;
    const { width: w, height: h } = size.current;
    const rect =
      zoomScale.current > 1.01
        ? { x: 0, y: 0, width: w, height: h }
        : { x: e.nativeEvent.locationX - w / 4, y: e.nativeEvent.locationY - h / 4, width: w / 2, height: h / 2 };
    zoom.current?.getScrollResponder().scrollResponderZoomTo({ ...rect, animated: true });
  };

  return (
    <ScrollView
      ref={zoom}
      testID="recipe-page"
      style={{ width }}
      contentContainerStyle={styles.flex}
      minimumZoomScale={1}
      maximumZoomScale={MAX_ZOOM}
      bouncesZoom
      centerContent
      onLayout={(e) => (size.current = e.nativeEvent.layout)}
      onScroll={(e) => (zoomScale.current = e.nativeEvent.zoomScale ?? 1)}
      scrollEventThrottle={16}
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={label}
        onStartShouldSetResponder={() => true}
        onResponderRelease={tap}
        style={[styles.flex, styles.center]}>
        {page.source ? (
          <Image
            source={page.source}
            contentFit="contain"
            cachePolicy="disk"
            accessible={false}
            onError={page.onError}
            style={StyleSheet.absoluteFill}
          />
        ) : (
          <ThemedText variant="callout" style={{ color: photoViewer.textSecondary, paddingHorizontal: spacing.xl, textAlign: 'center' }}>
            {online ? t('recipes.pages.loadFailed') : t('recipes.pages.needsConnection')}
          </ThemedText>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, alignItems: 'center' },
  centred: { textAlign: 'center' },
  dots: { flexDirection: 'row', justifyContent: 'center' },
});
