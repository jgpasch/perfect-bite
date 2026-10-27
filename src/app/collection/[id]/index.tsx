import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, PrimaryButton } from '@/components/button';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { Pill } from '@/components/pill';
import { ThemedText } from '@/components/themed-text';
import { Toast } from '@/components/toast';
import { Screen } from '@/components/themed-view';
import { useLiveQueryOn } from '@/db/live-query';
import { clearCollectionFilters, setCollectionFilters, useCollectionFilters } from '@/features/recipes/collection-filter-store';
import { deleteCollection, removeRecipesFromCollection, setRecipeInCollection, useCollection } from '@/features/recipes/collections';
import { setDeletedCollectionResult } from '@/features/recipes/deleted-collection-result';
import { useRecipeFavorites } from '@/features/recipes/favorites';
import { promptRenameCollection } from '@/features/recipes/prompt-collection-name';
import { quickAddList } from '@/features/recipes/quick-add';
import { RecipeRow, useOneOpenCard, useRecipeQuickAdd, type RecipeToast } from '@/features/recipes/recipe-card';
import { RecipeFilterBar } from '@/features/recipes/recipe-filter-bar';
import {
  activeFilterCount,
  filtersPillAccessibilityLabel,
  matchesRecipeFilters,
  noRecipeFilters,
  removeFilterChip,
} from '@/features/recipes/recipe-filters';
import { NO_RECIPES_MATCH } from '@/features/recipes/recipe-search';
import { sortRecipesByName } from '@/features/recipes/recipe-sort';
import { onListByRecipe } from '@/features/recipes/recipe-view';
import { RECIPES_TAB_TABLES, recipesOnListsQuery, recipesQuery } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * A collection's screen (recipe collections board B), pushed from the Recipes tab's Collections shelf or the
 * Collections list: back, its name in `screenTitle` over "N recipes", **Add recipes** and **Filter**, then its
 * recipes A–Z as the Recipes tab's rows, each opening the recipe (their long-press menu adds Remove from
 * <collection>). Filter opens the Filters sheet over just these recipes; its picks are this screen's and go
 * when it closes. The ⋯ menu: Rename, Select recipes (Select mode, whose bar is Remove from collection) and
 * Delete collection, which asks, then pops back to a toast with Undo. Empty: "No recipes yet" and Add recipes.
 */
export default function CollectionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useT();
  const { colors, spacing, sizes } = useTheme();
  const found = useCollection(id);
  const { data, loading } = useLiveQueryOn(recipesQuery(), RECIPES_TAB_TABLES);
  const { data: onLists } = useLiveQueryOn(recipesOnListsQuery(), RECIPES_TAB_TABLES);
  const favorites = useRecipeFavorites();
  const filters = useCollectionFilters(id);
  const filtering = activeFilterCount(filters) > 0;
  const [toast, setToast] = useState<RecipeToast | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);
  // Select mode: null when off, else the ticked recipes' ids.
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
  const { currentList, quickAdd } = useRecipeQuickAdd(setToast);
  const { cardOpened, cardClosed, closeOpenCard } = useOneOpenCard();
  const onList = useMemo(() => onListByRecipe(onLists), [onLists]);

  // The picks belong to this screen: gone when it closes.
  useEffect(() => () => clearCollectionFilters(id), [id]);

  const inIt = useMemo(
    () => (found ? sortRecipesByName(data.filter((r) => found.recipeIds.has(r.id))) : []),
    [data, found],
  );
  const shown = useMemo(() => inIt.filter((r) => matchesRecipeFilters(r, filters, favorites)), [inIt, filters, favorites]);

  // Not while the recipes' first read is in flight, or every mount flashes "No recipes yet".
  if (!found || loading) return <Screen />;
  const { collection } = found;

  const addRecipes = () => router.push({ pathname: '/collection/[id]/add-recipes', params: { id } });
  const openFilters = () => router.push({ pathname: '/collection/[id]/filter', params: { id } });
  const confirmDelete = () =>
    Alert.alert(t('recipes.collections.deleteTitle', { name: collection.name }), t('recipes.collections.deleteMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          deleteCollection(collection.id);
          setDeletedCollectionResult({ id: collection.id, name: collection.name });
          router.back();
        },
      },
    ]);
  const toggle = (recipeId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(recipeId)) next.add(recipeId);
      return next;
    });
  const allSelected = selected !== null && shown.length > 0 && shown.every((r) => selected.has(r.id));
  const removeSelected = () => {
    if (!selected || selected.size === 0) return;
    removeRecipesFromCollection(collection.id, [...selected]);
    setSelected(null);
  };

  const title =
    selected === null
      ? collection.name
      : selected.size === 0
        ? t('recipes.collections.tapToSelect')
        : t('recipes.collections.selected', { count: selected.size });

  return (
    <Screen>
      {selected !== null ? (
        <>
          <Stack.Screen options={{ headerBackVisible: false }} />
          <Stack.Toolbar placement="left">
            <Stack.Toolbar.Button onPress={() => setSelected(null)}>{t('common.cancel')}</Stack.Toolbar.Button>
          </Stack.Toolbar>
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.Button
              disabled={shown.length === 0}
              onPress={() => setSelected(allSelected ? new Set() : new Set(shown.map((r) => r.id)))}>
              {allSelected ? t('recipes.collections.deselectAll') : t('recipes.collections.selectAll')}
            </Stack.Toolbar.Button>
          </Stack.Toolbar>
        </>
      ) : (
        <>
          <Stack.Screen options={{ headerBackVisible: true }} />
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel={t('recipes.collections.menu')}>
              <Stack.Toolbar.MenuAction icon="pencil" onPress={() => promptRenameCollection(collection)}>
                {t('recipes.collections.rename')}
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction icon="checkmark.circle" onPress={() => setSelected(new Set())}>
                {t('recipes.collections.selectRecipes')}
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction icon="trash" destructive onPress={confirmDelete}>
                {t('recipes.collections.delete')}
              </Stack.Toolbar.MenuAction>
            </Stack.Toolbar.Menu>
          </Stack.Toolbar>
        </>
      )}
      <ScrollView
        style={styles.flex}
        contentInsetAdjustmentBehavior="automatic"
        onScrollBeginDrag={closeOpenCard}
        contentContainerStyle={[styles.grow, { paddingTop: spacing.xs, paddingBottom: spacing.xxl, gap: spacing.md }]}>
        <View style={{ gap: spacing.xs, paddingHorizontal: spacing.lg }}>
          <ThemedText testID="collection-title" variant="screenTitle" accessibilityRole="header">
            {title}
          </ThemedText>
          {selected === null ? (
            <ThemedText variant="subhead" color="inkSecondary">
              {t('recipes.collections.count', { count: inIt.length })}
            </ThemedText>
          ) : null}
        </View>
        {selected === null && inIt.length > 0 ? (
          <View style={[styles.buttons, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
            <Pill testID="collection-add-recipes" label={t('recipes.collections.addRecipes')} icon="plus" soft onPress={addRecipes} />
            <Pill
              testID="collection-filter"
              label={
                filtering ? `${t('recipes.collections.filter')} · ${activeFilterCount(filters)}` : t('recipes.collections.filter')
              }
              accessibilityLabel={filtersPillAccessibilityLabel(activeFilterCount(filters))}
              icon="line.3.horizontal.decrease"
              selected={filtering}
              primary
              onPress={openFilters}
            />
          </View>
        ) : null}
        {filtering && selected === null ? (
          <RecipeFilterBar
            filters={filters}
            onRemove={(chip) => setCollectionFilters(id, removeFilterChip(filters, chip))}
            onClear={() => setCollectionFilters(id, noRecipeFilters())}
          />
        ) : null}
        {inIt.length === 0 ? (
          <EmptyState
            message={t('recipes.collections.empty')}
            action={<PrimaryButton testID="collection-empty-add" label={t('recipes.collections.addRecipes')} onPress={addRecipes} />}
          />
        ) : shown.length === 0 ? (
          <View style={{ alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.xl }}>
            <ThemedText variant="callout" color="inkSecondary" style={styles.center}>
              {NO_RECIPES_MATCH}
            </ThemedText>
            <Button
              label={t('recipes.filters.clearFilters')}
              variant="plain"
              onPress={() => setCollectionFilters(id, noRecipeFilters())}
            />
          </View>
        ) : (
          <View style={{ paddingHorizontal: spacing.lg }}>
            <Card>
              {shown.map((r, j) => (
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
                    group="none"
                    ingredientMatch={null}
                    onList={onList.get(r.id) ?? null}
                    favorite={favorites.get(r.id) ?? null}
                    highlighted={toast?.recipeId === r.id}
                    quickAddTo={quickAddList(currentList, r)}
                    onQuickAdd={quickAdd}
                    onSwipeOpen={cardOpened}
                    onSwipeClose={cardClosed}
                    removeFrom={{ name: collection.name, onPress: () => setRecipeInCollection(r.id, collection.id, false) }}
                    select={selected !== null ? { on: selected.has(r.id), onToggle: () => toggle(r.id) } : undefined}
                  />
                </View>
              ))}
            </Card>
          </View>
        )}
      </ScrollView>
      {selected !== null ? (
        <SafeAreaView
          edges={['bottom']}
          style={{
            paddingHorizontal: spacing.lg,
            paddingTop: spacing.md,
            paddingBottom: spacing.sm,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: colors.border,
            backgroundColor: colors.surface,
          }}>
          <PrimaryButton
            testID="collection-remove-selected"
            label={t('recipes.collections.removeSelected')}
            icon="minus.circle"
            disabled={selected.size === 0}
            onPress={removeSelected}
          />
        </SafeAreaView>
      ) : null}
      {toast ? (
        <SafeAreaView edges={['bottom']} pointerEvents="box-none" style={[styles.toast, { paddingBottom: spacing.sm }]}>
          <Toast key={toast.key} message={toast.message} emphasis={toast.emphasis} actions={toast.actions} onDismiss={dismissToast} />
        </SafeAreaView>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  grow: { flexGrow: 1 },
  center: { textAlign: 'center' },
  buttons: { flexDirection: 'row', flexWrap: 'wrap' },
  toast: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
