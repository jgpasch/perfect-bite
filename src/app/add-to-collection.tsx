import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { Screen } from '@/components/themed-view';
import { AddToCollectionSheet } from '@/features/recipes/add-to-collection-sheet';
import { applyCollectionTicksToAll, readCollectionsHoldingAll, readHouseholdCollections } from '@/features/recipes/collections';
import { setCollectionTicksResult } from '@/features/recipes/collection-ticks-result';
import { getRecipe } from '@/features/recipes/recipes';
import { useT } from '@/i18n';

/**
 * Add to collection for the Recipes tab's Select mode (board D): `ids` is the selected recipes, comma-joined,
 * all of one household. "4 recipes" under the title; a collection is ticked only when every one of them is in
 * it. Done adds all of them to the newly ticked ones and takes all of them out of the unticked ones, then
 * hands the tab what it did, for its toast.
 */
export default function AddRecipesToCollectionSheet() {
  const { ids } = useLocalSearchParams<{ ids: string }>();
  const t = useT();
  // A sheet is short-lived: the recipes and their ticks are read once.
  const [recipes] = useState(() =>
    (ids ?? '')
      .split(',')
      .map((id) => getRecipe(id))
      .filter((r) => r !== null && r !== undefined),
  );
  const [before] = useState(() => readCollectionsHoldingAll(recipes.map((r) => r.id)));

  if (recipes.length === 0) return <Screen />;
  const { householdId } = recipes[0];
  const recipeIds = recipes.map((r) => r.id);
  return (
    <AddToCollectionSheet
      householdId={householdId}
      subtitle={t('recipes.collections.count', { count: recipes.length })}
      before={before}
      onDone={(ticked) => {
        const { added, removed } = applyCollectionTicksToAll(recipeIds, before, ticked);
        const names = new Map(readHouseholdCollections(householdId).map((c) => [c.id, c.name]));
        const named = (list: string[]) => list.map((id) => ({ id, name: names.get(id) ?? '' }));
        setCollectionTicksResult({ recipeCount: recipeIds.length, added: named(added), removed: named(removed) });
        router.back();
      }}
    />
  );
}
