// Households on the server (spec 4.7, 5). The household is created locally (ensureStarterData), so
// the app registers it with Supabase for the read-only Households screen.
// TODO(M5): sync replaces this; sign-up or the first push creates the household server-side.
import { asc } from 'drizzle-orm';

import { db, households } from '@/db';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

/** Local households, oldest first (live query). */
export function householdsQuery() {
  return db
    .select({ id: households.id, name: households.name, createdAt: households.createdAt })
    .from(households)
    .orderBy(asc(households.createdAt), asc(households.id));
}

export type HouseholdMember = {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: 'owner' | 'member';
  isYou: boolean;
};

type MemberRow = {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  role: 'owner' | 'member';
  joined_at: string;
};

/**
 * Members of a household from the server (`get_household_members`), in the server's order (owners
 * first, then by name). Throws an `Error` with the server's message on failure, including when the
 * caller isn't a member or the household isn't registered yet.
 */
export async function fetchHouseholdMembers(householdId: string, currentUserId: string): Promise<HouseholdMember[]> {
  const { data, error } = await supabase.rpc('get_household_members', { p_household_id: householdId });
  if (error) {
    const message = (error as { message?: unknown }).message;
    throw new Error(typeof message === 'string' && message ? message : "Couldn't load members");
  }
  return ((data as MemberRow[] | null) ?? []).map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    isYou: row.user_id === currentUserId,
  }));
}

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
