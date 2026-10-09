// Households on the server (spec 4.7, 5). The household is created locally (ensureStarterData), so
// the app registers it with Supabase for the read-only Households screen.
// TODO(M5): sync replaces this; sign-up or the first push creates the household server-side.
import { asc } from 'drizzle-orm';

import { db, households } from '@/db';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

/** Device setting holding the user id a household was registered for. */
const registeredKey = (householdId: string) => `household.${householdId}.registeredFor`;

/**
 * Sends each local household not yet registered on this device (for this user) to
 * `create_household`, and remembers the ones that succeed. Failures are logged and retried on the
 * next launch; this never throws.
 */
export async function registerHouseholds(userId: string): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const local = db
      .select({ id: households.id, name: households.name })
      .from(households)
      .orderBy(asc(households.createdAt))
      .all();
    for (const household of local) {
      if (getDeviceSetting<string | null>(registeredKey(household.id), null) === userId) continue;
      try {
        const { error } = await supabase.rpc('create_household', { p_id: household.id, p_name: household.name });
        if (error) throw error;
        setDeviceSetting(registeredKey(household.id), userId);
      } catch (e) {
        console.warn(`Couldn't register household ${household.id}; will retry next launch`, e);
      }
    }
  } catch (e) {
    console.warn("Couldn't register households", e);
  }
}
