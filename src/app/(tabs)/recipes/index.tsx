import { Link, router, Stack, useFocusEffect, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { useAnimatedReaction, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { hueHeaderBand, listHeaderColors, prominentButtonTint } from '@/components/appearance';
import { Badge } from '@/components/badge';
import { Button, PrimaryButton } from '@/components/button';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { HeaderPill } from '@/components/header-pill';
import { Icon } from '@/components/icon';
import { FoldingSection } from '@/components/section-header';
import { ThemedText } from '@/components/themed-text';
import { Toast, type ToastAction } from '@/components/toast';
import { Screen } from '@/components/themed-view';
import { failedImports, households, listItems, lists, userSettings } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { getAccount } from '@/features/auth/account';
import { categorizePending } from '@/features/categories/categorization';
import { openList, resolveCurrentListId, useCurrentListVersion } from '@/features/lists/current-list';
import { getList, listsWithCountsQuery } from '@/features/lists/lists';
import { useFeature } from '@/features/plans/features';
import { failedImportsQuery } from '@/features/recipes/failed-imports';
import { importedOnRecipesToast, savedRecipeToast, sharedImportsToast } from '@/features/recipes/import-sheet';
import { ImportsCard } from '@/features/recipes/imports-card';
import { promptRecipeName } from '@/features/recipes/prompt-recipe-name';
import { openRecipeLink, recipeLinkUrl } from '@/features/recipes/recipe-link';
import { PhotoSizeToggle } from '@/features/recipes/photo-size-toggle';
import { RecipePhotoCover, RecipePhotoTile } from '@/features/recipes/recipe-photo';
import {
  gridRows,
  readRecipePhotoSize,
  RECIPE_PHOTO_SIZE_KEY,
  recipeGridColumns,
  type RecipePhotoSize,
} from '@/features/recipes/recipe-photo-size';
import { addWholeRecipeToList, undoRecipeAdd } from '@/features/recipes/add-to-list';
import { quickAddList, quickAddTitle, type QuickAddCandidate } from '@/features/recipes/quick-add';
import {
  addedRecipeWithStaplesToast,
  groupRecipesByHousehold,
  onListByRecipe,
  recipeMetaLine,
  recipeRowLabel,
  recipeTimeLabel,
} from '@/features/recipes/recipe-view';
import { useFoldedMealSections, toggleMealSection } from '@/features/recipes/recipe-fold-store';
import { RecipeSortButton } from '@/features/recipes/recipe-sort-button';
import {
  groupRecipesByMeal,
  mealSectionKey,
  mealSectionUnit,
  readRecipeSort,
  RECIPE_SORT_KEY,
  sortRecipes,
  type RecipeSort,
} from '@/features/recipes/recipe-sort';
import { RecipeFilterBar } from '@/features/recipes/recipe-filter-bar';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { setRecipeFilters, useRecipeFilters } from '@/features/recipes/recipe-filter-store';
import {
  activeFilterCount,
  filtersPillAccessibilityLabel,
  filtersPillLabel,
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
import { i18n, useT } from '@/i18n';

/**
 * Recipes tab (spec 4.5): the List tab's green header (title, search, "N recipes" and Filters) over a card of
 * recipe rows per household.
 */
export default function RecipesScreen() {
  const t = useT();
  const { spacing, scheme, colors, sizes, rounded } = useTheme();
  const header = listHeaderColors(colors);
  // Light status bar content on the green header, also while the Filters sheet is up over it.
  const pathname = usePathname();
  const onRecipes = pathname === '/recipes' || pathname === '/recipes/filter';
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
  // Spec 4.5: Recently added, A–Z or By meal, remembered on this device.
  const [sort, setSortState] = useState<RecipeSort>(() => readRecipeSort(getDeviceSetting<unknown>(RECIPE_SORT_KEY, null)));
  const setSort = (next: RecipeSort) => {
    setSortState(next);
    setDeviceSetting(RECIPE_SORT_KEY, next);
  };
  // Spec 4.5: small photos in rows or large ones in a grid, remembered on this device like the sort.
  const [photoSize, setPhotoSizeState] = useState<RecipePhotoSize>(() =>
    readRecipePhotoSize(getDeviceSetting<unknown>(RECIPE_PHOTO_SIZE_KEY, null)),
  );
  const setPhotoSize = (next: RecipePhotoSize) => {
    setPhotoSizeState(next);
    setDeviceSetting(RECIPE_PHOTO_SIZE_KEY, next);
  };
  // One tile per row at the largest accessibility text sizes.
  const columns = recipeGridColumns(useWindowDimensions().fontScale);
  // By meal's folded sections, kept for the app session.
  const folded = useFoldedMealSections();
  // A household with no matches has no group, so it's hidden. Search and filters apply first; households
  // keep their order whatever the sort.
  const groups = useMemo(
    () =>
      groupRecipesByHousehold(
        searched
          .filter(({ recipe }) => matchesRecipeFilters(recipe, filters))
          .map(({ recipe, ingredientMatch }) => ({ ...recipe, ingredientMatch })),
      ).map((group) => ({
        ...group,
        recipes: sortRecipes(group.recipes, sort),
        meals: sort === 'meal' ? groupRecipesByMeal(group.recipes) : [],
      })),
    [searched, filters, sort],
  );
  // Recipes the search found that tag filters hide for having no tags (none with Untagged on).
  const untaggedHidden =
    filtering && !filters.untagged ? searched.filter(({ recipe }) => isUntaggedRecipe(recipe)).length : 0;
  const onList = useMemo(() => onListByRecipe(onLists), [onLists]);

  // Spec 4.5: the card menu's quick add goes to the current list (the List tab's), re-resolved as lists change.
  const { data: allLists } = useLiveQueryOn(listsWithCountsQuery(), [lists, listItems, households, userSettings]);
  const userId = getAccount()?.userId ?? null;
  const listVersion = useCurrentListVersion();
  const currentList = useMemo((): QuickAddCandidate | null => {
    const id = resolveCurrentListId(allLists.filter((l) => l.archivedAt === null), userId);
    return id ? (allLists.find((l) => l.id === id) ?? getList(id) ?? null) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `listVersion`: another screen picked a list
  }, [allLists, userId, listVersion]);

  // Adds at 1× as the add bar does (staples left out) and stays here, with Undo and Open list.
  const quickAdd = (recipeId: string, list: { id: string; name: string }) => {
    const added = addWholeRecipeToList(list.id, recipeId, userId);
    if (!added) return;
    void categorizePending(added.pendingNames);
    const nothingAdded = added.count === 0 && added.skipped.length > 0;
    setToast({
      key: `quick-add-${recipeId}-${Date.now()}`,
      recipeId,
      ...addedRecipeWithStaplesToast(added.recipeName, added.count, added.skipped, list.name),
      actions: [
        ...(nothingAdded ? [] : [{ label: t('common.undo'), onPress: () => (undoRecipeAdd(added), setToast(null)) }]),
        { label: t('recipes.tab.openList'), onPress: () => (setToast(null), openList(list.id)) },
      ],
    });
  };

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
      message={t('recipes.tab.empty')}
      action={
        <View style={{ gap: spacing.sm }}>
          <PrimaryButton label={t('recipes.tab.newRecipe')} onPress={addRecipe} />
          {canImport ? <Button label={t('recipes.tab.importFromLink')} variant="plain" onPress={importFromLink} /> : null}
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
            ...(result.created ? [{ label: t('common.undo'), onPress: () => (result.undo(), setToast(null)) }] : []),
            {
              label: t('common.viewRecipe'),
              onPress: () => (setToast(null), router.push({ pathname: '/recipe/[id]', params: { id: result.recipeId } })),
            },
          ],
        });
      };
      show();
      return onSavedRecipeResult(show);
    }, [t]),
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
            label: t('common.viewRecipe'),
            onPress: () => (setToast(null), router.push({ pathname: '/recipe/[id]', params: { id: result.recipeId } })),
          };
          if (result.listId === null) {
            // Recipe-only: saved, or already here; Undo only takes back a recipe this share created.
            setToast({
              key: `shared-${result.recipeId}-${Date.now()}`,
              recipeId: result.recipeId,
              ...savedRecipeToast(result.recipeName, result.created),
              actions: [
                ...(result.created ? [{ label: t('common.undo'), onPress: () => (result.undo(), setToast(null)) }] : []),
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
              { label: t('common.undo'), onPress: () => (result.undo(), setToast(null)) },
              {
                label: t('recipes.tab.openList'),
                onPress: () => (setToast(null), openList(listId)),
              },
            ],
          });
        }),
      [t],
    ),
  );

  // Spec 4.5: household names only tell recipes apart when there's more than one household.
  const labelHouseholds = new Set(data.map((r) => r.householdId)).size > 1;

  // A card's recipe rows, separated by hairlines.
  const renderRows = (rows: readonly (RecipeSummary & { ingredientMatch: string | null })[]) =>
    rows.map((r, j) => (
      <View key={r.id}>
        {j > 0 ? (
          <View
            style={{
              height: StyleSheet.hairlineWidth,
              marginLeft: spacing.lg + sizes.recipeTile + spacing.md,
              backgroundColor: colors.border,
            }}
          />
        ) : null}
        <RecipeRow
          recipe={r}
          ingredientMatch={r.ingredientMatch}
          onList={onList.get(r.id) ?? null}
          highlighted={toast?.recipeId === r.id}
          quickAddTo={quickAddList(currentList, r)}
          onQuickAdd={quickAdd}
          onSwipeOpen={cardOpened}
          onSwipeClose={cardClosed}
        />
      </View>
    ));

  // Large photos: the same recipes as tiles, two per row (one at the largest text sizes), 14 pt in and 12 apart.
  const renderGrid = (tiles: readonly (RecipeSummary & { ingredientMatch: string | null })[]) => (
    <View testID="recipe-grid" style={{ padding: spacing.md + spacing.xxs, gap: spacing.md }}>
      {gridRows(tiles, columns).map((row) => (
        <View key={row[0].id} testID="recipe-grid-row" style={[styles.gridRow, { gap: spacing.md }]}>
          {row.map((r) => (
            <View key={r.id} testID="recipe-grid-cell" style={styles.flex}>
              <RecipeTile
                recipe={r}
                ingredientMatch={r.ingredientMatch}
                onList={onList.get(r.id) ?? null}
                highlighted={toast?.recipeId === r.id}
                quickAddTo={quickAddList(currentList, r)}
                onQuickAdd={quickAdd}
              />
            </View>
          ))}
          {/* A short last row keeps its tiles at the column width. */}
          {Array.from({ length: columns - row.length }, (_, k) => (
            <View key={`gap-${k}`} testID="recipe-grid-cell" style={styles.flex} />
          ))}
        </View>
      ))}
    </View>
  );
  const renderRecipes = (recipes: readonly (RecipeSummary & { ingredientMatch: string | null })[]) =>
    photoSize === 'large' ? renderGrid(recipes) : renderRows(recipes);

  return (
    <Screen>
      {onRecipes ? <StatusBar style="light" /> : null}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="plus"
          variant="prominent"
          tintColor={prominentButtonTint(scheme, colors)}
          accessibilityLabel={t('recipes.tab.addRecipe')}
          onPress={addRecipe}
        />
      </Stack.Toolbar>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        onScrollBeginDrag={closeOpenCard}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.grow, { paddingBottom: spacing.xl }]}>
        <View style={{ backgroundColor: header.ground }}>
          {/* Pulling down past the top shows more green, not the tab's ground. */}
          <View style={[styles.overscroll, { backgroundColor: header.ground }]} />
          <View style={{ gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.xs, paddingBottom: spacing.md }}>
            <ThemedText variant="largeTitle" color="onHeader" accessibilityRole="header" style={{ paddingHorizontal: spacing.xs }}>
              {t('recipes.tab.title')}
            </ThemedText>
            {data.length > 0 ? (
              <>
                <RecipeSearchField count={data.length} query={query} onChange={setQuery} />
                <View style={[styles.headerRow, { gap: spacing.md, paddingHorizontal: spacing.xs }]}>
                  <ThemedText variant="amount" color="onHeaderSecondary">
                    {t('recipes.tab.count', { count: data.length })}
                  </ThemedText>
                  <View style={[styles.headerPills, { gap: spacing.sm }]}>
                    <HeaderPill
                      label={filtersPillLabel(activeFilterCount(filters))}
                      accessibilityLabel={filtersPillAccessibilityLabel(activeFilterCount(filters))}
                      accessibilityHint={t('recipes.filters.pillHint')}
                      selected={filtering}
                      onPress={openFilters}
                    />
                    <RecipeSortButton value={sort} onChange={setSort} />
                    <PhotoSizeToggle value={photoSize} onChange={setPhotoSize} />
                  </View>
                </View>
              </>
            ) : null}
          </View>
          <View style={{ height: rounded.card }} />
        </View>
        {/* The tab's ground: rounded top corners over the bottom of the green. */}
        <View
          style={[
            styles.sheetTop,
            {
              height: rounded.card,
              marginTop: -rounded.card,
              borderTopLeftRadius: rounded.card,
              borderTopRightRadius: rounded.card,
              backgroundColor: colors.background,
            },
          ]}
        />
        {/* Spec 4.10: shares importing, waiting or that won't import, at the top. */}
        {showImports ? <ImportsCard failed={failed} queue={queue} /> : null}
        {data.length === 0 ? empty : null}
        {data.length > 0 ? (
          <RecipeFilterBar filters={filters} onRemove={(chip) => setRecipeFilters(removeFilterChip(filters, chip))} />
        ) : null}
        {data.length > 0 && (searching || filtering) && groups.length === 0 ? (
          <View style={{ alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.xl }}>
            <ThemedText variant="callout" color="inkSecondary" style={styles.center}>
              {NO_RECIPES_MATCH}
            </ThemedText>
            {filtering ? (
              <Button label={t('recipes.filters.clearFilters')} variant="plain" onPress={() => setRecipeFilters(noRecipeFilters())} />
            ) : null}
          </View>
        ) : null}
        {groups.map((group, i) => (
          <View key={group.householdId} style={{ paddingTop: i === 0 ? spacing.xs : spacing.lg + spacing.xxs }}>
            {labelHouseholds ? (
              <ThemedText
                variant="sectionLabel"
                color="inkSecondary"
                accessibilityRole="header"
                style={{ paddingHorizontal: spacing.lg + spacing.xs, paddingBottom: spacing.sm }}>
                {group.name}
              </ThemedText>
            ) : null}
            {sort === 'meal' ? (
              // Spec 4.5: a folding card per meal, its header tinted in the meal's hue.
              <View style={{ gap: spacing.md, paddingHorizontal: spacing.lg }}>
                {group.meals.map((section) => {
                  const key = mealSectionKey(group.householdId, section.meal);
                  return (
                    <Card key={key}>
                      <FoldingSection
                        title={section.title}
                        band={hueHeaderBand(section.hue, scheme)}
                        count={section.recipes.length}
                        countUnit={mealSectionUnit()}
                        collapsed={folded.has(key)}
                        onToggle={() => toggleMealSection(key)}>
                        {renderRecipes(section.recipes)}
                      </FoldingSection>
                    </Card>
                  );
                })}
              </View>
            ) : (
              <View style={{ paddingHorizontal: spacing.lg }}>
                <Card>{renderRecipes(group.recipes)}</Card>
              </View>
            )}
          </View>
        ))}
        {untaggedHidden > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityHint={t('recipes.tab.untaggedHint')}
            onPress={() => setRecipeFilters(untaggedOnlyFilters())}
            style={{ justifyContent: 'center', minHeight: sizes.minTapTarget, paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
            <ThemedText variant="footnote" color="inkSecondary" style={styles.center}>
              {untaggedFootnote(untaggedHidden)}
            </ThemedText>
          </Pressable>
        ) : null}
      </ScrollView>
      {toast ? (
        // Above the tab bar: the bottom safe area here includes it.
        <SafeAreaView edges={['bottom']} pointerEvents="box-none" style={[styles.toast, { paddingBottom: spacing.sm }]}>
          <Toast key={toast.key} message={toast.message} emphasis={toast.emphasis} actions={toast.actions} onDismiss={dismissToast} />
        </SafeAreaView>
      ) : null}
    </Screen>
  );
}

/**
 * The search field on the green header (spec 4.14): "Search 52 recipes" in a white wash, results updating
 * live under it. Kept only while the screen is mounted.
 */
function RecipeSearchField({ count, query, onChange }: { count: number; query: string; onChange: (text: string) => void }) {
  const t = useT();
  const { colors, typography, spacing, sizes, rounded } = useTheme();
  return (
    <View
      style={[
        styles.search,
        {
          minHeight: sizes.minTapTarget,
          gap: spacing.sm,
          paddingHorizontal: spacing.md,
          borderRadius: rounded.md,
          backgroundColor: listHeaderColors(colors).viewButton.fill,
        },
      ]}>
      <Icon name="magnifyingglass" color="onHeaderSecondary" />
      <TextInput
        value={query}
        onChangeText={onChange}
        placeholder={recipeSearchPlaceholder(count)}
        placeholderTextColor={colors.onHeaderSecondary}
        selectionColor={colors.onHeader}
        accessibilityLabel={t('recipes.tab.searchLabel')}
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
        style={[typography.body, styles.flex, { color: colors.onHeader, paddingVertical: spacing.sm + spacing.xxs }]}
      />
      {query ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('recipes.tab.clearSearch')}
          hitSlop={spacing.md}
          onPress={() => onChange('')}>
          <Icon name="xmark.circle.fill" color="onHeaderSecondary" />
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * A recipe's row in its household's card (spec 4.5): the photo tile, the name on one line, and under it the
 * meta line ("Dinner · 35 min"), or "Has …" when a search matched only an ingredient.
 */
function RecipeRow({
  recipe,
  ingredientMatch,
  onList,
  highlighted,
  quickAddTo,
  onQuickAdd,
  onSwipeOpen,
  onSwipeClose,
}: {
  recipe: RecipeSummary;
  /** Search matched it only through this ingredient (spec 4.14): "Has …" in place of the meta line. */
  ingredientMatch: string | null;
  onList: string | null;
  /** Just imported: outlined in `primary` while the toast shows. */
  highlighted: boolean;
  /** The list the menu's Add to <list> adds to (`quickAddList`), or null to leave it out. */
  quickAddTo: { id: string; name: string } | null;
  onQuickAdd: (recipeId: string, list: { id: string; name: string }) => void;

  /** Its swipe opened or closed, so the screen keeps only one card open. */
  onSwipeOpen: (card: SwipeableMethods) => void;
  onSwipeClose: (card: SwipeableMethods) => void;
}) {
  const t = useT();
  const { colors, spacing, sizes, rounded } = useTheme();
  const swipeable = useRef<SwipeableMethods>(null);
  const [width, setWidth] = useState(0);
  // Dragged past FULL_SWIPE of the card: letting go asks to delete, rather than leaving Delete showing.
  const fullSwipe = useRef(false);
  const setFullSwipe = useCallback((full: boolean) => (fullSwipe.current = full), []);
  const meta = recipeMetaLine(recipe);

  // The menu's Delete, the swipe's and VoiceOver's; Cancel closes a swiped card.
  const confirmDelete = () => confirmDeleteRecipe(recipe, () => swipeable.current?.close());

  // eslint-disable-next-line react-hooks/refs -- `confirmDelete` reads the ref only when pressed, not during render
  const card = recipeLink({
    recipe,
    onList,
    ingredientMatch,
    quickAddTo,
    onQuickAdd,
    onDelete: confirmDelete,
    children: (
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={[
          styles.row,
          {
            minHeight: sizes.recipeTile + spacing.md * 2,
            paddingVertical: spacing.md - sizes.focusRing,
            paddingHorizontal: spacing.lg - sizes.focusRing,
            gap: spacing.md,
            backgroundColor: colors.surface,
            borderWidth: sizes.focusRing,
            // The outline follows the card's corners, so it isn't clipped on the first and last rows.
            borderRadius: highlighted ? rounded.card : 0,
            borderColor: highlighted ? colors.primary : 'transparent',
          },
        ]}>
        <RecipePhotoTile recipeId={recipe.id} imageUrl={recipe.imageUrl} />
        <View style={styles.flex}>
          <ThemedText variant="headline" numberOfLines={1}>
            {recipe.name}
          </ThemedText>
          {ingredientMatch ? (
            <ThemedText variant="footnote" color="inkSecondary">
              {t('recipes.tab.has')}{' '}
              <ThemedText variant="footnote" color="inkSecondary" style={styles.match}>
                {ingredientMatch}
              </ThemedText>
            </ThemedText>
          ) : meta ? (
            <ThemedText variant="footnote" color="inkSecondary">
              {meta}
            </ThemedText>
          ) : null}
        </View>
        {onList ? (
          // Badge pins itself to the top; the wrapper centres it in the row.
          <View>
            <Badge label={t('recipes.tab.onList', { name: onList })} />
          </View>
        ) : null}
      </View>
    ),
  });

  return (
    <ReanimatedSwipeable
      ref={swipeable}
      // Follows the finger like a list row; a short swipe leaves Delete showing, a full one asks at once.
      friction={1}
      overshootLeft={false}
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

/** Asks before deleting a recipe (the menu's Delete, a swipe's and VoiceOver's); `onCancel` closes a swiped row. */
function confirmDeleteRecipe(recipe: { id: string; name: string }, onCancel?: () => void) {
  Alert.alert(i18n.t('recipes.tab.deleteTitle', { name: recipe.name }), i18n.t('recipes.tab.deleteMessage'), [
    { text: i18n.t('common.cancel'), style: 'cancel', onPress: onCancel },
    { text: i18n.t('common.delete'), style: 'destructive', onPress: () => deleteRecipe(recipe.id) },
  ]);
}

/**
 * A recipe's row or tile as a link to the recipe (spec 4.5): its VoiceOver label and Delete action, and the
 * long-press menu (Add to <list>, Add to a list, Visit recipe, Rename, Delete). A plain function, so a row's
 * swipeable wraps the Link itself. Callers re-render on a language change through `useT`.
 */
function recipeLink({
  recipe,
  onList,
  ingredientMatch,
  quickAddTo,
  onQuickAdd,
  onDelete,
  children,
}: {
  recipe: RecipeSummary;
  onList: string | null;
  ingredientMatch: string | null;
  quickAddTo: { id: string; name: string } | null;
  onQuickAdd: (recipeId: string, list: { id: string; name: string }) => void;
  onDelete: () => void;
  children: ReactNode;
}) {
  const t = i18n.t.bind(i18n);
  // Only a link that opens (spec 4.5); plain text in the link field gets no Visit recipe on web.
  const link = recipeLinkUrl(recipe.sourceUrl) ? recipe.sourceUrl : null;
  return (
    <Link href={{ pathname: '/recipe/[id]', params: { id: recipe.id } }} asChild>
      <Link.Trigger>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={recipeRowLabel(recipe, onList, ingredientMatch)}
          accessibilityActions={[{ name: 'delete', label: t('common.delete') }]}
          onAccessibilityAction={({ nativeEvent }) => nativeEvent.actionName === 'delete' && onDelete()}>
          {/* Layout lives on the children: Link's trigger replaces the Pressable's style. */}
          {children}
        </Pressable>
      </Link.Trigger>
      <Link.Menu>
        {/* Spec 4.5: one-step add to the current list, when it's open and in the recipe's household. */}
        {quickAddTo ? (
          <Link.MenuAction
            title={quickAddTitle(quickAddTo.name)}
            icon="cart.badge.plus"
            onPress={() => onQuickAdd(recipe.id, quickAddTo)}
          />
        ) : null}
        {/* The recipe screen's Add to a list sheet (spec 4.5); left out, as that button is disabled, with no ingredients. */}
        {recipe.ingredientCount > 0 ? (
          <Link.MenuAction
            title={t('recipes.tab.addToAList')}
            icon="cart"
            onPress={() => router.push({ pathname: '/recipe/[id]/add-to-list', params: { id: recipe.id } })}
          />
        ) : null}
        {link ? (
          <Link.MenuAction title={t('lists.sections.visitRecipe')} icon="safari" onPress={() => void openRecipeLink(link)} />
        ) : null}
        <Link.MenuAction title={t('recipes.tab.rename')} icon="pencil" onPress={() => promptRecipeName(recipe.id, recipe.name)} />
        <Link.MenuAction title={t('common.delete')} icon="trash" destructive onPress={onDelete} />
      </Link.Menu>
    </Link>
  );
}

/**
 * A recipe's tile with large photos (spec 4.5): the photo at 4:3 with the "On <list>" badge over its top
 * corner, the name on up to two lines, and the time (or "Has …" when a search matched only an ingredient).
 * No swipe: Delete is in the menu and a VoiceOver action.
 */
function RecipeTile({
  recipe,
  ingredientMatch,
  onList,
  highlighted,
  quickAddTo,
  onQuickAdd,
}: {
  recipe: RecipeSummary;
  ingredientMatch: string | null;
  onList: string | null;
  /** Just imported: outlined in `primary` while the toast shows. */
  highlighted: boolean;
  quickAddTo: { id: string; name: string } | null;
  onQuickAdd: (recipeId: string, list: { id: string; name: string }) => void;
}) {
  const t = useT();
  const { colors, spacing, sizes, rounded } = useTheme();
  const time = recipeTimeLabel(recipe.totalMinutes);
  return recipeLink({
    recipe,
    onList,
    ingredientMatch,
    quickAddTo,
    onQuickAdd,
    onDelete: () => confirmDeleteRecipe(recipe),
    children: (
      <View
        style={{
          gap: spacing.xxs,
          borderWidth: sizes.focusRing,
          borderRadius: rounded.md + sizes.focusRing,
          borderColor: highlighted ? colors.primary : 'transparent',
          borderCurve: 'continuous',
        }}>
        <View style={{ marginBottom: spacing.xs }}>
          <RecipePhotoCover recipeId={recipe.id} imageUrl={recipe.imageUrl} />
          {onList ? (
            <View style={[styles.tileBadge, { top: spacing.xs, end: spacing.xs }]}>
              <Badge label={t('recipes.tab.onList', { name: onList })} />
            </View>
          ) : null}
        </View>
        <ThemedText variant="headline" numberOfLines={2}>
          {recipe.name}
        </ThemedText>
        {ingredientMatch ? (
          <ThemedText variant="footnote" color="inkSecondary">
            {t('recipes.tab.has')}{' '}
            <ThemedText variant="footnote" color="inkSecondary" style={styles.match}>
              {ingredientMatch}
            </ThemedText>
          </ThemedText>
        ) : time ? (
          <ThemedText variant="footnote" color="inkSecondary">
            {time}
          </ThemedText>
        ) : null}
      </View>
    ),
  });
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
  const t = useT();
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
      accessibilityLabel={t('common.delete')}
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
  row: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
  gridRow: { flexDirection: 'row', alignItems: 'flex-start' },
  tileBadge: { position: 'absolute', maxWidth: '80%' },
  headerRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' },
  headerPills: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', flexShrink: 1 },
  search: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
  overscroll: { position: 'absolute', left: 0, right: 0, bottom: '100%', height: 1000 },
  sheetTop: { overflow: 'hidden', borderCurve: 'continuous' },
  action: { alignItems: 'center', justifyContent: 'center' },
  fill: { position: 'absolute', top: 0, bottom: 0, right: 0 },
});
