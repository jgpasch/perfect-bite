import { Stack } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/button';
import { Pill } from '@/components/pill';
import { ThemedText } from '@/components/themed-text';
import {
  activeFilterCount,
  availableFilterFacets,
  isFilterPicked,
  noRecipeFilters,
  showRecipesLabel,
  toggleRecipeFilter,
  type FilterableRecipe,
  type RecipeFilters,
} from '@/features/recipes/recipe-filters';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * The filter sheet's body (spec 4.14, mockup C): Clear in the toolbar, a group of toggle pills per
 * facet (only the values one of `recipes` has, then Time), and Show N recipes. Whoever shows it owns
 * the filters: the Recipes tab's filter route keeps them in its store, the Add to recipe sheet in
 * its own state.
 */
export function RecipeFilterPanel({
  recipes,
  filters,
  onChange,
  count,
  onDone,
}: {
  recipes: readonly FilterableRecipe[];
  filters: RecipeFilters;
  onChange: (next: RecipeFilters) => void;
  /** How many recipes the filters (and any search) leave, for Show N recipes. */
  count: number;
  onDone: () => void;
}) {
  const t = useT();
  const { spacing } = useTheme();
  const facets = useMemo(() => availableFilterFacets(recipes, filters), [recipes, filters]);
  const inset = { paddingHorizontal: spacing.lg + spacing.xs };

  return (
    <>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          disabled={activeFilterCount(filters) === 0}
          accessibilityLabel={t('recipes.filters.clearFilters')}
          onPress={() => onChange(noRecipeFilters())}>
          {t('recipes.filters.clear')}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ScrollView
        style={styles.flex}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingTop: spacing.xs, paddingBottom: spacing.lg, gap: spacing.lg }}>
        {facets.length === 0 ? (
          <ThemedText variant="callout" color="inkSecondary" style={[inset, styles.center]}>
            {t('recipes.filters.noTags')}
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
                    onPress={() => onChange(toggleRecipeFilter(filters, facet.key, value.slug))}
                  />
                );
              })}
            </View>
          </View>
        ))}
      </ScrollView>
      <SafeAreaView edges={['bottom']} style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.sm }}>
        <PrimaryButton label={showRecipesLabel(count)} onPress={onDone} />
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { textAlign: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
});
