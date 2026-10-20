// The Recipes tab's folded By meal sections, and the shelves opened while grouped (spec 4.5), kept in memory for
// the app session like the filters: they survive tab switches and changing the sort, not a relaunch. Never saved.
import { useSyncExternalStore } from 'react';

let folded: ReadonlySet<string> = new Set();
// Shelves start folded while grouped, so this holds the ones opened (`RecipeShelfKey`s).
let openShelves: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

export function getFoldedMealSections(): ReadonlySet<string> {
  return folded;
}

/** Folds the section (a `recipeSectionKey`) if it's open, opens it if it's folded. */
export function toggleMealSection(key: string): void {
  const next = new Set(folded);
  if (!next.delete(key)) next.add(key);
  folded = next;
  for (const listener of [...listeners]) listener();
}

/** Opens a folded shelf, or folds an open one. */
export function toggleShelf(key: string): void {
  const next = new Set(openShelves);
  if (!next.delete(key)) next.add(key);
  openShelves = next;
  for (const listener of [...listeners]) listener();
}

/** Opens every section again and folds the shelves (tests, and a fresh session). */
export function resetFoldedMealSections(): void {
  folded = new Set();
  openShelves = new Set();
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useFoldedMealSections(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getFoldedMealSections);
}

export function useOpenShelves(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => openShelves);
}
