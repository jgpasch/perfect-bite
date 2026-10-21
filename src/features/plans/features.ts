// The user's plan features per household (spec 4.12): what `my_household_features()` returned
// (`load.ts` loads and caches it). Until the first answer, and for a household the answer doesn't
// have yet (one just made or joined), the default plan (founding: both features) is assumed, so
// nothing hides by mistake. The app only hides or disables; Edge Functions enforce.
import { useSyncExternalStore } from 'react';

import { db, households as householdsTable } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';

export const FEATURES = ['recipe_import', 'recipe_photo_ai'] as const;
export type Feature = (typeof FEATURES)[number];

/** The default plan's features (founding), assumed for a household the answer doesn't have. */
export const DEFAULT_FEATURES: readonly Feature[] = ['recipe_import', 'recipe_photo_ai'];

/** Each household's features, sorted, once each. */
export type HouseholdFeatures = Readonly<Record<string, readonly Feature[]>>;

/** The last answer; null before the first one. */
let answer: HouseholdFeatures | null = null;
const listeners = new Set<() => void>();

function normalize(features: readonly Feature[]): Feature[] {
  return [...new Set(features)].sort();
}

function same(a: HouseholdFeatures | null, b: HouseholdFeatures | null): boolean {
  if (a === null || b === null) return a === b;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((id) => {
    const x = a[id];
    const y = b[id];
    return y !== undefined && x.length === y.length && x.every((f, i) => f === y[i]);
  });
}

/** Replaces the answer (each list sorted, once each; null: none yet), telling listeners if it changed. */
export function setHouseholdFeatures(next: HouseholdFeatures | null): void {
  const normalized = next && Object.fromEntries(Object.entries(next).map(([id, features]) => [id, normalize(features)]));
  if (same(answer, normalized)) return;
  answer = normalized;
  for (const listener of [...listeners]) listener();
}

/** The last answer, null before the first. */
export function getHouseholdFeatures(): HouseholdFeatures | null {
  return answer;
}

/** A household's features: the answer's, else the default plan's. */
export function featuresOf(householdId: string): readonly Feature[] {
  return answer?.[householdId] ?? DEFAULT_FEATURES;
}

/** For non-UI code: whether `householdId`'s plan has `feature`. */
export function hasFeature(feature: Feature, householdId: string): boolean {
  return featuresOf(householdId).includes(feature);
}

/**
 * Whether any of the user's households has `feature`: those on the device (`localHouseholds`) and
 * those in the answer. With none known, the default plan's answer.
 */
export function hasAnyHouseholdFeature(feature: Feature, localHouseholds: readonly string[]): boolean {
  const ids = new Set([...localHouseholds, ...Object.keys(answer ?? {})]);
  if (ids.size === 0) return DEFAULT_FEATURES.includes(feature);
  return [...ids].some((id) => hasFeature(feature, id));
}

/** Calls `listener` whenever the answer changes. Returns an unsubscribe. */
export function onFeaturesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useFeature(feature: Feature, householdId: string): boolean {
  return useSyncExternalStore(onFeaturesChange, () => hasFeature(feature, householdId));
}

/** For an entry point not yet tied to a household: whether any of the user's households has `feature`. */
export function useAnyHouseholdFeature(feature: Feature): boolean {
  const { data } = useLiveQueryOn(db.select({ id: householdsTable.id }).from(householdsTable), [householdsTable]);
  const ids = data.map((h) => h.id);
  return useSyncExternalStore(onFeaturesChange, () => hasAnyHouseholdFeature(feature, ids));
}

/** The known feature keys in a list; null if it isn't a list of strings. */
function parseFeatureList(data: unknown): Feature[] | null {
  if (!Array.isArray(data) || !data.every((f) => typeof f === 'string')) return null;
  return data.filter((f): f is Feature => (FEATURES as readonly string[]).includes(f));
}

/**
 * `my_household_features()`'s answer, `{ households: { <id>: [features] } }`, keeping the known keys;
 * null for any other shape (an old cached answer was a plain list).
 */
export function parseHouseholdFeatures(data: unknown): Record<string, Feature[]> | null {
  const households = (data as { households?: unknown } | null)?.households;
  if (!households || typeof households !== 'object' || Array.isArray(households)) return null;
  const out: Record<string, Feature[]> = {};
  for (const [id, list] of Object.entries(households)) {
    const features = parseFeatureList(list);
    if (!features) return null;
    out[id] = features;
  }
  return out;
}
