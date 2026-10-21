// Loads the features store (`features.ts`, spec 4.12) from `my_household_features()`: after
// sign-in, on each foreground and reconnect while online, and when the user's memberships change
// (`membershipsRead`: a full pull lists households the answer doesn't match, after a join, leave or
// delete, or a new household). The last answer is kept in device settings so an offline launch has it; sign-out
// clears both.
import { startCatchUpTriggers } from '@/features/categories/catch-up';
import { clearDeviceSetting, getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

import {
  featuresOf,
  getHouseholdFeatures,
  hasFeature,
  parseHouseholdFeatures,
  setHouseholdFeatures,
  type Feature,
  type HouseholdFeatures,
} from './features';

/** Device setting with the last loaded answer, for the user it belongs to. */
export const FEATURES_KEY = 'plans.features';
type Cached = { userId: string; households: HouseholdFeatures };

let userId: string | null = null;
/** Bumped on sign-out, so a load that started before it can't bring the old features back. */
let generation = 0;
/** Last known connectivity; null until the OS reports it. */
let online: boolean | null = null;

function save(next: HouseholdFeatures) {
  setHouseholdFeatures(next);
  const saved = getHouseholdFeatures();
  if (userId && saved) setDeviceSetting<Cached>(FEATURES_KEY, { userId, households: saved });
}

/**
 * Loads the user's features into the store and device settings. Skipped while signed out or the
 * OS says there's no connection; a failed load keeps what the store has. Never throws.
 */
export async function refreshFeatures(): Promise<void> {
  if (!userId || online === false || !isSupabaseConfigured) return;
  const current = generation;
  try {
    const { data, error } = await supabase.rpc('my_household_features');
    if (error) throw error;
    const next = parseHouseholdFeatures(data);
    if (!next) throw new Error('my_household_features: unexpected response');
    if (current === generation) save(next);
  } catch (err) {
    console.warn('[plans] my_household_features failed', err);
  }
}

/**
 * A server said `householdId`'s plan doesn't have `feature` (`not_entitled`): drop it for that
 * household now, so nothing asks again, and reload. With no household, only reloads.
 */
export function lostFeature(feature: Feature, householdId: string | null | undefined): Promise<void> {
  if (userId && householdId && hasFeature(feature, householdId)) {
    save({ ...getHouseholdFeatures(), [householdId]: featuresOf(householdId).filter((f) => f !== feature) });
  }
  return refreshFeatures();
}

/**
 * A full pull read the user's `households` (`onMemberships`): reloads when they differ from the
 * answer's (a join, leave or delete, or a new household). Before the first answer, nothing: that
 * load is already on its way.
 */
export function membershipsRead(households: readonly string[]): Promise<void> {
  const known = getHouseholdFeatures();
  if (!known) return Promise.resolve();
  const ids = Object.keys(known);
  const changed = households.length !== ids.length || households.some((id) => !(id in known));
  return changed ? refreshFeatures() : Promise.resolve();
}

/**
 * For the signed-in `user`: takes the cached answer (none if it's another user's or an older
 * shape), loads now, then on every foreground and reconnect (and `membershipsRead`). The cleanup
 * stops the triggers; sign-out clears with `clearFeatures`.
 */
export function startFeatures(user: string): () => void {
  if (userId !== user) {
    generation++;
    userId = user;
    const cached = getDeviceSetting<Cached | null>(FEATURES_KEY, null);
    setHouseholdFeatures(cached?.userId === user ? parseHouseholdFeatures(cached) : null);
  }
  const stopTriggers = startCatchUpTriggers(
    () => void refreshFeatures(),
    (now) => {
      online = now;
    },
  );
  void refreshFeatures();
  return () => {
    stopTriggers();
    online = null;
  };
}

/** Sign-out: forgets the user's features (memory and device settings), back to the default. */
export function clearFeatures(): void {
  generation++;
  userId = null;
  clearDeviceSetting(FEATURES_KEY);
  setHouseholdFeatures(null);
}
