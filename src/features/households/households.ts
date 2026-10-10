// Households (spec 4.7, 5). A household is created locally (ensureStarterData) through the outbox,
// and the push sends it to the server with `create_household` (src/sync/push.ts). Members are
// fetched online for the read-only Households screen.
import { asc, sql } from 'drizzle-orm';

import { db, households, lists, recipes } from '@/db';
import { supabase } from '@/lib/supabase';

/** Local households, oldest first (live query). */
export function householdsQuery() {
  return db
    .select({ id: households.id, name: households.name, createdAt: households.createdAt })
    .from(households)
    .orderBy(asc(households.createdAt), asc(households.id));
}

/** Tables `householdsWithCountsQuery` reads, for `useLiveQueryOn`. */
export const HOUSEHOLD_COUNT_TABLES = [households, lists, recipes];

/**
 * Local households, oldest first, each with how many live lists (archived ones left out, as on the
 * lists home) and live recipes it has (live query).
 */
export function householdsWithCountsQuery() {
  return db
    .select({
      id: households.id,
      name: households.name,
      // Spelled out: Drizzle leaves columns unqualified in a one-table select, which would make
      // `id` here mean the subquery's own table.
      listCount: sql<number>`(select count(*) from "lists" l where l."household_id" = "households"."id" and l."deleted_at" is null and l."archived_at" is null)`,
      recipeCount: sql<number>`(select count(*) from "recipes" r where r."household_id" = "households"."id" and r."deleted_at" is null)`,
    })
    .from(households)
    .orderBy(asc(households.createdAt), asc(households.id));
}

/** The line under a household's name: "3 lists · 1 recipe". */
export function householdCountsLabel(listCount: number, recipeCount: number): string {
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  return `${plural(listCount, 'list')} · ${plural(recipeCount, 'recipe')}`;
}

/**
 * The letter in a round avatar: the first letter or digit of a name or email, upper-cased; "?" when
 * there isn't one.
 */
export function avatarInitial(text: string | null | undefined): string {
  const match = (text ?? '').match(/[\p{L}\p{N}]/u);
  return match ? match[0].toLocaleUpperCase() : '?';
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

/** Shown on the household screen for any load failure, including a household not registered yet. */
export const MEMBERS_ERROR_MESSAGE = "Couldn't load members. Check your connection.";

/** A member row's label: the display name, with "(You)" on the caller's own row. */
export function memberLabel(member: Pick<HouseholdMember, 'displayName' | 'isYou'>): string {
  const name = member.displayName.trim() || 'Unnamed';
  return member.isYou ? `${name} (You)` : name;
}

export function roleLabel(role: HouseholdMember['role']): string {
  return role === 'owner' ? 'Owner' : 'Member';
}
