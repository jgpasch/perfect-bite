import { Link, router, useFocusEffect, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { useAnimatedReaction, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { Host, Menu, RNHostView, Toggle } from '@expo/ui/swift-ui';
import { accessibilityLabel } from '@expo/ui/swift-ui/modifiers';

import { HEADER_WASH, hueHeaderBand, listHeaderColors } from '@/components/appearance';
import { Badge } from '@/components/badge';
import { Button, PrimaryButton } from '@/components/button';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { Icon, type IconName } from '@/components/icon';
import { FoldingSection, SectionHeader } from '@/components/section-header';
import { ThemedText } from '@/components/themed-text';
import { Toast, type ToastAction } from '@/components/toast';
import { Screen } from '@/components/themed-view';
import { failedImports, households, listItems, lists, userSettings } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { getAccount } from '@/features/auth/account';
import { categorizePending } from '@/features/categories/categorization';
import { openList, resolveCurrentListId, useCurrentListVersion } from '@/features/lists/current-list';
import { getList, listsWithCountsQuery } from '@/features/lists/lists';
import { setRecipesSegment, usePlanTabSetting, useRecipesSegment, type RecipesSegment } from '@/features/meal-plan/plan-tab';
import { MEAL_PLAN_QUERY_TABLES, restOfWeekEntriesQuery } from '@/features/meal-plan/queries';
import { today as todayOf } from '@/features/meal-plan/week';
import { WeekPlan } from '@/features/meal-plan/week-plan';
import { mix } from '@/domain/contrast';
import { useFeature } from '@/features/plans/features';
import { failedImportsQuery } from '@/features/recipes/failed-imports';
import { importedOnRecipesToast, savedRecipeToast, sharedImportsToast } from '@/features/recipes/import-sheet';
import { ImportsCard } from '@/features/recipes/imports-card';
import { promptRecipeName } from '@/features/recipes/prompt-recipe-name';
import { openRecipeLink, recipeLinkUrl } from '@/features/recipes/recipe-link';
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
  recipeSavedMarks,
  recipeTimeLabel,
} from '@/features/recipes/recipe-view';
import { useFoldedMealSections, toggleMealSection } from '@/features/recipes/recipe-fold-store';
import { RecipeShelf, RecipeShelfTile } from '@/features/recipes/recipe-shelf';
import {
  recipeShelves,
  shelfTileLabel,
  shelvesShown,
  type RecipeShelfItem,
  type RecipeShelfKey,
} from '@/features/recipes/recipe-shelves';
import { RecipeSortButton } from '@/features/recipes/recipe-sort-button';
import {
  groupRecipes,
  recipeSectionKey,
  recipeSectionUnit,
  sortRecipes,
  type RecipeGroup,
  type RecipeSort,
} from '@/features/recipes/recipe-sort';
import { RecipeFilterBar } from '@/features/recipes/recipe-filter-bar';
import {
  getDeviceSetting,
  getRecipeSortChoice,
  setDeviceSetting,
  setRecipeSortChoice,
} from '@/features/settings/device-settings';
import { setRecipeFilters, useRecipeFilters } from '@/features/recipes/recipe-filter-store';
import {
  activeFilterCount,
  filtersPillAccessibilityLabel,
  isUntaggedRecipe,
  matchesRecipeFilters,
  noRecipeFilters,
  removeFilterChip,
  toggleRecipeFilter,
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
  setRecipeSaved,
  type RecipeSummary,
} from '@/features/recipes/recipes';
import { onSavedRecipeResult, takeSavedRecipeResult } from '@/features/recipes/saved-recipe-result';
import { onShareImports } from '@/features/recipes/share-drain';
import { importsCardHeading, useShareQueueStatus } from '@/features/recipes/share-queue-status';
import { useMotion } from '@/hooks/use-motion';
import { useTheme } from '@/hooks/use-theme';
import { i18n, useT } from '@/i18n';
import type { RecipeTags } from '@/shared/recipe-tags';

/**
 * Recipes tab (spec 4.5): the List tab's green header (the title, the sort button and +, then the search field
 * holding Filters) over a card of recipe rows per household; with no search or filters, shelves (This week,
 * Recently added, Favorites) and an All recipes heading come first.
 */
export default function RecipesScreen() {
  const t = useT();
  const { spacing, scheme, colors, sizes, rounded, opacity } = useTheme();
  const header = listHeaderColors(colors);
  // Light status bar content on the green header, also while the Filters sheet is up over it.
  const pathname = usePathname();
  const onRecipes = pathname === '/recipes' || pathname === '/recipes/filter';
  // Spec 4.16: with the Plan tab off, All recipes | This week, kept for the app session.
  const planTab = usePlanTabSetting();
  const segment = useRecipesSegment();
  const week = !planTab && segment === 'week';
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
  // Spec 4.5: a sort (Recently added or A–Z) and a grouping, both remembered on this device.
  const [{ sort, group: grouping }, setSortChoiceState] = useState<{ sort: RecipeSort; group: RecipeGroup }>(getRecipeSortChoice);
  const setSortChoice = (next: { sort: RecipeSort; group: RecipeGroup }) => {
    setSortChoiceState(next);
    setRecipeSortChoice(next);
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
  // The grouped sections that are folded, kept for the app session (keyed by household and grouping).
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
        sections: groupRecipes(group.recipes, grouping, sort),
      })),
    [searched, filters, sort, grouping],
  );
  // Recipes the search found that tag filters hide for having no tags (none with Untagged on).
  const untaggedHidden =
    filtering && !filters.untagged ? searched.filter(({ recipe }) => isUntaggedRecipe(recipe)).length : 0;
  const onList = useMemo(() => onListByRecipe(onLists), [onLists]);

  // Spec 4.5: with no search or filters, shelves over an All recipes heading (none below 8 recipes).
  const today = todayOf();
  const { data: weekEntries } = useLiveQueryOn(restOfWeekEntriesQuery(today), MEAL_PLAN_QUERY_TABLES);
  const showShelves = !week && shelvesShown({ query, filters, recipeCount: data.length });
  const shelves = useMemo(
    () => (showShelves ? recipeShelves({ recipes: data, entries: weekEntries, today }) : []),
    [showShelves, data, weekEntries, today],
  );
  const scroll = useRef<ScrollView>(null);
  const allRecipesY = useRef(0);
  const { reduceMotion } = useMotion();
  const seeAll = (key: RecipeShelfKey) => {
    if (key === 'thisWeek') {
      if (planTab) router.navigate('/plan');
      else setRecipesSegment('week');
    } else if (key === 'recent') {
      setSortChoice({ sort: 'recent', group: grouping });
      scroll.current?.scrollTo({ y: allRecipesY.current, animated: !reduceMotion });
    } else {
      // The shelves give way to the filter's results.
      setRecipeFilters(toggleRecipeFilter(noRecipeFilters(), 'saved', 'favorite'));
    }
  };

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

  // Spec 4.5: one Add recipe sheet, its one field taking a name or (with import) a link.
  const addRecipe = () => router.push('/add-recipe');
  const importFromLink = addRecipe;
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
          group={grouping}
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

  // Large photos: the same recipes as tiles, each its own card on the screen's ground, two per row (one at the
  // largest text sizes) and 12 apart. Under a section's header band they start 12 below it.
  const renderGrid = (tiles: readonly (RecipeSummary & { ingredientMatch: string | null })[], underHeader = false) => (
    <View testID="recipe-grid" style={{ paddingTop: underHeader ? spacing.md : 0, gap: spacing.md }}>
      {gridRows(tiles, columns).map((row) => (
        <View key={row[0].id} testID="recipe-grid-row" style={[styles.gridRow, { gap: spacing.md }]}>
          {row.map((r) => (
            <View key={r.id} testID="recipe-grid-cell" style={styles.flex}>
              <RecipeTile
                recipe={r}
                group={grouping}
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
  // A shelf's tile: the card's link, long-press menu and badge, read as "Tacos, Thursday dinner".
  const renderShelfTile = (item: RecipeShelfItem<RecipeSummary>) => {
    const { recipe } = item;
    const listName = onList.get(recipe.id) ?? null;
    return recipeLink({
      recipe,
      group: grouping,
      onList: listName,
      ingredientMatch: null,
      quickAddTo: quickAddList(currentList, recipe),
      onQuickAdd: quickAdd,
      onDelete: () => confirmDeleteRecipe(recipe),
      label: shelfTileLabel(item, listName),
      children: <RecipeShelfTile recipe={recipe} caption={item.caption} onList={listName} />,
    });
  };

  const renderRecipes = (recipes: readonly (RecipeSummary & { ingredientMatch: string | null })[], underHeader = false) =>
    photoSize === 'large' ? renderGrid(recipes, underHeader) : renderRows(recipes);

  return (
    <Screen>
      {onRecipes ? <StatusBar style="light" /> : null}
      <ScrollView
        ref={scroll}
        contentInsetAdjustmentBehavior="automatic"
        onScrollBeginDrag={closeOpenCard}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.grow, { paddingBottom: spacing.xl }]}>
        <View style={{ backgroundColor: header.ground }}>
          {/* Pulling down past the top shows more green, not the tab's ground. */}
          <View style={[styles.overscroll, { backgroundColor: header.ground }]} />
          <View style={{ gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.xs, paddingBottom: spacing.md }}>
            <View style={[styles.titleRow, { gap: spacing.sm }]}>
              {planTab ? (
                <ThemedText
                  variant="largeTitle"
                  color="onHeader"
                  accessibilityRole="header"
                  style={[styles.flex, { paddingHorizontal: spacing.xs }]}>
                  {t('recipes.tab.title')}
                </ThemedText>
              ) : (
                // Spec 4.16: with the Plan tab off, the title switches between All recipes and This week.
                <RecipesViewTitle week={week} />
              )}
              {!week && data.length > 0 ? (
                <RecipeSortButton
                  sort={sort}
                  group={grouping}
                  photoSize={photoSize}
                  onSortChange={(next) => setSortChoice({ sort: next, group: grouping })}
                  onGroupChange={(next) => setSortChoice({ sort, group: next })}
                  onPhotoSizeChange={setPhotoSize}
                />
              ) : null}
              {/* Spec 4.1: the tab bar's + adds items, so adding a recipe has its own button here. */}
              <Pressable
                testID="recipes-add"
                accessibilityRole="button"
                accessibilityLabel={t('recipes.tab.addRecipe')}
                onPress={addRecipe}
                style={({ pressed }) => [
                  styles.action,
                  {
                    width: sizes.minTapTarget,
                    height: sizes.minTapTarget,
                    borderRadius: rounded.full,
                    backgroundColor: colors.onHeader,
                    opacity: pressed ? opacity.pressed : 1,
                  },
                ]}>
                <Icon name="plus" tint={colors.header} size={sizes.icon} weight="semibold" />
              </Pressable>
            </View>
            {!week && data.length > 0 ? (
              <RecipeSearchField
                count={data.length}
                query={query}
                onChange={setQuery}
                filterCount={activeFilterCount(filters)}
                onOpenFilters={openFilters}
              />
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
        {/* Spec 4.16: This week is the week alone, its toolbar the sheet's first row. */}
        {week ? <WeekPlan onToast={setToast} /> : null}
        {/* Spec 4.10: shares importing, waiting or that won't import, at the top. */}
        {!week && showImports ? <ImportsCard failed={failed} queue={queue} /> : null}
        {!week && data.length === 0 ? empty : null}
        {!week && data.length > 0 ? (
          <RecipeFilterBar
            filters={filters}
            onRemove={(chip) => setRecipeFilters(removeFilterChip(filters, chip))}
            onClear={() => setRecipeFilters(noRecipeFilters())}
          />
        ) : null}
        {showShelves && shelves.length > 0 ? (
          <View style={{ gap: spacing.xl - spacing.xxs, paddingTop: spacing.xs }}>
            {shelves.map((shelf) => (
              <RecipeShelf key={shelf.key} shelf={shelf} onSeeAll={() => seeAll(shelf.key)} renderTile={renderShelfTile} />
            ))}
          </View>
        ) : null}
        {showShelves ? (
          // A direct child of the scroll view, so its y is where Recently added's See all scrolls to.
          <View
            testID="recipes-all-heading"
            onLayout={(e) => (allRecipesY.current = e.nativeEvent.layout.y)}
            style={{ paddingTop: shelves.length > 0 ? spacing.sm : 0 }}>
            <SectionHeader
              title={t('recipes.shelves.allRecipes')}
              count={data.length}
              countPlacement="title"
              countUnit={recipeSectionUnit()}
            />
          </View>
        ) : null}
        {!week && data.length > 0 && (searching || filtering) && groups.length === 0 ? (
          <View style={{ alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.xl }}>
            <ThemedText variant="callout" color="inkSecondary" style={styles.center}>
              {NO_RECIPES_MATCH}
            </ThemedText>
            {filtering ? (
              <Button label={t('recipes.filters.clearFilters')} variant="plain" onPress={() => setRecipeFilters(noRecipeFilters())} />
            ) : null}
          </View>
        ) : null}
        {(week ? [] : groups).map((group, i) => (
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
            {grouping !== 'none' ? (
              // Spec 4.5: a folding card per section, its header tinted in the section's hue. With large photos
              // the tiles are their own cards, so the section's ground is the screen's.
              <View style={{ gap: spacing.md, paddingHorizontal: spacing.lg }}>
                {group.sections.map((section) => {
                  const key = recipeSectionKey(group.householdId, grouping, section.key);
                  return (
                    <Card key={key} background={photoSize === 'large' ? 'background' : 'surface'}>
                      <FoldingSection
                        title={section.title}
                        band={hueHeaderBand(section.hue, scheme)}
                        count={section.recipes.length}
                        countUnit={recipeSectionUnit()}
                        collapsed={folded.has(key)}
                        onToggle={() => toggleMealSection(key)}>
                        {renderRecipes(section.recipes, true)}
                      </FoldingSection>
                    </Card>
                  );
                })}
              </View>
            ) : (
              <View style={{ paddingHorizontal: spacing.lg }}>
                {photoSize === 'large' ? (
                  // The tiles are their own cards, so there's no household card around them.
                  <View style={{ marginHorizontal: spacing.lg }}>{renderRecipes(group.recipes)}</View>
                ) : (
                  <Card>{renderRecipes(group.recipes)}</Card>
                )}
              </View>
            )}
          </View>
        ))}
        {!week && untaggedHidden > 0 ? (
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
        // Above the tab bar: the screen ends there.
        <SafeAreaView edges={['bottom']} pointerEvents="box-none" style={[styles.toast, { paddingBottom: spacing.sm }]}>
          <Toast key={toast.key} message={toast.message} emphasis={toast.emphasis} actions={toast.actions} onDismiss={dismissToast} />
        </SafeAreaView>
      ) : null}
    </Screen>
  );
}

const VIEWS: readonly { value: RecipesSegment; icon: IconName }[] = [
  { value: 'all', icon: 'book' },
  { value: 'week', icon: 'calendar' },
];

/**
 * The title with the Plan tab off (spec 4.16): the view's name ("Recipes", or "This week") then a chevron, one
 * button opening a native menu of All recipes and This week, the current one ticked. Drawn as the List
 * tab's switcher title.
 */
function RecipesViewTitle({ week }: { week: boolean }) {
  const t = useT();
  const { colors, scheme, spacing, sizes } = useTheme();
  const name = week ? t('mealPlan.segments.week') : t('recipes.tab.title');
  return (
    <View style={[styles.flex, styles.start]}>
      <Host matchContents colorScheme={scheme} seedColor={colors.primary}>
        <Menu
          label={
            <RNHostView matchContents>
              <View
                testID="recipes-view-title"
                style={[styles.switcher, { minHeight: sizes.minTapTarget, paddingLeft: spacing.xs, gap: spacing.xs + spacing.xxs }]}>
                <ThemedText variant="largeTitle" color="onHeader" numberOfLines={1} style={styles.shrink}>
                  {name}
                </ThemedText>
                <Icon name="chevron.down" color="onHeaderSecondary" size={sizes.iconSmall + spacing.xs} weight="bold" />
              </View>
            </RNHostView>
          }
          modifiers={[accessibilityLabel(t('recipes.tab.switchView', { name }))]}>
          {VIEWS.map((view) => (
            <Toggle
              key={view.value}
              label={t(`mealPlan.segments.${view.value}`)}
              systemImage={view.icon}
              isOn={(view.value === 'week') === week}
              onIsOnChange={() => setRecipesSegment(view.value)}
            />
          ))}
        </Menu>
      </Host>
    </View>
  );
}

/**
 * The search field on the green header (spec 4.14): "Search 52 recipes" in a white wash, results updating
 * live under it, and at its end, after a hairline, the Filters button: a clear glyph while no filters are
 * on, a filled `onHeader` pill with the count while some are. The search is kept only while the screen is
 * mounted.
 */
function RecipeSearchField({
  count,
  query,
  onChange,
  filterCount,
  onOpenFilters,
}: {
  count: number;
  query: string;
  onChange: (text: string) => void;
  filterCount: number;
  onOpenFilters: () => void;
}) {
  const t = useT();
  const { colors, typography, spacing, sizes, rounded, opacity } = useTheme();
  const wash = listHeaderColors(colors).viewButton.fill;
  const on = filterCount > 0;
  return (
    <View
      style={[
        styles.search,
        {
          minHeight: sizes.minTapTarget,
          gap: spacing.sm,
          paddingLeft: spacing.md,
          paddingRight: spacing.xxs,
          borderRadius: rounded.md,
          backgroundColor: wash,
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
      <View
        testID="recipes-search-divider"
        style={{ width: 1, height: spacing.xl - spacing.xxs, backgroundColor: mix(colors.onHeader, wash, HEADER_WASH) }}
      />
      <Pressable
        testID="recipes-filters"
        accessibilityRole="button"
        accessibilityLabel={filtersPillAccessibilityLabel(filterCount)}
        accessibilityHint={t('recipes.filters.pillHint')}
        onPress={onOpenFilters}
        style={({ pressed }) => [styles.action, { minWidth: sizes.minTapTarget, minHeight: sizes.minTapTarget, opacity: pressed ? opacity.pressed : 1 }]}>
        <View
          style={[
            styles.filtersPill,
            on
              ? {
                  minHeight: sizes.minTapTarget - spacing.sm,
                  gap: spacing.xs,
                  paddingHorizontal: spacing.sm + spacing.xxs,
                  borderRadius: rounded.md - 3,
                  backgroundColor: colors.onHeader,
                }
              : null,
          ]}>
          <Icon name="line.3.horizontal.decrease" tint={on ? colors.header : colors.onHeader} weight="semibold" />
          {on ? (
            <ThemedText variant="amount" style={{ color: colors.header, fontWeight: '700' }}>
              {filterCount}
            </ThemedText>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}

/**
 * A recipe's row in its household's card (spec 4.5): the photo tile, the name on one line, and under it the
 * meta line ("Dinner · 35 min"), or "Has …" when a search matched only an ingredient.
 */
function RecipeRow({
  recipe,
  group,
  ingredientMatch,
  onList,
  highlighted,
  quickAddTo,
  onQuickAdd,
  onSwipeOpen,
  onSwipeClose,
}: {
  recipe: RecipeSummary;
  /** The tab's grouping: grouped by cuisine, the meta line shows the cuisine in place of the meal. */
  group: RecipeGroup;
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
  const meta = recipeMetaLine(recipe, group);

  // The menu's Delete, the swipe's and VoiceOver's; Cancel closes a swiped card.
  const confirmDelete = () => confirmDeleteRecipe(recipe, () => swipeable.current?.close());

  // eslint-disable-next-line react-hooks/refs -- `confirmDelete` reads the ref only when pressed, not during render
  const card = recipeLink({
    recipe,
    group,
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
        <RecipePhotoTile recipeId={recipe.id} imageUrl={recipe.imageUrl} photoPath={recipe.photoPath} />
        <View style={styles.flex}>
          <View style={[styles.nameLine, { gap: spacing.xs }]}>
            <ThemedText variant="headline" numberOfLines={1} style={styles.shrink}>
              {recipe.name}
            </ThemedText>
            <SavedMarks tags={recipe.tags} />
          </View>
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
 * long-press menu (Add to <list>, Add to a list, Plan…, Visit recipe, Favorite, Want to try, Rename, Delete). A plain function, so a row's
 * swipeable wraps the Link itself. Callers re-render on a language change through `useT`.
 */
function recipeLink({
  recipe,
  group,
  onList,
  ingredientMatch,
  quickAddTo,
  onQuickAdd,
  onDelete,
  label,
  children,
}: {
  recipe: RecipeSummary;
  group: RecipeGroup;
  onList: string | null;
  ingredientMatch: string | null;
  quickAddTo: { id: string; name: string } | null;
  onQuickAdd: (recipeId: string, list: { id: string; name: string }) => void;
  onDelete: () => void;
  /** VoiceOver's label in place of the row's, e.g. a shelf tile's "Tacos, Thursday dinner". */
  label?: string;
  children: ReactNode;
}) {
  const t = i18n.t.bind(i18n);
  // Only a link that opens (spec 4.5); plain text in the link field gets no Visit recipe on web.
  const link = recipeLinkUrl(recipe.sourceUrl) ? recipe.sourceUrl : null;
  const marks = recipeSavedMarks(recipe.tags);
  return (
    <Link href={{ pathname: '/recipe/[id]', params: { id: recipe.id } }} asChild>
      <Link.Trigger>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label ?? recipeRowLabel(recipe, onList, ingredientMatch, group)}
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
        {/* Spec 4.16: the plan modal, whatever the Plan tab setting. */}
        <Link.MenuAction
          title={t('recipes.tab.plan')}
          icon="calendar"
          onPress={() => router.push({ pathname: '/plan-recipe', params: { recipeId: recipe.id } })}
        />
        {link ? (
          <Link.MenuAction title={t('lists.sections.visitRecipe')} icon="safari" onPress={() => void openRecipeLink(link)} />
        ) : null}
        {/* Spec 4.5: the Saved marks, each toggling only its own slug. */}
        <Link.MenuAction
          title={t(marks.favorite ? 'recipes.tab.unfavorite' : 'recipes.tab.favorite')}
          icon={marks.favorite ? 'heart.slash' : 'heart'}
          onPress={() => setRecipeSaved(recipe.id, 'favorite', !marks.favorite)}
        />
        <Link.MenuAction
          title={t(marks.wantToTry ? 'recipes.tab.triedIt' : 'recipes.tab.wantToTry')}
          icon={marks.wantToTry ? 'checkmark' : 'bookmark'}
          onPress={() => setRecipeSaved(recipe.id, 'want-to-try', !marks.wantToTry)}
        />
        <Link.MenuAction title={t('recipes.tab.rename')} icon="pencil" onPress={() => promptRecipeName(recipe.id, recipe.name)} />
        <Link.MenuAction title={t('common.delete')} icon="trash" destructive onPress={onDelete} />
      </Link.Menu>
    </Link>
  );
}

/**
 * A recipe's tile with large photos (spec 4.5): a small card holding the photo at 4:3 with the "On <list>" badge over its top
 * corner, the name on up to two lines, and the time (or "Has …" when a search matched only an ingredient).
 * No swipe: Delete is in the menu and a VoiceOver action.
 */
function RecipeTile({
  recipe,
  group,
  ingredientMatch,
  onList,
  highlighted,
  quickAddTo,
  onQuickAdd,
}: {
  recipe: RecipeSummary;
  group: RecipeGroup;
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
    group,
    onList,
    ingredientMatch,
    quickAddTo,
    onQuickAdd,
    onDelete: () => confirmDeleteRecipe(recipe),
    children: (
      <View
        style={{
          gap: spacing.xxs,
          padding: spacing.sm - sizes.focusRing,
          backgroundColor: colors.surface,
          borderWidth: sizes.focusRing,
          // Concentric with the photo's corners, 8 pt in.
          borderRadius: rounded.md + spacing.sm,
          borderColor: highlighted ? colors.primary : 'transparent',
          borderCurve: 'continuous',
        }}>
        <View style={{ marginBottom: spacing.xs }}>
          <RecipePhotoCover recipeId={recipe.id} imageUrl={recipe.imageUrl} photoPath={recipe.photoPath} />
          {onList ? (
            <View style={[styles.tileBadge, { top: spacing.xs, end: spacing.xs }]}>
              <Badge label={t('recipes.tab.onList', { name: onList })} />
            </View>
          ) : null}
        </View>
        <View style={[styles.nameLine, { gap: spacing.xs }]}>
          <ThemedText variant="headline" numberOfLines={2} style={styles.shrink}>
            {recipe.name}
          </ThemedText>
          <SavedMarks tags={recipe.tags} />
        </View>
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

/**
 * After a recipe's name (spec 4.5): a small `primary` heart when it's a Favorite, a bookmark when it's Want to
 * try. Decorative: the row's VoiceOver label says them.
 */
function SavedMarks({ tags }: { tags: RecipeTags | null }) {
  const { sizes } = useTheme();
  const marks = recipeSavedMarks(tags);
  return (
    <>
      {marks.favorite ? <Icon name="heart.fill" color="primary" size={sizes.iconSmall} /> : null}
      {marks.wantToTry ? <Icon name="bookmark" color="inkSecondary" size={sizes.iconSmall} /> : null}
    </>
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
  shrink: { flexShrink: 1 },
  nameLine: { flexDirection: 'row', alignItems: 'center' },
  match: { fontWeight: '700' },
  center: { textAlign: 'center' },
  grow: { flexGrow: 1 },
  toast: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  row: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
  gridRow: { flexDirection: 'row', alignItems: 'flex-start' },
  tileBadge: { position: 'absolute', maxWidth: '80%' },
  titleRow: { flexDirection: 'row', alignItems: 'center' },
  start: { alignItems: 'flex-start' },
  switcher: { flexDirection: 'row', alignItems: 'center' },
  search: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
  filtersPill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  overscroll: { position: 'absolute', left: 0, right: 0, bottom: '100%', height: 1000 },
  sheetTop: { overflow: 'hidden', borderCurve: 'continuous' },
  action: { alignItems: 'center', justifyContent: 'center' },
  fill: { position: 'absolute', top: 0, bottom: 0, right: 0 },
});
