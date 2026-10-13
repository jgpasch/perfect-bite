import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/button';
import { Pill } from '@/components/pill';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { useLiveQueryOn } from '@/db/live-query';
import { setRecipeFilters, useRecipeFilters } from '@/features/recipes/recipe-filter-store';
import {
  activeFilterCount,
  availableFilterFacets,
  isFilterPicked,
  matchesRecipeFilters,
  noRecipeFilters,
  showRecipesLabel,
  toggleRecipeFilter,
} from '@/features/recipes/recipe-filters';
import { searchRecipes } from '@/features/recipes/recipe-search';
import { recipeIngredientNamesQuery, RECIPES_TAB_TABLES, recipesQuery } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';

/**
 * The Recipes tab's filter sheet (spec 4.14, mockup C): a group of toggle pills per facet, only the
 * values some recipe has, then Time. Picks apply at once (the tab behind updates too), so closing
 * the sheet any way keeps them; Show N recipes, counted with the tab's search, closes it.
 */
export default function RecipeFilterSheet() {
  const { q = '' } = useLocalSearchParams<{ q?: string }>();
  const { spacing } = useTheme();
  const { data } = useLiveQueryOn(recipesQuery(), RECIPES_TAB_TABLES);
  const { data: ingredientNames } = useLiveQueryOn(recipeIngredientNamesQuery(), RECIPES_TAB_TABLES);
  const filters = useRecipeFilters();

  const facets = useMemo(() => availableFilterFacets(data, filters), [data, filters]);
  const count = useMemo(
    () => searchRecipes(data, ingredientNames, q).filter(({ recipe }) => matchesRecipeFilters(recipe, filters)).length,
    [data, ingredientNames, q, filters],
  );
  const inset = { paddingHorizontal: spacing.lg + spacing.xs };

  return (
    <Screen>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          disabled={activeFilterCount(filters) === 0}
          accessibilityLabel="Clear filters"
          onPress={() => setRecipeFilters(noRecipeFilters())}>
          Clear
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ScrollView
        style={styles.flex}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingTop: spacing.xs, paddingBottom: spacing.lg, gap: spacing.lg }}>
        {facets.length === 0 ? (
          <ThemedText variant="callout" color="inkSecondary" style={[inset, styles.center]}>
            No recipes have tags yet.
          </ThemedText>
        ) : null}
        {facets.map((facet) => (
          <View key={facet.key} style={{ gap: spacing.sm }}>
            <ThemedText variant="sectionLabel" color="inkSecondary" accessibilityRole="header" style={inset}>
              {facet.label}
            </ThemedText>
            <View style={[styles.wrap, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
              {facet.values.map((value) => {
                const on = isFilterPicked(filters, facet.key, value.slug);
                return (
                  <Pill
                    key={value.slug}
                    label={value.label}
                    selected={on}
                    accessibilityRole="togglebutton"
                    accessibilityState={{ checked: on }}
                    onPress={() => setRecipeFilters(toggleRecipeFilter(filters, facet.key, value.slug))}
                  />
                );
              })}
            </View>
          </View>
        ))}
      </ScrollView>
      <SafeAreaView edges={['bottom']} style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.sm }}>
        <PrimaryButton label={showRecipesLabel(count)} onPress={() => router.back()} />
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { textAlign: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
});
