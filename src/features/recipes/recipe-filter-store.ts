// The Recipes tab's filters (spec 4.14), kept in memory for the app session: they survive tab
// switches and the filter sheet closing, not a relaunch. Never saved.
import { useSyncExternalStore } from 'react';

import { noRecipeFilters, withoutGoneCollections, type RecipeFilters } from '@/features/recipes/recipe-filters';

let filters: RecipeFilters = noRecipeFilters();
const listeners = new Set<() => void>();

export function getRecipeFilters(): RecipeFilters {
  return filters;
}

export function setRecipeFilters(next: RecipeFilters): void {
  filters = next;
  for (const listener of [...listeners]) listener();
}

/**
 * Drops picked collections (recipe collections board E) that no live collection is called any more:
 * one was deleted or renamed. `liveNames`: every live collection's name in the user's households.
 */
export function dropGoneCollectionFilters(liveNames: readonly string[]): void {
  const next = withoutGoneCollections(filters, liveNames);
  if (next !== filters) setRecipeFilters(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useRecipeFilters(): RecipeFilters {
  return useSyncExternalStore(subscribe, getRecipeFilters);
}
