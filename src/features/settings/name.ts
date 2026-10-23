// The user's own name (spec 4.7, Settings board 10): read from their row in the members' names cache
// (`household_member_names`, any household, so it works offline), edited on Settings > Name and saved
// straight to their `profiles` row (not the outbox: it needs a connection).
import { and, asc, eq, ne } from 'drizzle-orm';

import { db, householdMemberNames, households } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { isOffline } from '@/features/auth/delete-account';
import { refreshAllMemberNames } from '@/features/households/member-names';
import { supabase } from '@/lib/supabase';

/** The longest first or last name, as `profiles` checks it. */
export const NAME_MAX = 50;

export type MyName = { firstName: string; lastName: string | null };

function myNameQuery(userId: string) {
  return db
    .select({ firstName: householdMemberNames.firstName, lastName: householdMemberNames.lastName })
    .from(householdMemberNames)
    .where(and(eq(householdMemberNames.userId, userId), ne(householdMemberNames.firstName, '')))
    .orderBy(asc(householdMemberNames.householdId))
    .limit(1);
}

/** The user's cached name, or null before the first pull has cached one (read once). */
export function getMyName(userId: string | null | undefined): MyName | null {
  return userId ? (myNameQuery(userId).get() ?? null) : null;
}

/** The user's cached name (live), or null before the first pull has cached one. */
export function useMyName(userId: string | null | undefined): MyName | null {
  const { data } = useLiveQueryOn(myNameQuery(userId ?? ''), [householdMemberNames], [userId]);
  return userId ? (data[0] ?? null) : null;
}

/**
 * Whether the Name screen can save: the trimmed first name is 1–50 characters, the trimmed last name
 * at most 50, and either differs from the saved name.
 */
export function canSaveName(draft: { firstName: string; lastName: string }, saved: MyName | null): boolean {
  const first = draft.firstName.trim();
  const last = draft.lastName.trim();
  if ([...first].length < 1 || [...first].length > NAME_MAX || [...last].length > NAME_MAX) return false;
  return first !== (saved?.firstName.trim() ?? '') || last !== (saved?.lastName?.trim() ?? '');
}

export class SaveNameError extends Error {
  constructor(readonly kind: 'offline' | 'failed', message: string) {
    super(message);
    this.name = 'SaveNameError';
  }
}

/**
 * Saves the user's name to their `profiles` row (trimmed; a blank last name is null), then reloads
 * the members' names of each of their households so the app shows it. Throws `SaveNameError`:
 * `offline` with no connection, `failed` when the server refuses or can't be reached.
 */
export async function saveMyName(userId: string, firstName: string, lastName: string): Promise<void> {
  if (await isOffline()) throw new SaveNameError('offline', 'offline');
  let error: unknown;
  try {
    ({ error } = await supabase
      .from('profiles')
      .update({ first_name: firstName.trim(), last_name: lastName.trim() || null })
      .eq('user_id', userId));
  } catch (err) {
    error = err;
  }
  if (error) {
    console.warn("[name] couldn't save the name", error);
    throw new SaveNameError('failed', error instanceof Error ? error.message : String((error as { message?: unknown }).message ?? error));
  }
  await refreshAllMemberNames(db.select({ id: households.id }).from(households).all().map((h) => h.id));
}
