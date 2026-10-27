// Members' names on the device (spec 4.7, 5): `household_member_names` caches `get_household_members`
// for each household, so the app can say who checked or added something offline. It's a cache:
// never pushed, filled after each full pull (all households in one `get_households_members` call)
// and when Realtime reports a membership change in a household (each fill replaces that household's rows), and purged with the household
// (`purgeHousehold`) and on sign-out or account deletion (`wipeLocalData`).
import { eq } from 'drizzle-orm';
import { useMemo } from 'react';

import { db, householdMemberNames } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { getAccount } from '@/features/auth/account';
import { householdMateJoined, notePushMoment } from '@/features/push/ask';
import { i18n } from '@/i18n';
import { supabase } from '@/lib/supabase';

type MemberRow = { user_id: string; first_name: string | null; last_name: string | null; joined_at: string };

/**
 * Replaces `householdId`'s cached names with the server's members (`get_household_members`).
 * Returns whether it did: a failed call (offline, or no longer a member) keeps the rows it had.
 * Never throws.
 */
export async function refreshMemberNames(householdId: string): Promise<boolean> {
  let rows: MemberRow[];
  try {
    const { data, error } = await supabase.rpc('get_household_members', { p_household_id: householdId });
    if (error) throw error;
    rows = (data as MemberRow[] | null) ?? [];
  } catch (err) {
    console.warn(`[members] couldn't load the names in ${householdId}`, err);
    return false;
  }
  storeMemberNames(householdId, rows);
  return true;
}

/**
 * Refreshes every household's names in one call (`get_households_members`, after a full pull). A
 * household it has no members for (no longer the user's) keeps the rows it had, as a failed
 * `refreshMemberNames` would; a failed call keeps them all. Never throws.
 */
export async function refreshAllMemberNames(householdIds: string[]): Promise<void> {
  if (householdIds.length === 0) return;
  let rows: (MemberRow & { household_id: string })[];
  try {
    const { data, error } = await supabase.rpc('get_households_members', { p_household_ids: householdIds });
    if (error) throw error;
    rows = (data as (MemberRow & { household_id: string })[] | null) ?? [];
  } catch (err) {
    console.warn("[members] couldn't load the names", err);
    return;
  }
  const byHousehold = new Map<string, MemberRow[]>();
  for (const { household_id, ...row } of rows) {
    byHousehold.set(household_id, [...(byHousehold.get(household_id) ?? []), row]);
  }
  for (const id of new Set(householdIds)) {
    const members = byHousehold.get(id);
    if (members) storeMemberNames(id, members);
  }
}

/** Replaces `householdId`'s cached names with `rows`, and notes a moment to offer push. */
function storeMemberNames(householdId: string, rows: MemberRow[]): void {
  const before = db
    .select({ userId: householdMemberNames.userId })
    .from(householdMemberNames)
    .where(eq(householdMemberNames.householdId, householdId))
    .all()
    .map((r) => r.userId);
  db.transaction((tx) => {
    tx.delete(householdMemberNames).where(eq(householdMemberNames.householdId, householdId)).run();
    if (rows.length) {
      tx.insert(householdMemberNames)
        .values(
          rows.map((r) => ({
            householdId,
            userId: r.user_id,
            firstName: r.first_name ?? '',
            lastName: r.last_name || null,
            joinedAt: r.joined_at,
          })),
        )
        .onConflictDoNothing()
        .run();
    }
  });
  // A household that was just the user's now has someone else in it: a moment to offer push (4.13).
  const me = getAccount()?.userId ?? null;
  if (householdMateJoined(before, rows.map((r) => r.user_id), me)) notePushMoment();
}

/** Members' short names by user id. */
export type MemberNames = ReadonlyMap<string, string>;

/**
 * Each member's short name: their first name as it is ("Alex", "Mary Ann"), and when another member's
 * first name is the same (ignoring case), their last name's initial too ("Alex R.", "Alex M."). A
 * clash with no last name keeps the first name; a blank first name gets no entry, so it reads as
 * unknown.
 */
export function shortMemberNames(
  members: readonly { userId: string; firstName: string; lastName: string | null }[],
): MemberNames {
  const firsts = new Map<string, number>();
  for (const m of members) {
    const first = m.firstName.trim().toLocaleLowerCase();
    if (first) firsts.set(first, (firsts.get(first) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  for (const m of members) {
    const first = m.firstName.trim();
    if (!first) continue;
    const last = m.lastName?.trim() ?? '';
    const clash = (firsts.get(first.toLocaleLowerCase()) ?? 0) > 1;
    names.set(m.userId, clash && last ? `${first} ${[...last][0].toLocaleUpperCase()}.` : first);
  }
  return names;
}

/**
 * Who a user id is, for a sentence: "You" for the current user, their short name, or "Someone" for
 * an unknown, removed or null id.
 */
export function nameOf(names: MemberNames, userId: string | null | undefined, currentUserId: string | null): string {
  if (userId && userId === currentUserId) return i18n.t('addedBy.you');
  return (userId && names.get(userId)) || i18n.t('addedBy.someone');
}

function namesQuery(householdId: string) {
  return db
    .select({
      userId: householdMemberNames.userId,
      firstName: householdMemberNames.firstName,
      lastName: householdMemberNames.lastName,
    })
    .from(householdMemberNames)
    .where(eq(householdMemberNames.householdId, householdId));
}

/** A member's name in a household, as `nameOf` gives it (read once). */
export function memberName(householdId: string, userId: string | null | undefined): string {
  return nameOf(shortMemberNames(namesQuery(householdId).all()), userId, getAccount()?.userId ?? null);
}

/** The household's members' short names (live). Empty for a null household. */
export function useMemberNames(householdId: string | null | undefined): MemberNames {
  const { data } = useLiveQueryOn(namesQuery(householdId ?? ''), [householdMemberNames], [householdId]);
  return useMemo(() => shortMemberNames(data), [data]);
}
