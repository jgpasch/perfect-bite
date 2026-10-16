// The signed-in user's plan features (spec 4.12): what `my_features()` returned (`load.ts` loads
// and caches it). Until the first answer the default plan (standard) is assumed, so nothing hides
// or stops by mistake. The app only hides or skips; Edge Functions enforce.
import { useSyncExternalStore } from 'react';

export const FEATURES = ['categorize', 'recipe_import', 'recipe_import_photo', 'recipe_tags', 'step_ingredients'] as const;
export type Feature = (typeof FEATURES)[number];

/** The default plan's features (standard), assumed until the first load. */
export const DEFAULT_FEATURES: readonly Feature[] = ['categorize'];

let features: readonly Feature[] = DEFAULT_FEATURES;
const listeners = new Set<() => void>();

/** Replaces the features (sorted, once each), telling listeners if they changed. */
export function setFeatures(next: readonly Feature[]): void {
  const sorted = [...new Set(next)].sort();
  if (sorted.length === features.length && sorted.every((f, i) => f === features[i])) return;
  features = sorted;
  for (const listener of [...listeners]) listener();
}

/** The user's features, sorted. */
export function getFeatures(): readonly Feature[] {
  return features;
}

/** For non-UI code: whether the user's plan has `feature`. */
export function hasFeature(feature: Feature): boolean {
  return features.includes(feature);
}

/** Calls `listener` whenever the features change. Returns an unsubscribe. */
export function onFeaturesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useFeature(feature: Feature): boolean {
  return useSyncExternalStore(onFeaturesChange, () => hasFeature(feature));
}

/** The known feature keys in `my_features()`'s answer; null if it isn't a list of strings. */
export function parseFeatures(data: unknown): Feature[] | null {
  if (!Array.isArray(data) || !data.every((f) => typeof f === 'string')) return null;
  return data.filter((f): f is Feature => (FEATURES as readonly string[]).includes(f));
}
