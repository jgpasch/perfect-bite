import { router, useFocusEffect, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Host, Menu, RNHostView, Toggle } from '@expo/ui/swift-ui';
import { accessibilityLabel } from '@expo/ui/swift-ui/modifiers';

import { HEADER_WASH, hueHeaderBand, listHeaderColors } from '@/components/appearance';
import { Button, PrimaryButton } from '@/components/button';
import { Card, CardSlice } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { Icon, type IconName } from '@/components/icon';
import { FoldingSection, SectionHeader } from '@/components/section-header';
import { ThemedText } from '@/components/themed-text';
import { Toast } from '@/components/toast';
import { Screen } from '@/components/themed-view';
import { failedImports, households } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { householdsQuery } from '@/features/households/households';
import { setRecipesSegment, usePlanTabSetting, useRecipesSegment, type RecipesSegment } from '@/features/meal-plan/plan-tab';
import { MEAL_PLAN_QUERY_TABLES, restOfWeekEntriesQuery } from '@/features/meal-plan/queries';
import { today as todayOf } from '@/features/meal-plan/week';
import { WeekPlan } from '@/features/meal-plan/week-plan';
import { mix } from '@/domain/contrast';
import { useAnyHouseholdFeature } from '@/features/plans/features';
import { CollectionShelfTile, NewCollectionTile } from '@/features/recipes/collection-shelf';
import { readCollectionNames, useCollections, useCollectionsByRecipe } from '@/features/recipes/collections';
import { useDeletedCollectionToast } from '@/features/recipes/deleted-collection-result';
import { failedImportsQuery } from '@/features/recipes/failed-imports';
import { savedRecipeToast } from '@/features/recipes/import-sheet';
import { ImportsCard } from '@/features/recipes/imports-card';
import { promptNewCollectionIn } from '@/features/recipes/prompt-collection-name';
import { toggled } from '@/features/recipes/add-sheet';
import {
  collectionTicksToast,
  onCollectionTicksResult,
  takeCollectionTicksResult,
} from '@/features/recipes/collection-ticks-result';
import {
  confirmDeleteRecipe,
  RecipeRow,
  recipeLink,
  RecipeTile,
  useOneOpenCard,
  useRecipeQuickAdd,
  type RecipeToast,
} from '@/features/recipes/recipe-card';
import {
  gridRows,
  readRecipePhotoSize,
  RECIPE_PHOTO_SIZE_KEY,
  recipeGridColumns,
  type RecipePhotoSize,
} from '@/features/recipes/recipe-photo-size';
import { useRecipeFavorites } from '@/features/recipes/favorites';
import { quickAddList } from '@/features/recipes/quick-add';
import { groupRecipesByHousehold, onListByRecipe } from '@/features/recipes/recipe-view';
import { toggleMealSection, toggleShelf, useFoldedMealSections, useOpenShelves } from '@/features/recipes/recipe-fold-store';
import { recipeListItems, type RecipeListItem } from '@/features/recipes/recipe-list-items';
import { RecipeShelf, RecipeShelfTile } from '@/features/recipes/recipe-shelf';
import {
  recipeShelves,
  shelfTileLabel,
  shelvesShown,
  type RecipeShelf as Shelf,
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
import { dropGoneCollectionFilters, setRecipeFilters, useRecipeFilters } from '@/features/recipes/recipe-filter-store';
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
  recipeIngredientNamesQuery,
  RECIPES_TAB_TABLES,
  recipesOnListsQuery,
  recipesQuery,
  type RecipeSummary,
} from '@/features/recipes/recipes';
import { onSavedRecipeResult, takeSavedRecipeResult } from '@/features/recipes/saved-recipe-result';
import { importsCardHeading, useShareQueueStatus } from '@/features/recipes/share-queue-status';
import { useMotion } from '@/hooks/use-motion';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/** A recipe the search and filters left, with the ingredient that matched the search, if any. */
type ShownRecipe = RecipeSummary & { ingredientMatch: string | null };

/**
 * Recipes tab (spec 4.5): the List tab's green header (the title, the sort button and +, then the search field
 * holding Filters) over a card of recipe rows per household; with no search or filters, shelves (This week,
 * Collections, Recently added, Favorites) and an All recipes heading come first. A card's Select enters Select
 * mode (recipe collections board D), whose bar adds the ticked recipes to collections.
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
  const { data, loading } = useLiveQueryOn(recipesQuery(), RECIPES_TAB_TABLES);
  const { data: onLists } = useLiveQueryOn(recipesOnListsQuery(), RECIPES_TAB_TABLES);
  const { data: ingredientNames } = useLiveQueryOn(recipeIngredientNamesQuery(), RECIPES_TAB_TABLES);
  const { data: failed } = useLiveQueryOn(failedImportsQuery(), [failedImports]);
  const queue = useShareQueueStatus();
  const showImports = importsCardHeading(failed.length, queue) !== null;
  const [toast, setToast] = useState<RecipeToast | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);
  // Spec 4.14: kept only while the screen is mounted, never saved.
  const [query, setQuery] = useState('');
  const searching = query.trim() !== '';
  // Spec 4.14: kept for the app session, AND with the search.
  const filters = useRecipeFilters();
  const filtering = activeFilterCount(filters) > 0;
  // Spec 4.14: every member's favorites, for the filters, the hearts and the menu.
  const favorites = useRecipeFavorites();
  // Recipe collections board E: the names of the collections each recipe is in, for the Collections filters.
  const inCollections = useCollectionsByRecipe();
  const searched =useMemo(() => searchRecipes(data, ingredientNames, query), [data, ingredientNames, query]);
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
          .filter(({ recipe }) => matchesRecipeFilters(recipe, filters, favorites, inCollections))
          .map(({ recipe, ingredientMatch }) => ({ ...recipe, ingredientMatch })),
      ).map((group) => ({
        ...group,
        recipes: sortRecipes(group.recipes, sort),
        sections: groupRecipes(group.recipes, grouping, sort, favorites),
      })),
    [searched, filters, favorites, inCollections, sort, grouping],
  );
  // Recipes the search found that tag filters hide for having no tags (none with Untagged on).
  const untaggedHidden =
    filtering && !filters.untagged ? searched.filter(({ recipe }) => isUntaggedRecipe(recipe, favorites)).length : 0;
  const onList = useMemo(() => onListByRecipe(onLists), [onLists]);

  // Spec 4.5: with no search or filters, shelves over an All recipes heading (none below 8 recipes).
  const today = todayOf();
  const { data: weekEntries } = useLiveQueryOn(restOfWeekEntriesQuery(today), MEAL_PLAN_QUERY_TABLES);
  // Recipe collections board A: every household's collections, the Collections shelf's tiles.
  const collections = useCollections();
  // Board E: a picked collection that's deleted (or renamed) drops out of the filters. Read straight from
  // the database, since the live query starts empty.
  useEffect(() => dropGoneCollectionFilters(readCollectionNames()), [collections]);
  const { data: householdRows } = useLiveQueryOn(householdsQuery(), [households]);
  const showShelves = !week && shelvesShown({ query, filters, recipeCount: data.length });
  const shelves = useMemo(
    () => (showShelves ? recipeShelves({ recipes: data, entries: weekEntries, today, favorites, collections }) : []),
    [showShelves, data, weekEntries, today, favorites, collections],
  );
  const scroll = useRef<FlatList<RecipeListItem<ShownRecipe>>>(null);
  const allRecipesY = useRef(0);
  const { reduceMotion } = useMotion();
  // Spec 4.5: while grouped, each shelf folds to its header so the sections show; a tap opens it in place.
  const openShelves = useOpenShelves();
  const seeAll = (key: RecipeShelfKey) => {
    if (key === 'thisWeek') {
      if (planTab) router.navigate('/plan');
      else setRecipesSegment('week');
    } else if (key === 'collections') {
      router.push('/collections');
    } else if (key === 'recent') {
      setSortChoice({ sort: 'recent', group: grouping });
      scroll.current?.scrollToOffset({ offset: allRecipesY.current, animated: !reduceMotion });
    } else {
      // The shelves give way to the filter's results.
      setRecipeFilters(toggleRecipeFilter(noRecipeFilters(), 'saved', 'favorites'));
    }
  };
  const openCollection = (id: string) => router.push({ pathname: '/collection/[id]', params: { id } });

  // Spec 4.5: the card menu's quick add goes to the current list (the List tab's).
  const { currentList, quickAdd } = useRecipeQuickAdd(setToast);
  // Spec 4.5: one card's Delete open at a time; opening another or scrolling closes it.
  const { cardOpened, cardClosed, closeOpenCard } = useOneOpenCard();

  // Recipe collections board D: Select mode, null when off, else the ticked recipes' ids. Ticks outlast the
  // search and filters; they must share one household.
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
  const selecting = selected !== null && !week;
  const byId = useMemo(() => new Map(data.map((r) => [r.id, r])), [data]);
  const picked = selecting ? [...selected].filter((id) => byId.has(id)) : [];
  const pickedHousehold = picked.length > 0 ? byId.get(picked[0])!.householdId : null;
  // Select All: every recipe shown (after search and filters) of the selection's household, or of the first
  // household shown while nothing's ticked.
  const selectable = groups
    .filter((g) => g.householdId === (pickedHousehold ?? groups[0]?.householdId))
    .flatMap((g) => g.recipes.map((r) => r.id));
  const allSelected = selecting && selectable.length > 0 && selectable.every((id) => selected.has(id));
  const startSelecting = (recipeId: string) => {
    closeOpenCard();
    setToast(null);
    setSelected(new Set([recipeId]));
  };
  const toggleSelected = (recipe: RecipeSummary) => {
    if (!selected) return;
    if (!selected.has(recipe.id) && pickedHousehold !== null && recipe.householdId !== pickedHousehold) {
      setToast({ key: `one-household-${recipe.id}`, message: t('recipes.collections.oneHousehold'), actions: [] });
      return;
    }
    setSelected(toggled(selected, recipe.id));
  };
  const selectAll = () => {
    if (!selected) return;
    const next = new Set(selected);
    for (const id of selectable) {
      if (allSelected) next.delete(id);
      else next.add(id);
    }
    setSelected(next);
  };
  const addSelectedToCollection = () =>
    router.push({ pathname: '/add-to-collection', params: { ids: picked.join(',') } });
  // Done in the Add to collection sheet: leave Select mode, saying what it did.
  useFocusEffect(
    useCallback(() => {
      const show = () => {
        const result = takeCollectionTicksResult();
        if (!result) return;
        setSelected(null);
        const done = collectionTicksToast(result);
        setToast(done ? { key: `collection-ticks-${Date.now()}`, ...done, actions: [] } : null);
      };
      show();
      return onCollectionTicksResult(show);
    }, []),
  );
  const [barHeight, setBarHeight] = useState(0);

  // Spec 4.5: one Add recipe sheet, its one field taking a name or (with import) a link.
  const addRecipe = () => router.push('/add-recipe');
  const importFromLink = addRecipe;
  // The sheet counts with the search, so it gets the text; it isn't kept anywhere.
  const openFilters = () => router.push({ pathname: '/recipes/filter', params: { q: query } });
  // Spec 4.12: with no household whose plan has recipe import, the empty state has no Import from link.
  const canImport = useAnyHouseholdFeature('recipe_import');
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
  // Recipe collections board B: a collection deleted on its screen, which popped back here.
  useDeletedCollectionToast(setToast);

  // Spec 4.5: household names only tell recipes apart when there's more than one household.
  const labelHouseholds = new Set(data.map((r) => r.householdId)).size > 1;

  // A card's recipe rows, separated by hairlines.
  const renderRows = (rows: readonly ShownRecipe[]) =>
    rows.map((r, j) => renderRow(r, j === 0));
  const renderRow = (r: ShownRecipe, first: boolean) => (
    <View key={r.id}>
      {!first ? (
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
        favorite={favorites.get(r.id) ?? null}
        highlighted={toast?.recipeId === r.id}
        quickAddTo={quickAddList(currentList, r)}
        onQuickAdd={quickAdd}
        onSwipeOpen={cardOpened}
        onSwipeClose={cardClosed}
        onSelect={() => startSelecting(r.id)}
        select={selecting ? { on: selected.has(r.id), onToggle: () => toggleSelected(r) } : undefined}
      />
    </View>
  );

  // Large photos: the same recipes as tiles, each its own card on the screen's ground, two per row (one at the
  // largest text sizes) and 12 apart. Under a section's header band they start 12 below it.
  const renderGridRow = (row: readonly ShownRecipe[]) => (
    <View key={row[0].id} testID="recipe-grid-row" style={[styles.gridRow, { gap: spacing.md }]}>
      {row.map((r) => (
        <View key={r.id} testID="recipe-grid-cell" style={styles.flex}>
          <RecipeTile
            recipe={r}
            group={grouping}
            ingredientMatch={r.ingredientMatch}
            onList={onList.get(r.id) ?? null}
            favorite={favorites.get(r.id) ?? null}
            highlighted={toast?.recipeId === r.id}
            quickAddTo={quickAddList(currentList, r)}
            onQuickAdd={quickAdd}
            onSelect={() => startSelecting(r.id)}
            select={selecting ? { on: selected.has(r.id), onToggle: () => toggleSelected(r) } : undefined}
          />
        </View>
      ))}
      {/* A short last row keeps its tiles at the column width. */}
      {Array.from({ length: columns - row.length }, (_, k) => (
        <View key={`gap-${k}`} testID="recipe-grid-cell" style={styles.flex} />
      ))}
    </View>
  );
  const renderGrid = (tiles: readonly ShownRecipe[], underHeader = false) => (
    <View testID="recipe-grid" style={{ paddingTop: underHeader ? spacing.md : 0, gap: spacing.md }}>
      {gridRows(tiles, columns).map(renderGridRow)}
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
      favorite: favorites.get(recipe.id) ?? null,
      quickAddTo: quickAddList(currentList, recipe),
      onQuickAdd: quickAdd,
      onDelete: () => confirmDeleteRecipe(recipe),
      onSelect: () => startSelecting(recipe.id),
      label: shelfTileLabel(item, listName),
      children: <RecipeShelfTile recipe={recipe} caption={item.caption} onList={listName} />,
    });
  };
  // Recipe collections board A: the Collections shelf's tiles, A–Z, then the dashed New collection tile.
  const collectionTiles = (shelf: Shelf<RecipeSummary>) =>
    shelf.collections
      ? [
          ...shelf.collections.map((c) => (
            <CollectionShelfTile key={c.id} collection={c} onPress={() => openCollection(c.id)} />
          )),
          <NewCollectionTile key="new" onPress={() => promptNewCollectionIn(householdRows, openCollection)} />,
        ]
      : undefined;

  const items = useMemo(
    () =>
      week
        ? []
        : recipeListItems({ groups, grouped: grouping !== 'none', large: photoSize === 'large', columns, labelHouseholds }),
    [week, groups, grouping, photoSize, columns, labelHouseholds],
  );
  // A household's first item: the gap above the household, and its name when there's more than one.
  const renderItem = (item: RecipeListItem<ShownRecipe>) =>
    item.household ? (
      <View style={{ paddingTop: item.household.first ? spacing.xs : spacing.lg + spacing.xxs }}>
        {item.household.label ? (
          <ThemedText
            variant="sectionLabel"
            color="inkSecondary"
            accessibilityRole="header"
            style={{ paddingHorizontal: spacing.lg + spacing.xs, paddingBottom: spacing.sm }}>
            {item.household.name}
          </ThemedText>
        ) : null}
        {renderRecipes(item)}
      </View>
    ) : (
      renderRecipes(item)
    );
  const renderRecipes = (item: RecipeListItem<ShownRecipe>) => {
    if (item.kind === 'section') {
      // Spec 4.5: a folding card per section, its header tinted in the section's hue. With large photos the
      // tiles are their own cards, so the section's ground is the screen's.
      const { section } = item;
      const key = recipeSectionKey(item.householdId, grouping, section.key);
      return (
        <View style={{ paddingHorizontal: spacing.lg, paddingTop: item.household ? 0 : spacing.md }}>
          <Card background={photoSize === 'large' ? 'background' : 'surface'}>
            <FoldingSection
              title={section.title}
              band={hueHeaderBand(section.hue, scheme)}
              count={section.recipes.length}
              countUnit={recipeSectionUnit()}
              collapsed={folded.has(key)}
              onToggle={() => toggleMealSection(key)}>
              {photoSize === 'large' ? renderGrid(section.recipes, true) : renderRows(section.recipes)}
            </FoldingSection>
          </Card>
        </View>
      );
    }
    if (item.kind === 'tiles') {
      // The tiles are their own cards, so there's no household card around them; their rows are 12 apart.
      return (
        <View testID="recipe-grid-item" style={{ paddingHorizontal: spacing.lg, paddingTop: item.first ? 0 : spacing.md }}>
          <View style={{ marginHorizontal: spacing.lg }}>{renderGridRow(item.recipes)}</View>
        </View>
      );
    }
    // The household's card, a slice per row.
    return (
      <View style={{ paddingHorizontal: spacing.lg }}>
        <CardSlice top={item.first} bottom={item.last}>
          {renderRow(item.recipe, item.first)}
        </CardSlice>
      </View>
    );
  };

  return (
    <Screen>
      {onRecipes ? <StatusBar style="light" /> : null}
      {/* Only the rows in sight are mounted, so a search keystroke stays quick with hundreds of recipes. */}
      <FlatList
        ref={scroll}
        contentInsetAdjustmentBehavior="automatic"
        onScrollBeginDrag={closeOpenCard}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.grow, { paddingBottom: spacing.xl }]}
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => renderItem(item)}
        // Not while the first read is in flight, or every mount flashes "No recipes yet".
        ListEmptyComponent={!week && !loading && data.length === 0 ? empty : null}
        ListFooterComponent={
          !week && untaggedHidden > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityHint={t('recipes.tab.untaggedHint')}
              onPress={() => setRecipeFilters(untaggedOnlyFilters())}
              style={{ justifyContent: 'center', minHeight: sizes.minTapTarget, paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
              <ThemedText variant="footnote" color="inkSecondary" style={styles.center}>
                {untaggedFootnote(untaggedHidden)}
              </ThemedText>
            </Pressable>
          ) : null
        }
        ListHeaderComponent={
          <View>
            <View style={{ backgroundColor: header.ground }}>
              {/* Pulling down past the top shows more green, not the tab's ground. */}
              <View style={[styles.overscroll, { backgroundColor: header.ground }]} />
              <View style={{ gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.xs, paddingBottom: spacing.md }}>
                {selecting ? (
                  // Board D: Cancel and Select All over "4 selected" (or "Tap recipes to select them").
                  <View style={{ gap: spacing.xs }}>
                    <View style={[styles.titleRow, styles.between]}>
                      <HeaderTextButton testID="recipes-select-cancel" label={t('common.cancel')} onPress={() => setSelected(null)} />
                      <HeaderTextButton
                        testID="recipes-select-all"
                        label={allSelected ? t('recipes.collections.deselectAll') : t('recipes.collections.selectAll')}
                        disabled={selectable.length === 0}
                        onPress={selectAll}
                      />
                    </View>
                    <ThemedText
                      testID="recipes-select-title"
                      variant={picked.length > 0 ? 'largeTitle' : 'title'}
                      color="onHeader"
                      accessibilityRole="header"
                      style={{ paddingHorizontal: spacing.xs }}>
                      {picked.length > 0
                        ? t('recipes.collections.selected', { count: picked.length })
                        : t('recipes.collections.tapToSelect')}
                    </ThemedText>
                  </View>
                ) : (
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
                )}
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
            {!week && !selecting && showImports ? <ImportsCard failed={failed} queue={queue} /> : null}
            {!week && data.length > 0 ? (
              <RecipeFilterBar
                filters={filters}
                onRemove={(chip) => setRecipeFilters(removeFilterChip(filters, chip))}
                onClear={() => setRecipeFilters(noRecipeFilters())}
              />
            ) : null}
            {/* Select mode ticks the recipes below, so the shelves and their heading give way. */}
            {selecting ? null : showShelves && shelves.length > 0 && grouping !== 'none' ? (
              <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.xs }}>
                <Card>
                  {shelves.map((shelf, i) => (
                    <View key={shelf.key}>
                      {i > 0 ? (
                        <View
                          style={{ height: StyleSheet.hairlineWidth, marginLeft: spacing.lg, backgroundColor: colors.border }}
                        />
                      ) : null}
                      <RecipeShelf
                        shelf={shelf}
                        onSeeAll={() => seeAll(shelf.key)}
                        renderTile={renderShelfTile}
                        tiles={collectionTiles(shelf)}
                        fold={{ open: openShelves.has(shelf.key), onToggle: () => toggleShelf(shelf.key) }}
                      />
                    </View>
                  ))}
                </Card>
              </View>
            ) : showShelves && shelves.length > 0 ? (
              <View style={{ gap: spacing.xl - spacing.xxs, paddingTop: spacing.xs }}>
                {shelves.map((shelf) => (
                  <RecipeShelf
                    key={shelf.key}
                    shelf={shelf}
                    onSeeAll={() => seeAll(shelf.key)}
                    renderTile={renderShelfTile}
                    tiles={collectionTiles(shelf)}
                  />
                ))}
              </View>
            ) : null}
            {showShelves && !selecting ? (
              // A direct child of the list's header, which starts the content, so its y is where Recently
              // added's See all scrolls to.
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
          </View>
        }
      />
      {selecting ? (
        // Board D: the bar over the tab bar.
        <View
          testID="recipes-select-bar"
          onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)}
          style={{
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.md,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: colors.border,
            backgroundColor: colors.surface,
          }}>
          <PrimaryButton
            testID="recipes-add-to-collection"
            label={t('recipes.collections.addSelected')}
            icon="rectangle.stack"
            disabled={picked.length === 0}
            onPress={addSelectedToCollection}
          />
        </View>
      ) : null}
      {toast ? (
        // Above the tab bar (the screen ends there), and above Select mode's bar.
        <SafeAreaView
          edges={selecting ? [] : ['bottom']}
          pointerEvents="box-none"
          style={[styles.toast, { bottom: selecting ? barHeight : 0, paddingBottom: spacing.sm }]}>
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
      {/* Keyed on the name: matchContents sizes the Host once, so a wider name would otherwise be clipped. */}
      <Host key={name} matchContents colorScheme={scheme} seedColor={colors.primary}>
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

/** Select mode's Cancel and Select All on the green header: plain `onHeader` text, 44 pt tall. */
function HeaderTextButton({
  label,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const { sizes, spacing, opacity } = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      hitSlop={spacing.xs}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        {
          minHeight: sizes.minTapTarget,
          paddingHorizontal: spacing.xs,
          opacity: disabled ? opacity.disabled : pressed ? opacity.pressed : 1,
        },
      ]}>
      <ThemedText variant="itemName" color="onHeader">
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  between: { justifyContent: 'space-between' },
  shrink: { flexShrink: 1 },
  center: { textAlign: 'center' },
  grow: { flexGrow: 1 },
  toast: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  gridRow: { flexDirection: 'row', alignItems: 'flex-start' },
  titleRow: { flexDirection: 'row', alignItems: 'center' },
  start: { alignItems: 'flex-start' },
  switcher: { flexDirection: 'row', alignItems: 'center' },
  search: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
  filtersPill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  overscroll: { position: 'absolute', left: 0, right: 0, bottom: '100%', height: 1000 },
  sheetTop: { overflow: 'hidden', borderCurve: 'continuous' },
  action: { alignItems: 'center', justifyContent: 'center' },
});
