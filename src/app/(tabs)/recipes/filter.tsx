import { router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

import { Screen } from '@/components/themed-view';
import { useLiveQueryOn } from '@/db/live-query';
import { useRecipeFavorites } from '@/features/recipes/favorites';
import { RecipeFilterPanel } from '@/features/recipes/recipe-filter-panel';
import { setRecipeFilters, useRecipeFilters } from '@/features/recipes/recipe-filter-store';
import { matchesRecipeFilters } from '@/features/recipes/recipe-filters';
import { searchRecipes } from '@/features/recipes/recipe-search';
import { recipeIngredientNamesQuery, RECIPES_TAB_TABLES, recipesQuery } from '@/features/recipes/recipes';

/**
 * The Recipes tab's filter sheet (spec 4.14, mockup C): a group of toggle pills per facet, only the
 * values some recipe has, then Time. Picks apply at once (the tab behind updates too), so closing
 * the sheet any way keeps them; Show N recipes, counted with the tab's search, closes it.
 */
export default function RecipeFilterSheet() {
  const { q = '' } = useLocalSearchParams<{ q?: string }>();
  const { data } = useLiveQueryOn(recipesQuery(), RECIPES_TAB_TABLES);
  const { data: ingredientNames } = useLiveQueryOn(recipeIngredientNamesQuery(), RECIPES_TAB_TABLES);
  const filters = useRecipeFilters();
  const favorites = useRecipeFavorites();

  const count = useMemo(
    () =>
      searchRecipes(data, ingredientNames, q).filter(({ recipe }) => matchesRecipeFilters(recipe, filters, favorites)).length,
    [data, ingredientNames, q, filters, favorites],
  );

  return (
    <Screen>
      <RecipeFilterPanel
        recipes={data}
        favorites={favorites}
        filters={filters}
        onChange={setRecipeFilters}
        count={count}
        onDone={() => router.back()}
      />
    </Screen>
  );
}
