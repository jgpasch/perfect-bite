// Where the week plan lives (spec 4.16): its own Plan tab, or Recipes under This week. The setting is
// saved on the device; the Recipes tab's All recipes | This week segment is kept for the app session only.
import { useSyncExternalStore } from 'react';

import { getPlanTab, onPlanTabChange } from '@/features/settings/device-settings';

/** Settings > Meal plan > Plan tab, kept current while it's switched. */
export function usePlanTabSetting(): boolean {
  return useSyncExternalStore(onPlanTabChange, getPlanTab);
}

/** The Recipes tab's segment while the Plan tab is off. */
export type RecipesSegment = 'all' | 'week';

let segment: RecipesSegment = 'all';
const listeners = new Set<() => void>();

export function setRecipesSegment(next: RecipesSegment): void {
  segment = next;
  for (const listener of [...listeners]) listener();
}

/** Back to All recipes (tests, and a fresh session). */
export function resetRecipesSegment(): void {
  setRecipesSegment('all');
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useRecipesSegment(): RecipesSegment {
  return useSyncExternalStore(subscribe, () => segment);
}

/** Whether a tab-relative `pathname` is on the Plan tab. */
export function onPlanTab(pathname: string): boolean {
  return pathname === '/plan' || pathname.startsWith('/plan/');
}
