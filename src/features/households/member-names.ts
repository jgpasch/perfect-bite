// Members' names on the device (spec 4.7, 5): `household_member_names` caches `get_household_members`
// for each household, so the app can say who checked or added something offline. It's a cache:
// never pushed, filled after each full pull and when Realtime reports a membership change in a
// household (each fill replaces that household's rows), and purged with the household
// (`purgeHousehold`) and on sign-out or account deletion (`wipeLocalData`).
import { eq } from 'drizzle-orm';
import { useMemo } from 'react';

import { db, householdMemberNames } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { getAccount } from '@/features/auth/account';
import { householdMateJoined, notePushMoment } from '@/features/push/ask';
import { i18n } from '@/i18n';
import { supabase } from '@/lib/supabase';

type MemberRow = { user_id: string; display_name: string | null; joined_at: string };

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
          rows.map((r) => ({ householdId, userId: r.user_id, displayName: r.display_name ?? '', joinedAt: r.joined_at })),
        )
        .onConflictDoNothing()
        .run();
    }
  });
  // A household that was just the user's now has someone else in it: a moment to offer push (4.13).
  const me = getAccount()?.userId ?? null;
  if (householdMateJoined(before, rows.map((r) => r.user_id), me)) notePushMoment();
  return true;
}

/** Refreshes each household's names in turn (after a full pull). Never throws. */
export async function refreshAllMemberNames(householdIds: string[]): Promise<void> {
  for (const id of householdIds) await refreshMemberNames(id);
}

/** Members' short names by user id. */
export type MemberNames = ReadonlyMap<string, string>;

const words = (name: string) => name.trim().split(/\s+/).filter(Boolean);

/**
 * Each member's short name: the first word of their display name ("Alex" from "Alex Rivera"), and
 * when two members share a first word, the last word's initial too ("Alex R.", "Alex M."). A
 * blank display name gets no entry, so it reads as unknown.
 */
export function shortMemberNames(members: { userId: string; displayName: string }[]): MemberNames {
  const firsts = new Map<string, number>();
  for (const m of members) {
    const first = words(m.displayName)[0]?.toLocaleLowerCase();
    if (first) firsts.set(first, (firsts.get(first) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  for (const m of members) {
    const parts = words(m.displayName);
    if (!parts.length) continue;
    const first = parts[0];
    const last = parts.length > 1 ? parts[parts.length - 1] : '';
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
    .select({ userId: householdMemberNames.userId, displayName: householdMemberNames.displayName })
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
