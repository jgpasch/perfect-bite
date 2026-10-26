import { router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

import { Screen } from '@/components/themed-view';
import { useLiveQueryOn } from '@/db/live-query';
import { setCollectionFilters, useCollectionFilters } from '@/features/recipes/collection-filter-store';
import { useCollection } from '@/features/recipes/collections';
import { useRecipeFavorites } from '@/features/recipes/favorites';
import { RecipeFilterPanel } from '@/features/recipes/recipe-filter-panel';
import { matchesRecipeFilters } from '@/features/recipes/recipe-filters';
import { RECIPES_TAB_TABLES, recipesQuery } from '@/features/recipes/recipes';

/**
 * A collection's Filters sheet (recipe collections board B): the Recipes tab's filter sheet over just the
 * collection's recipes, so its pills are the values they have and Show N recipes counts them. Its picks are
 * the collection screen's (`collection-filter-store`), not the tab's, and go when that screen closes.
 */
export default function CollectionFilterSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const found = useCollection(id);
  const { data } = useLiveQueryOn(recipesQuery(), RECIPES_TAB_TABLES);
  const filters = useCollectionFilters(id);
  const favorites = useRecipeFavorites();

  const inIt = useMemo(() => (found ? data.filter((r) => found.recipeIds.has(r.id)) : []), [data, found]);
  const count = useMemo(() => inIt.filter((r) => matchesRecipeFilters(r, filters, favorites)).length, [inIt, filters, favorites]);

  return (
    <Screen>
      <RecipeFilterPanel
        recipes={inIt}
        favorites={favorites}
        filters={filters}
        onChange={(next) => setCollectionFilters(id, next)}
        count={count}
        onDone={() => router.back()}
      />
    </Screen>
  );
}
