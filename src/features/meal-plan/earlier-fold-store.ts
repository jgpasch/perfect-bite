// The agenda's "Earlier this week" row (spec 4.16): once unfolded, it stays open for the app session,
// like the Recipes tab's folded sections. Kept per week, so a new week folds its earlier days again.
// Never saved.
import { useSyncExternalStore } from 'react';

import type { Day } from './week';

let unfoldedWeek: Day | null = null;
const listeners = new Set<() => void>();

/** Opens the earlier days of the week starting `start`. */
export function unfoldEarlierDays(start: Day): void {
  unfoldedWeek = start;
  for (const listener of [...listeners]) listener();
}

/** Folds them again (tests, and a fresh session). */
export function resetEarlierDays(): void {
  unfoldedWeek = null;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The week whose earlier days are unfolded, if any. */
export function useUnfoldedWeek(): Day | null {
  return useSyncExternalStore(subscribe, () => unfoldedWeek);
}
