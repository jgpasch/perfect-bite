// A collection screen's filters (recipe collections board B): its Filter sheet's picks belong to that screen
// alone, so they're kept per collection while its screen is open and dropped when it closes. Never saved.
import { useSyncExternalStore } from 'react';

import { noRecipeFilters, type RecipeFilters } from '@/features/recipes/recipe-filters';

const NONE = noRecipeFilters();
let filters: ReadonlyMap<string, RecipeFilters> = new Map();
const listeners = new Set<() => void>();

function changed(next: ReadonlyMap<string, RecipeFilters>): void {
  filters = next;
  for (const listener of [...listeners]) listener();
}

export function getCollectionFilters(collectionId: string): RecipeFilters {
  return filters.get(collectionId) ?? NONE;
}

export function setCollectionFilters(collectionId: string, next: RecipeFilters): void {
  changed(new Map(filters).set(collectionId, next));
}

/** Drops the collection's picks: its screen closed. */
export function clearCollectionFilters(collectionId: string): void {
  if (!filters.has(collectionId)) return;
  const next = new Map(filters);
  next.delete(collectionId);
  changed(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useCollectionFilters(collectionId: string): RecipeFilters {
  return useSyncExternalStore(subscribe, () => getCollectionFilters(collectionId));
}
