import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { Screen } from '@/components/themed-view';
import { AddToCollectionSheet } from '@/features/recipes/add-to-collection-sheet';
import { applyCollectionTicks, readRecipeCollections } from '@/features/recipes/collections';
import { getRecipe } from '@/features/recipes/recipes';

/**
 * Add to collection (board C) for one recipe: its name under the title, a collection ticked while the
 * recipe is in it. Done puts it in the newly ticked ones and takes it out of the unticked ones.
 */
export default function AddRecipeToCollectionSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // A sheet is short-lived: the recipe and its ticks are read once.
  const [recipe] = useState(() => getRecipe(id));
  const [before] = useState(() => new Set(readRecipeCollections(id).map((c) => c.id)));

  if (!recipe) return <Screen />;
  return (
    <AddToCollectionSheet
      householdId={recipe.householdId}
      subtitle={recipe.name}
      before={before}
      onDone={(ticked) => {
        applyCollectionTicks(recipe.id, before, ticked);
        router.back();
      }}
    />
  );
}
