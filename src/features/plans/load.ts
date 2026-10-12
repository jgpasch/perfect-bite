// Loads the features store (`features.ts`, spec 4.12) from `my_features()`: after sign-in, and on
// each foreground and reconnect while online. The last answer is kept in device settings so an
// offline launch has it; sign-out clears both.
import { startCatchUpTriggers } from '@/features/categories/catch-up';
import { clearDeviceSetting, getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

import { DEFAULT_FEATURES, getFeatures, hasFeature, parseFeatures, setFeatures, type Feature } from './features';

/** Device setting with the last loaded features, for the user they belong to. */
export const FEATURES_KEY = 'plans.features';
type Cached = { userId: string; features: Feature[] };

let userId: string | null = null;
/** Bumped on sign-out, so a load that started before it can't bring the old features back. */
let generation = 0;
/** Last known connectivity; null until the OS reports it. */
let online: boolean | null = null;

function save(next: readonly Feature[]) {
  setFeatures(next);
  if (userId) setDeviceSetting<Cached>(FEATURES_KEY, { userId, features: [...getFeatures()] });
}

/**
 * Loads the user's features into the store and device settings. Skipped while signed out or the
 * OS says there's no connection; a failed load keeps what the store has. Never throws.
 */
export async function refreshFeatures(): Promise<void> {
  if (!userId || online === false || !isSupabaseConfigured) return;
  const current = generation;
  try {
    const { data, error } = await supabase.rpc('my_features');
    if (error) throw error;
    const next = parseFeatures(data);
    if (!next) throw new Error('my_features: unexpected response');
    if (current === generation) save(next);
  } catch (err) {
    console.warn('[plans] my_features failed', err);
  }
}

/**
 * A server said the user's plan doesn't have `feature` (`not_entitled`): drop it now, so nothing
 * asks again, and reload the rest.
 */
export function lostFeature(feature: Feature): Promise<void> {
  if (userId && hasFeature(feature)) save(getFeatures().filter((f) => f !== feature));
  return refreshFeatures();
}

/**
 * For the signed-in `user`: takes the cached features (else the default), loads now, then on every
 * foreground and reconnect. The cleanup stops the triggers; sign-out clears with `clearFeatures`.
 */
export function startFeatures(user: string): () => void {
  if (userId !== user) {
    generation++;
    userId = user;
    const cached = getDeviceSetting<Cached | null>(FEATURES_KEY, null);
    setFeatures(cached?.userId === user ? (parseFeatures(cached.features) ?? DEFAULT_FEATURES) : DEFAULT_FEATURES);
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
  setFeatures(DEFAULT_FEATURES);
}
