// The Recipes tab's folded By meal sections (spec 4.5), kept in memory for the app session like the
// filters: they survive tab switches and changing the sort, not a relaunch. Never saved.
import { useSyncExternalStore } from 'react';

let folded: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

export function getFoldedMealSections(): ReadonlySet<string> {
  return folded;
}

/** Folds the section (a `mealSectionKey`) if it's open, opens it if it's folded. */
export function toggleMealSection(key: string): void {
  const next = new Set(folded);
  if (!next.delete(key)) next.add(key);
  folded = next;
  for (const listener of [...listeners]) listener();
}

/** Opens every section again (tests, and a fresh session). */
export function resetFoldedMealSections(): void {
  folded = new Set();
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useFoldedMealSections(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getFoldedMealSections);
}
