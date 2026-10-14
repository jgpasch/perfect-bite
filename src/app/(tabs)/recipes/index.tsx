import { Link, router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { useAnimatedReaction, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { prominentButtonTint } from '@/components/appearance';
import { Badge } from '@/components/badge';
import { Button, PrimaryButton } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Toast, type ToastAction } from '@/components/toast';
import { Screen } from '@/components/themed-view';
import { failedImports } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { openList } from '@/features/lists/current-list';
import { getList } from '@/features/lists/lists';
import { useFeature } from '@/features/plans/features';
import { failedImportsQuery } from '@/features/recipes/failed-imports';
import { importedOnRecipesToast, savedRecipeToast, sharedImportsToast } from '@/features/recipes/import-sheet';
import { ImportsCard } from '@/features/recipes/imports-card';
import { promptRecipeName } from '@/features/recipes/prompt-recipe-name';
import { openRecipeLink, recipeLinkUrl } from '@/features/recipes/recipe-link';
import { RecipePhotoTile } from '@/features/recipes/recipe-photo';
import { groupRecipesByHousehold, ingredientCountLabel, onListByRecipe, recipeCardLabel } from '@/features/recipes/recipe-view';
import { RecipeFilterBar } from '@/features/recipes/recipe-filter-bar';
import { setRecipeFilters, useRecipeFilters } from '@/features/recipes/recipe-filter-store';
import {
  activeFilterCount,
  isUntaggedRecipe,
  matchesRecipeFilters,
  noRecipeFilters,
  removeFilterChip,
  untaggedFootnote,
  untaggedOnlyFilters,
} from '@/features/recipes/recipe-filters';
import { NO_RECIPES_MATCH, recipeSearchPlaceholder, searchRecipes } from '@/features/recipes/recipe-search';
import {
  deleteRecipe,
  recipeIngredientNamesQuery,
  RECIPES_TAB_TABLES,
  recipesOnListsQuery,
  recipesQuery,
  type RecipeSummary,
} from '@/features/recipes/recipes';
import { onSavedRecipeResult, takeSavedRecipeResult } from '@/features/recipes/saved-recipe-result';
import { onShareImports } from '@/features/recipes/share-drain';
import { importsCardHeading, useShareQueueStatus } from '@/features/recipes/share-queue-status';
import { useTheme } from '@/hooks/use-theme';

/** Recipes tab (spec 4.5, board 05): a card per recipe under each household's name. */
export default function RecipesScreen() {
  const { spacing, scheme, colors, sizes } = useTheme();
  const { data } = useLiveQueryOn(recipesQuery(), RECIPES_TAB_TABLES);
  const { data: onLists } = useLiveQueryOn(recipesOnListsQuery(), RECIPES_TAB_TABLES);
  const { data: ingredientNames } = useLiveQueryOn(recipeIngredientNamesQuery(), RECIPES_TAB_TABLES);
  const { data: failed } = useLiveQueryOn(failedImportsQuery(), [failedImports]);
  const queue = useShareQueueStatus();
  const showImports = importsCardHeading(failed.length, queue) !== null;
  const [toast, setToast] = useState<{
    key: string;
    message: string;
    emphasis?: string;
    actions: ToastAction[];
    /** The recipe the toast is about, outlined while it shows. */
    recipeId?: string;
  } | null>(
    null,
  );
  const dismissToast = useCallback(() => setToast(null), []);
  // Spec 4.14: kept only while the screen is mounted, never saved.
  const [query, setQuery] = useState('');
  const searching = query.trim() !== '';
  // Spec 4.14: kept for the app session, AND with the search.
  const filters = useRecipeFilters();
  const filtering = activeFilterCount(filters) > 0;
  const searched = useMemo(() => searchRecipes(data, ingredientNames, query), [data, ingredientNames, query]);
  // A household with no matches has no group, so it's hidden.
  const groups = useMemo(
    () =>
      groupRecipesByHousehold(
        searched
          .filter(({ recipe }) => matchesRecipeFilters(recipe, filters))
          .map(({ recipe, ingredientMatch }) => ({ ...recipe, ingredientMatch })),
      ),
    [searched, filters],
  );
  // Recipes the search found that tag filters hide for having no tags (none with Untagged on).
  const untaggedHidden =
    filtering && !filters.untagged ? searched.filter(({ recipe }) => isUntaggedRecipe(recipe)).length : 0;
  const onList = useMemo(() => onListByRecipe(onLists), [onLists]);

  // Spec 4.5: one card's Delete open at a time; opening another or scrolling closes it.
  const openCard = useRef<SwipeableMethods | null>(null);
  const cardOpened = useCallback((card: SwipeableMethods) => {
    if (openCard.current !== card) openCard.current?.close();
    openCard.current = card;
  }, []);
  const cardClosed = useCallback((card: SwipeableMethods) => {
    if (openCard.current === card) openCard.current = null;
  }, []);
  const closeOpenCard = useCallback(() => openCard.current?.close(), []);

  // Spec 4.5: one Add recipe sheet names a blank recipe or, with import, takes a link.
  const addRecipe = () => router.push('/add-recipe');
  const importFromLink = () => router.push({ pathname: '/add-recipe', params: { focus: 'link' } });
  // The sheet counts with the search, so it gets the text; it isn't kept anywhere.
  const openFilters = () => router.push({ pathname: '/recipes/filter', params: { q: query } });
  // Spec 4.12: recipe import is a plus feature; without it the empty state has no Import from link.
  const canImport = useFeature('recipe_import');
  const empty = (
    <EmptyState
      message="No recipes yet."
      action={
        <View style={{ gap: spacing.sm }}>
          <PrimaryButton label="New recipe" onPress={addRecipe} />
          {canImport ? <Button label="Import from link" variant="plain" onPress={importFromLink} /> : null}
        </View>
      }
    />
  );

  // A recipe saved without a list from the import sheet (spec 4.10): taken on focus, and while showing.
  useFocusEffect(
    useCallback(() => {
      const show = () => {
        const result = takeSavedRecipeResult();
        if (!result) return;
        setToast({
          key: `saved-${result.recipeId}-${Date.now()}`,
          recipeId: result.recipeId,
          ...savedRecipeToast(result.recipeName, result.created),
          actions: [
            ...(result.created ? [{ label: 'Undo', onPress: () => (result.undo(), setToast(null)) }] : []),
            {
              label: 'View recipe',
              onPress: () => (setToast(null), router.push({ pathname: '/recipe/[id]', params: { id: result.recipeId } })),
            },
          ],
        });
      };
      show();
      return onSavedRecipeResult(show);
    }, []),
  );

  // Recipes shared to the extension (spec 4.10), when the drain finishes while this tab shows.
  useFocusEffect(
    useCallback(
      () =>
        onShareImports((imported) => {
          if (imported.length > 1) {
            setToast({ key: `shared-${Date.now()}`, ...sharedImportsToast(imported.length), actions: [] });
            return;
          }
          const [result] = imported;
          const viewRecipe = {
            label: 'View recipe',
            onPress: () => (setToast(null), router.push({ pathname: '/recipe/[id]', params: { id: result.recipeId } })),
          };
          if (result.listId === null) {
            // Recipe-only: saved, or already here; Undo only takes back a recipe this share created.
            setToast({
              key: `shared-${result.recipeId}-${Date.now()}`,
              recipeId: result.recipeId,
              ...savedRecipeToast(result.recipeName, result.created),
              actions: [
                ...(result.created ? [{ label: 'Undo', onPress: () => (result.undo(), setToast(null)) }] : []),
                viewRecipe,
              ],
            });
            return;
          }
          const listId = result.listId;
          setToast({
            key: `shared-${result.recipeId}-${Date.now()}`,
            recipeId: result.recipeId,
            ...importedOnRecipesToast(result.recipeName, result.added, getList(listId)?.name ?? null),
            actions: [
              { label: 'Undo', onPress: () => (result.undo(), setToast(null)) },
              {
                label: 'Open list',
                onPress: () => (setToast(null), openList(listId)),
              },
            ],
          });
        }),
      [],
    ),
  );

  return (
    <Screen>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="plus"
          variant="prominent"
          tintColor={prominentButtonTint(scheme, colors)}
          accessibilityLabel="Add recipe"
          onPress={addRecipe}
        />
      </Stack.Toolbar>
      {data.length > 0 ? (
        <Stack.SearchBar
          placeholder={recipeSearchPlaceholder(data.length)}
          hideWhenScrolling={false}
          // Results update live under the field, so they aren't dimmed while it has focus.
          obscureBackground={false}
          autoCapitalize="none"
          onChangeText={(e) => setQuery(e.nativeEvent.text)}
          onCancelButtonPress={() => setQuery('')}
        />
      ) : null}
      {data.length === 0 && !showImports ? (
        empty
      ) : (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          onScrollBeginDrag={closeOpenCard}
          contentContainerStyle={[styles.grow, { paddingBottom: spacing.xl }]}>
          {/* Spec 4.10: shares importing, waiting or that won't import, at the top. */}
          {showImports ? (
            <View style={{ paddingTop: spacing.xs }}>
              <ImportsCard failed={failed} queue={queue} />
            </View>
          ) : null}
          {data.length === 0 ? empty : null}
          {data.length > 0 ? (
            <RecipeFilterBar
              filters={filters}
              onOpen={openFilters}
              onRemove={(chip) => setRecipeFilters(removeFilterChip(filters, chip))}
            />
          ) : null}
          {data.length > 0 && (searching || filtering) && groups.length === 0 ? (
            <View style={{ alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.xl }}>
              <ThemedText variant="callout" color="inkSecondary" style={styles.center}>
                {NO_RECIPES_MATCH}
              </ThemedText>
              {filtering ? (
                <Button label="Clear filters" variant="plain" onPress={() => setRecipeFilters(noRecipeFilters())} />
              ) : null}
            </View>
          ) : null}
          {groups.map((group, i) => (
            <View key={group.householdId}>
              <ThemedText
                variant="sectionLabel"
                color="inkSecondary"
                accessibilityRole="header"
                style={{
                  paddingHorizontal: spacing.lg + spacing.xs,
                  paddingTop: i === 0 ? spacing.xs : spacing.lg + spacing.xxs,
                  paddingBottom: spacing.sm,
                }}>
                {group.name}
              </ThemedText>
              <View style={{ gap: spacing.sm + spacing.xxs, paddingHorizontal: spacing.lg }}>
                {group.recipes.map((r) => (
                  <RecipeCard
                    key={r.id}
                    recipe={r}
                    ingredientMatch={r.ingredientMatch}
                    onList={onList.get(r.id) ?? null}
                    highlighted={toast?.recipeId === r.id}
                    onSwipeOpen={cardOpened}
                    onSwipeClose={cardClosed}
                  />
                ))}
              </View>
            </View>
          ))}
          {untaggedHidden > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityHint="Clears the filters and shows only recipes without tags."
              onPress={() => setRecipeFilters(untaggedOnlyFilters())}
              style={{ justifyContent: 'center', minHeight: sizes.minTapTarget, paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
              <ThemedText variant="footnote" color="inkSecondary" style={styles.center}>
                {untaggedFootnote(untaggedHidden)}
              </ThemedText>
            </Pressable>
          ) : null}
        </ScrollView>
      )}
      {toast ? (
        // Above the tab bar: the bottom safe area here includes it.
        <SafeAreaView edges={['bottom']} pointerEvents="box-none" style={[styles.toast, { paddingBottom: spacing.sm }]}>
          <Toast key={toast.key} message={toast.message} emphasis={toast.emphasis} actions={toast.actions} onDismiss={dismissToast} />
        </SafeAreaView>
      ) : null}
    </Screen>
  );
}

function RecipeCard({
  recipe,
  ingredientMatch,
  onList,
  highlighted,
  onSwipeOpen,
  onSwipeClose,
}: {
  recipe: RecipeSummary;
  /** Search matched it only through this ingredient (spec 4.14): "Has …" in place of the count. */
  ingredientMatch: string | null;
  onList: string | null;
  /** Just imported: outlined in `primary` while the toast shows. */
  highlighted: boolean;
  /** Its swipe opened or closed, so the screen keeps only one card open. */
  onSwipeOpen: (card: SwipeableMethods) => void;
  onSwipeClose: (card: SwipeableMethods) => void;
}) {
  const { colors, spacing, sizes, rounded } = useTheme();
  const swipeable = useRef<SwipeableMethods>(null);
  const [width, setWidth] = useState(0);
  // Dragged past FULL_SWIPE of the card: letting go asks to delete, rather than leaving Delete showing.
  const fullSwipe = useRef(false);
  const setFullSwipe = useCallback((full: boolean) => (fullSwipe.current = full), []);
  // Only a link that opens (spec 4.5); plain text in the link field gets no Visit recipe on web.
  const link = recipeLinkUrl(recipe.sourceUrl) ? recipe.sourceUrl : null;

  // The menu's Delete, the swipe's and VoiceOver's; Cancel closes a swiped card.
  const confirmDelete = () =>
    Alert.alert(`Delete “${recipe.name}”?`, 'Items already on your lists stay there.', [
      { text: 'Cancel', style: 'cancel', onPress: () => swipeable.current?.close() },
      { text: 'Delete', style: 'destructive', onPress: () => deleteRecipe(recipe.id) },
    ]);

  const card = (
    <Link href={{ pathname: '/recipe/[id]', params: { id: recipe.id } }} asChild>
      <Link.Trigger>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={recipeCardLabel(recipe.name, recipe.ingredientCount, onList, ingredientMatch)}
          accessibilityActions={[{ name: 'delete', label: 'Delete' }]}
          onAccessibilityAction={({ nativeEvent }) => nativeEvent.actionName === 'delete' && confirmDelete()}>
          {/* Layout lives on a View: Link's trigger replaces the Pressable's style. */}
          <View
            onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
            style={[
              styles.card,
              {
                padding: spacing.md + spacing.xxs,
                gap: spacing.md + spacing.xxs,
                borderRadius: rounded.card,
                backgroundColor: colors.surface,
                borderWidth: sizes.focusRing,
                borderColor: highlighted ? colors.primary : 'transparent',
              },
            ]}>
            <RecipePhotoTile recipeId={recipe.id} imageUrl={recipe.imageUrl} />
            <View style={styles.flex}>
              <ThemedText variant="headline" numberOfLines={2}>
                {recipe.name}
              </ThemedText>
              {ingredientMatch ? (
                <ThemedText variant="footnote" color="inkSecondary">
                  Has{' '}
                  <ThemedText variant="footnote" color="inkSecondary" style={styles.match}>
                    {ingredientMatch}
                  </ThemedText>
                </ThemedText>
              ) : (
                <ThemedText variant="footnote" color="inkSecondary">
                  {ingredientCountLabel(recipe.ingredientCount)}
                </ThemedText>
              )}
            </View>
            {onList ? (
              // Badge pins itself to the top; the wrapper centres it in the row.
              <View>
                <Badge label={`On ${onList}`} />
              </View>
            ) : null}
          </View>
        </Pressable>
      </Link.Trigger>
      <Link.Menu>
        {/* The recipe screen's Add to a list sheet (spec 4.5); left out, as that button is disabled, with no ingredients. */}
        {recipe.ingredientCount > 0 ? (
          <Link.MenuAction
            title="Add to a list"
            icon="cart"
            onPress={() => router.push({ pathname: '/recipe/[id]/add-to-list', params: { id: recipe.id } })}
          />
        ) : null}
        {link ? <Link.MenuAction title="Visit recipe on web" icon="safari" onPress={() => void openRecipeLink(link)} /> : null}
        <Link.MenuAction title="Rename" icon="pencil" onPress={() => promptRecipeName(recipe.id, recipe.name)} />
        <Link.MenuAction title="Delete" icon="trash" destructive onPress={confirmDelete} />
      </Link.Menu>
    </Link>
  );

  return (
    <ReanimatedSwipeable
      ref={swipeable}
      // Follows the finger like a list row; a short swipe leaves Delete showing, a full one asks at once.
      friction={1}
      overshootLeft={false}
      containerStyle={{ borderRadius: rounded.card, borderCurve: 'continuous' }}
      onSwipeableWillOpen={() => {
        if (swipeable.current) onSwipeOpen(swipeable.current);
        if (fullSwipe.current) confirmDelete();
      }}
      onSwipeableClose={() => swipeable.current && onSwipeClose(swipeable.current)}
      renderRightActions={(_progress, translation) => (
        <DeleteAction
          translation={translation}
          fullAt={width > 0 ? width * FULL_SWIPE : Infinity}
          onFull={setFullSwipe}
          onPress={confirmDelete}
        />
      )}>
      {card}
    </ReanimatedSwipeable>
  );
}

/** How far across the card a swipe goes before letting go asks to delete it. */
const FULL_SWIPE = 0.6;

/** The `danger` Delete behind a swiped card: it widens as the card overshoots, and says when a swipe is full. */
function DeleteAction({
  translation,
  fullAt,
  onFull,
  onPress,
}: {
  translation: SharedValue<number>;
  fullAt: number;
  onFull: (full: boolean) => void;
  onPress: () => void;
}) {
  const { colors, spacing, opacity } = useTheme();
  useAnimatedReaction(
    () => translation.get() <= -fullAt,
    (full, was) => {
      if (full !== was) scheduleOnRN(onFull, full);
    },
    [fullAt, onFull],
  );
  const fill = useAnimatedStyle(() => ({ width: Math.max(0, -translation.get()) }));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Delete"
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        { backgroundColor: colors.danger, paddingHorizontal: spacing.xl, opacity: pressed ? opacity.pressed : 1 },
      ]}>
      <Animated.View pointerEvents="none" style={[styles.fill, { backgroundColor: colors.danger }, fill]} />
      <Icon name="trash" color="onPrimary" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  match: { fontWeight: '700' },
  center: { textAlign: 'center' },
  grow: { flexGrow: 1 },
  toast: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  card: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
  action: { alignItems: 'center', justifyContent: 'center' },
  fill: { position: 'absolute', top: 0, bottom: 0, right: 0 },
});
