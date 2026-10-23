import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { IconTile } from '@/components/icon-tile';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { recipeHue } from '@/domain/aisle-color';
import { getAccount } from '@/features/auth/account';
import { categorizePending } from '@/features/categories/categorization';
import { listQuery } from '@/features/lists/lists';
import { setRecipeAddResult } from '@/features/lists/recipe-add-result';
import { readRecipeFavorites, type FavoritesByRecipe } from '@/features/recipes/favorites';
import { addItemsToRecipe, makeRecipeFromItems } from '@/features/recipes/from-list';
import { RecipeFilterBar } from '@/features/recipes/recipe-filter-bar';
import { RecipeFilterPanel } from '@/features/recipes/recipe-filter-panel';
import {
  activeFilterCount,
  matchesRecipeFilters,
  noRecipeFilters,
  removeFilterChip,
  type RecipeFilters,
} from '@/features/recipes/recipe-filters';
import { NO_RECIPES_MATCH, recipeSearchPlaceholder, searchRecipes } from '@/features/recipes/recipe-search';
import { addToRecipeTitle, ingredientCountLabel, recipeCardLabel } from '@/features/recipes/recipe-view';
import { recipeIngredientNamesQuery, recipesForPicker } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * "Add to recipe" (spec 4.5): the selected list items go into a new recipe (name it, Return) or an
 * existing one of the list's household, most recently used first. The list screen under the sheet
 * then leaves Select mode, switches to By recipe and shows the toast (`takeRecipeAddResult`).
 * The recipes can be searched and filtered as on the Recipes tab (spec 4.14), but the search and
 * filters are the sheet's own: they don't touch the tab's, and go when the sheet closes.
 */
export default function AddToRecipeSheet() {
  const { id, items } = useLocalSearchParams<{ id: string; items: string }>();
  const t = useT();
  const { colors, spacing, sizes, opacity } = useTheme();
  const userId = getAccount()?.userId ?? null;

  // A sheet is short-lived: read once rather than live.
  const [itemIds] = useState(() => (items ? items.split(',').filter(Boolean) : []));
  const [list] = useState(() => listQuery(id).get());
  const [recipes] = useState(() => (list ? recipesForPicker(list.householdId) : []));
  const [ingredientNames] = useState(() => (recipes.length > 0 ? recipeIngredientNamesQuery().all() : []));
  const [favorites] = useState<FavoritesByRecipe>(() => (recipes.length > 0 ? readRecipeFavorites() : new Map()));
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<RecipeFilters>(noRecipeFilters);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const searching = query.trim() !== '';
  const filtering = activeFilterCount(filters) > 0;
  // Search and filters keep the recipes' order: most recently used first.
  const results = useMemo(
    () =>
      searchRecipes(recipes, ingredientNames, query).filter(({ recipe }) => matchesRecipeFilters(recipe, filters, favorites)),
    [recipes, ingredientNames, query, filters, favorites],
  );

  if (!list || itemIds.length === 0) return <Screen />;

  // The Filters pill shows the filter sheet's body in place; Show N recipes comes back.
  if (filtersOpen) {
    return (
      <Screen>
        <RecipeFilterPanel
          recipes={recipes}
          favorites={favorites}
          filters={filters}
          onChange={setFilters}
          count={results.length}
          onDone={() => setFiltersOpen(false)}
        />
      </Screen>
    );
  }

  const finish = (recipeId: string, recipeName: string, pendingNames: string[]) => {
    void categorizePending(pendingNames);
    setRecipeAddResult({ kind: 'toRecipe', listId: id, recipeId, recipeName, count: itemIds.length });
    router.back();
  };

  const createNew = () => {
    const trimmed = name.trim().replace(/\s+/g, ' ');
    if (!trimmed) return;
    const { recipeId, pendingNames } = makeRecipeFromItems(trimmed, itemIds, userId, list.householdId);
    finish(recipeId, trimmed, pendingNames);
  };

  return (
    <Screen
      scroll
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.lg }}>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>{t('common.cancel')}</Stack.Toolbar.Button>
      </Stack.Toolbar>
        <ThemedText variant="title" accessibilityRole="header" style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
          {addToRecipeTitle(itemIds.length)}
        </ThemedText>

        <Card>
          <View style={[styles.row, { minHeight: sizes.cardRowMin, paddingLeft: spacing.lg, gap: spacing.md }]}>
            <View style={[styles.center, { width: sizes.iconWell }]}>
              <Icon name="plus.circle.fill" color="primary" />
            </View>
            <TextField
              value={name}
              onChangeText={setName}
              placeholder={t('recipes.addToRecipe.newRecipe')}
              accessibilityLabel={t('recipes.addToRecipe.newRecipeLabel')}
              accessibilityHint={t('recipes.addToRecipe.newRecipeHint')}
              returnKeyType="done"
              autoCapitalize="words"
              onSubmitEditing={createNew}
              style={[styles.flex, { borderWidth: 0, backgroundColor: colors.surface, paddingLeft: 0 }]}
            />
          </View>
        </Card>

        {recipes.length > 0 ? (
          <View style={{ gap: spacing.xs }}>
            <View style={{ paddingHorizontal: spacing.lg }}>
              <TextField
                value={query}
                onChangeText={setQuery}
                placeholder={recipeSearchPlaceholder(recipes.length)}
                accessibilityLabel={t('recipes.tab.searchLabel')}
                returnKeyType="search"
                autoCapitalize="none"
                autoCorrect={false}
                clearButtonMode="while-editing"
              />
            </View>
            <RecipeFilterBar
              filters={filters}
              onOpen={() => setFiltersOpen(true)}
              onRemove={(chip) => setFilters(removeFilterChip(filters, chip))}
            />
          </View>
        ) : null}

        {recipes.length > 0 && (searching || filtering) && results.length === 0 ? (
          <View style={{ alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
            <ThemedText variant="callout" color="inkSecondary" style={styles.centerText}>
              {NO_RECIPES_MATCH}
            </ThemedText>
            {filtering ? (
              <Button label={t('recipes.filters.clearFilters')} variant="plain" onPress={() => setFilters(noRecipeFilters())} />
            ) : null}
          </View>
        ) : null}

        {results.length > 0 ? (
          <Card>
            {results.map(({ recipe: r, ingredientMatch }, i) => (
              <Pressable
                key={r.id}
                accessibilityRole="button"
                accessibilityLabel={recipeCardLabel(r.name, r.ingredientCount, null, ingredientMatch)}
                onPress={() => finish(r.id, r.name, addItemsToRecipe(r.id, itemIds, userId))}
                style={({ pressed }) => [
                  styles.row,
                  {
                    minHeight: sizes.cardRowMin,
                    paddingHorizontal: spacing.lg,
                    paddingVertical: spacing.sm,
                    gap: spacing.md,
                    borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                    borderTopColor: colors.border,
                    opacity: pressed ? opacity.pressed : 1,
                  },
                ]}>
                <IconTile hue={recipeHue(r.id)} name="fork.knife" />
                <View style={styles.flex}>
                  <ThemedText variant="body">{r.name}</ThemedText>
                  {/* Spec 4.14: matched only through an ingredient, "Has …" in place of the count. */}
                  {ingredientMatch ? (
                    <ThemedText variant="footnote" color="inkSecondary">
                      {t('recipes.tab.has')}{' '}
                      <ThemedText variant="footnote" color="inkSecondary" style={styles.match}>
                        {ingredientMatch}
                      </ThemedText>
                    </ThemedText>
                  ) : (
                    <ThemedText variant="footnote" color="inkSecondary">
                      {ingredientCountLabel(r.ingredientCount)}
                    </ThemedText>
                  )}
                </View>
              </Pressable>
            ))}
          </Card>
        ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  centerText: { textAlign: 'center' },
  match: { fontWeight: '700' },
});
