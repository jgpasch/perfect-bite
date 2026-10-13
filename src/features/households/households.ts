// Households (spec 4.7, 5). A household is created locally (ensureStarterData) through the outbox,
// and the push sends it to the server with `create_household` (src/sync/push.ts). Members are
// fetched online for the Households screen, which also leaves a household, removes members,
// changes roles and deletes the household through the server (`leave_household`, `remove_member`,
// `rename_household`, `set_member_role`, `delete_household`).
import { asc, eq, sql } from 'drizzle-orm';
import { getNetworkStateAsync, type NetworkState } from 'expo-network';

import { db, households, lists, recipes } from '@/db';
import { isOnline } from '@/features/categories/catch-up';
import { syncListSnapshot } from '@/features/siri/list-snapshot';
import { supabase } from '@/lib/supabase';
import { pullNow } from '@/sync/pull';

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
  /** When they joined, as the server's ISO text: the earliest-joined member is promoted (4.7). */
  joinedAt: string;
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
    joinedAt: row.joined_at,
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

// --- Leaving and removal (spec 4.7) ---------------------------------------------------------

export type HouseholdActionErrorKind =
  | 'offline'
  | 'not-member'
  | 'not-owner'
  | 'last-owner'
  | 'blank'
  | 'too-long'
  | 'failed';

/**
 * A failed `leave_household`, `remove_member`, `rename_household`, `set_member_role` or
 * `delete_household`, with what went wrong for the alert.
 */
export class HouseholdActionError extends Error {
  constructor(
    readonly kind: HouseholdActionErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'HouseholdActionError';
  }
}

/** Maps a server error to a `HouseholdActionError` by the messages the functions raise. */
export function toHouseholdActionError(error: unknown): HouseholdActionError {
  if (error instanceof HouseholdActionError) return error;
  const raw = (error as { message?: unknown } | null)?.message;
  const message = typeof raw === 'string' ? raw : '';
  if (message.includes('not an owner')) return new HouseholdActionError('not-owner', message);
  if (message.includes('not a member')) return new HouseholdActionError('not-member', message);
  if (message.includes('last owner')) return new HouseholdActionError('last-owner', message);
  if (message.includes('household name cannot be blank')) return new HouseholdActionError('blank', message);
  if (message.includes('household name is too long')) return new HouseholdActionError('too-long', message);
  if (/network request failed|failed to fetch|network error/i.test(message)) {
    return new HouseholdActionError('offline', message);
  }
  return new HouseholdActionError('failed', message || 'Request failed');
}

/** A role change from a member row's action sheet (4.7). */
export type RoleChange = 'make-owner' | 'remove-owner' | 'step-down';

/**
 * The alert for a failed leave, removal, rename, role change or delete. Nothing changed, so it only
 * says why.
 */
export function householdActionAlert(
  action: 'leave' | 'remove' | 'rename' | 'delete' | RoleChange,
  error: unknown,
  names: { householdName?: string | null; memberName?: string | null } = {},
): { title: string; message: string } {
  const { kind } = toHouseholdActionError(error);
  const household = names.householdName?.trim() || 'this household';
  const memberName = names.memberName?.trim() || 'them';
  if (kind === 'offline') return { title: "You're offline", message: 'Connect to the internet and try again.' };
  const titles: Record<typeof action, string> = {
    leave: `Couldn't leave ${household}`,
    rename: `Couldn't rename ${household}`,
    delete: `Couldn't delete ${household}`,
    remove: `Couldn't remove ${memberName}`,
    'make-owner': `Couldn't make ${memberName} an owner`,
    'remove-owner': `Couldn't remove ${memberName} as owner`,
    'step-down': "Couldn't step down as owner",
  };
  const title = titles[action];
  const aboutThem = action === 'remove' || action === 'make-owner' || action === 'remove-owner';
  switch (kind) {
    case 'not-member':
      return { title, message: aboutThem ? `They're no longer in ${household}.` : `You're no longer in ${household}.` };
    case 'not-owner':
      return {
        title,
        message:
          action === 'rename'
            ? 'Only owners can rename a household.'
            : action === 'delete'
              ? 'Only owners can delete a household.'
              : action === 'remove'
                ? 'Only owners can remove members.'
                : 'Only owners can change who is an owner.',
      };
    case 'last-owner':
      return { title, message: `${names.householdName?.trim() || 'This household'} needs at least one owner.` };
    case 'blank':
      return { title, message: 'Enter a name.' };
    case 'too-long':
      return { title, message: `Use a shorter name (up to ${HOUSEHOLD_NAME_MAX} characters).` };
    default:
      return { title, message: 'Something went wrong. Try again.' };
  }
}

async function assertOnline(): Promise<void> {
  let state: NetworkState;
  try {
    state = await getNetworkStateAsync();
  } catch {
    return; // Unknown: let the call itself find out.
  }
  if (!isOnline(state)) throw new HouseholdActionError('offline', 'offline');
}

/** An RPC's data; an error answer or a rejected call (lost connection) throws a `HouseholdActionError`. */
async function callRpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: unknown };
  try {
    result = await supabase.rpc(fn, args);
  } catch (err) {
    throw toHouseholdActionError(err);
  }
  if (result.error) throw toHouseholdActionError(result.error);
  return result.data;
}

export type LeaveOutcome ={ outcome: 'left' | 'promoted' | 'deleted'; newHouseholdId: string | null };

/**
 * Leaves a household (`leave_household`), then pulls, so this device drops the household and gets
 * the new personal household, if the server made one, in the same pull (`purgeLostHouseholds`
 * runs after the households still listed are in). Never call `ensureStarterData` after this: the
 * server makes the new household. Throws a `HouseholdActionError` (offline before asking the server).
 */
export async function leaveHousehold(householdId: string): Promise<LeaveOutcome> {
  await assertOnline();
  const data = await callRpc('leave_household', { p_household_id: householdId });
  const result = (data ?? {}) as { outcome?: LeaveOutcome['outcome']; new_household_id?: string | null };
  await pullNow();
  return { outcome: result.outcome ?? 'left', newHouseholdId: result.new_household_id ?? null };
}

/**
 * Removes another member from a household (`remove_member`, owners only). Their devices drop the
 * household on their next sync. Throws a `HouseholdActionError` (offline before asking the server).
 */
export async function removeMember(householdId: string, userId: string): Promise<void> {
  await assertOnline();
  await callRpc('remove_member', { p_household_id: householdId, p_user_id: userId });
}

/**
 * Makes a member an owner, or an owner a member again (`set_member_role`, owners only; yourself
 * included while another owner remains). The caller reloads the members. Throws a
 * `HouseholdActionError` (offline before asking the server; `last-owner` when the household would
 * be left with none, e.g. two owners stepping each other down at once).
 */
export async function setMemberRole(householdId: string, userId: string, role: HouseholdMember['role']): Promise<void> {
  await assertOnline();
  await callRpc('set_member_role', { p_household_id: householdId, p_user_id: userId, p_role: role });
}

/**
 * Deletes a household for every member (`delete_household`, owners only), then pulls, as leaving
 * does: the pull purges it from this device and brings down the new personal household, if the
 * server made one. Other members' devices purge it on their next sync. Returns the caller's new
 * household's id (null when they still have another). Throws a `HouseholdActionError` (offline
 * before asking the server); a failure changes nothing.
 */
export async function deleteHousehold(householdId: string): Promise<{ newHouseholdId: string | null }> {
  await assertOnline();
  const data = await callRpc('delete_household', { p_household_id: householdId });
  await pullNow();
  return { newHouseholdId: (data as { new_household_id?: string | null } | null)?.new_household_id ?? null };
}

/** The longest household name `rename_household` accepts, in characters. */
export const HOUSEHOLD_NAME_MAX = 50;

/**
 * Renames a household (`rename_household`, owners only). The name is trimmed; a blank one, or one
 * over `HOUSEHOLD_NAME_MAX` characters, throws without asking the server. On success the local row
 * takes the new name at once (households aren't in the outbox; the next pull agrees with the
 * server) and, given the user, the list snapshot is rewritten for Siri and the share sheet. Throws a
 * `HouseholdActionError` (offline before asking the server); a failure changes nothing locally.
 */
export async function renameHousehold(householdId: string, name: string, userId?: string | null): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new HouseholdActionError('blank', 'household name cannot be blank');
  // Postgres counts characters, not UTF-16 units.
  if ([...trimmed].length > HOUSEHOLD_NAME_MAX) throw new HouseholdActionError('too-long', 'household name is too long');
  await assertOnline();
  await callRpc('rename_household', { p_household_id: householdId, p_name: trimmed });
  db.update(households).set({ name: trimmed, updatedAt: new Date() }).where(eq(households.id, householdId)).run();
  if (userId) syncListSnapshot(userId);
}

/**
 * The member the server promotes when the last owner leaves: the earliest-joined of the others
 * (ties by user id, as `private.remove_member_from_household` breaks them). Undefined when there are
 * no others.
 */
export function earliestJoinedOther(members: HouseholdMember[]): HouseholdMember | undefined {
  return members
    .filter((m) => !m.isYou)
    .sort((a, b) => {
      const byTime = Date.parse(a.joinedAt) - Date.parse(b.joinedAt);
      if (byTime) return byTime;
      return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
    })[0];
}

/**
 * The Leave household confirm (spec 4.7), by case: the last member (the household is deleted), the
 * last owner with other members (who becomes the owner), or anyone else; plus, when it's the user's
 * only household, that they get a new one.
 */
export function leaveConfirmation({
  householdName,
  members,
  listCount,
  recipeCount,
  onlyHousehold,
}: {
  householdName: string;
  members: HouseholdMember[];
  listCount: number;
  recipeCount: number;
  onlyHousehold: boolean;
}): { title: string; message: string; confirmLabel: string } {
  const name = householdName.trim() || 'this household';
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const me = members.find((m) => m.isYou);
  const heir = earliestJoinedOther(members);
  const lines: string[] = [];
  let title = `Leave ${name}?`;
  let confirmLabel = 'Leave';
  if (!heir) {
    title = `Leave and delete ${name}?`;
    confirmLabel = 'Leave and Delete';
    lines.push(
      `You're the only member, so its ${plural(listCount, 'list')} and ${plural(recipeCount, 'recipe')} will be deleted.`,
    );
  } else {
    lines.push("You'll lose access to its lists and recipes. They stay with the household.");
    const lastOwner = me?.role === 'owner' && !members.some((m) => !m.isYou && m.role === 'owner');
    if (lastOwner) lines.push(`${heir.displayName.trim() || 'The earliest member'} will become the owner.`);
  }
  if (onlyHousehold) lines.push("You'll get a new empty household.");
  return { title, message: lines.join(' '), confirmLabel };
}

/**
 * The Delete household confirm (spec 4.7): what's deleted, for how many members (not said when the
 * user is the only one), plus, when it's the user's only household, that they get a new one.
 */
export function deleteHouseholdConfirmation({
  householdName,
  memberCount,
  listCount,
  recipeCount,
  onlyHousehold,
}: {
  householdName: string;
  memberCount: number;
  listCount: number;
  recipeCount: number;
  onlyHousehold: boolean;
}): { title: string; message: string; confirmLabel: string } {
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const forAll = memberCount > 1 ? ` for all ${memberCount} members` : '';
  const lines = [
    `Its ${plural(listCount, 'list')} and ${plural(recipeCount, 'recipe')} will be deleted${forAll}. This can't be undone.`,
  ];
  if (onlyHousehold) lines.push("You'll get a new empty household.");
  return { title: `Delete ${householdName.trim() || 'this household'}?`, message: lines.join(' '), confirmLabel: 'Delete' };
}

/** Settings' toast after a household is deleted: "Deleted Cabin", the name in bold. */
export function deletedHouseholdToast(householdName: string): { message: string; emphasis?: string } {
  const name = householdName.trim();
  return name ? { message: `Deleted ${name}`, emphasis: name } : { message: 'Deleted the household' };
}

/** The action sheet for another member's row (owners only): Remove, then Cancel. */
export function removeMemberSheet(householdName: string): {
  options: string[];
  destructiveButtonIndex: number;
  cancelButtonIndex: number;
} {
  return {
    options: [`Remove from ${householdName.trim() || 'this household'}`, 'Cancel'],
    destructiveButtonIndex: 0,
    cancelButtonIndex: 1,
  };
}

/** The confirm after choosing Remove. */
export function removeMemberConfirmation(memberName: string, householdName: string): { title: string; message: string } {
  const household = householdName.trim() || 'this household';
  return {
    title: `Remove ${memberName.trim() || 'this member'}?`,
    message: `They'll lose access to ${household}'s lists and recipes.`,
  };
}

export type MemberAction = RoleChange | 'remove';

export type MemberActionsSheet = {
  options: string[];
  /** What each option does, by index; Cancel has none. */
  actions: MemberAction[];
  destructiveButtonIndex?: number;
  cancelButtonIndex: number;
  /** The row's VoiceOver hint: what tapping it offers. */
  hint: string;
};

/**
 * The action sheet a member row opens (4.7), or null when tapping it does nothing. Only owners get
 * one. Another member's row: Make owner (Remove as owner, for another owner), then Remove from
 * <household>, then Cancel. Your own row: Step down as owner while another owner remains, and
 * nothing otherwise (a household always has an owner).
 */
export function memberActionsSheet(
  member: HouseholdMember,
  members: HouseholdMember[],
  householdName: string,
): MemberActionsSheet | null {
  if (!members.some((m) => m.isYou && m.role === 'owner')) return null;
  if (member.isYou) {
    if (!members.some((m) => !m.isYou && m.role === 'owner')) return null;
    return { options: ['Step down as owner', 'Cancel'], actions: ['step-down'], cancelButtonIndex: 1, hint: 'Step down as owner.' };
  }
  const remove = removeMemberSheet(householdName);
  const owner = member.role === 'owner';
  return {
    options: [owner ? 'Remove as owner' : 'Make owner', ...remove.options],
    actions: [owner ? 'remove-owner' : 'make-owner', 'remove'],
    destructiveButtonIndex: remove.destructiveButtonIndex + 1,
    cancelButtonIndex: remove.cancelButtonIndex + 1,
    hint: owner ? 'Remove as owner or remove.' : 'Make owner or remove.',
  };
}

/** The confirm after choosing a role change on a member's row (4.7). */
export function roleChangeConfirmation(
  change: RoleChange,
  memberName: string,
): { title: string; message: string; confirmLabel: string; destructive: boolean } {
  const name = memberName.trim() || 'this member';
  switch (change) {
    case 'make-owner':
      return {
        title: `Make ${name} an owner?`,
        message: 'Owners can rename the household, remove members and delete it.',
        confirmLabel: 'Make owner',
        destructive: false,
      };
    case 'remove-owner':
      return { title: `Remove ${name} as owner?`, message: "They'll stay a member.", confirmLabel: 'Remove as owner', destructive: true };
    case 'step-down':
      return {
        title: 'Step down as owner?',
        message: "You'll stay a member. Only owners can rename, remove members or delete the household.",
        confirmLabel: 'Step down',
        destructive: true,
      };
  }
}

/** The role someone has after a role change. */
export function roleAfter(change: RoleChange): HouseholdMember['role'] {
  return change === 'make-owner' ? 'owner' : 'member';
}

/** VoiceOver hints for the rows that act (4.7); a member row's comes from `memberActionsSheet`. */
export const LEAVE_HINT = 'Asks to confirm, then leaves this household.';
export const RENAME_HINT = 'Asks for a new name.';
export const DELETE_HINT = 'Asks to confirm, then deletes this household for every member.';
