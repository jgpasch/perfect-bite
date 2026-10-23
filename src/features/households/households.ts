// Households (spec 4.7, 5). A household is created locally (ensureStarterData) through the outbox,
// and the push sends it to the server with `create_household` (src/sync/push.ts). Members are
// fetched online for the Households screen, which also leaves a household, removes members,
// changes roles and deletes the household through the server (`leave_household`, `remove_member`,
// `rename_household`, `set_member_role`, `delete_household`). Any member turns Combine English and
// Spanish names on or off (`set_combine_languages`).
import { asc, eq, sql } from 'drizzle-orm';
import { getNetworkStateAsync, type NetworkState } from 'expo-network';

import { db, households, lists, recipes } from '@/db';
import { isOnline } from '@/features/categories/catch-up';
import { syncListSnapshot } from '@/features/siri/list-snapshot';
import { i18n, onLanguageChanged } from '@/i18n';
import { supabase } from '@/lib/supabase';
import { pullNow } from '@/sync/pull';

/** Local households, oldest first (live query). */
export function householdsQuery() {
  return db
    .select({
      id: households.id,
      name: households.name,
      createdAt: households.createdAt,
      combineLanguages: households.combineLanguages,
    })
    .from(households)
    .orderBy(asc(households.createdAt), asc(households.id));
}

/** Whether a household combines English and Spanish names (spec 4.15; live query, one row or none). */
export function combineLanguagesQuery(householdId: string) {
  return db.select({ on: households.combineLanguages }).from(households).where(eq(households.id, householdId));
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
      combineLanguages: households.combineLanguages,
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
  return i18n.t('households.counts', countsParams(listCount, recipeCount));
}

/** "3 lists" and "1 recipe", for the messages that name both. */
function countsParams(listCount: number, recipeCount: number): { lists: string; recipes: string } {
  return {
    lists: i18n.t('households.lists', { count: listCount }),
    recipes: i18n.t('households.recipes', { count: recipeCount }),
  };
}

/** A household's name for a message, or "this household" when it has none. */
function householdOrThis(name: string | null | undefined): string {
  return name?.trim() || i18n.t('households.thisHousehold');
}

export { avatarInitial } from '@/domain/avatar-initial';

export type HouseholdMember = {
  userId: string;
  firstName: string;
  /** Null when they have none. */
  lastName: string | null;
  avatarUrl: string | null;
  role: 'owner' | 'member';
  /** When they joined, as the server's ISO text: the earliest-joined member is promoted (4.7). */
  joinedAt: string;
  isYou: boolean;
};

type MemberRow = {
  user_id: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  role: 'owner' | 'member';
  joined_at: string;
};

/**
 * Members of a household from the server (`get_household_members`), in the server's order (owners
 * first, then by first name, then last name). Throws an `Error` with the server's message on failure, including when the
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
    firstName: row.first_name ?? '',
    lastName: row.last_name || null,
    avatarUrl: row.avatar_url,
    role: row.role,
    joinedAt: row.joined_at,
    isYou: row.user_id === currentUserId,
  }));
}

/**
 * Shown on the household screen for any load failure, including a household not registered yet
 * (`households.membersError`; a live binding).
 */
export let MEMBERS_ERROR_MESSAGE = '';
onLanguageChanged(() => {
  MEMBERS_ERROR_MESSAGE = i18n.t('households.membersError');
});

/** A member's full name: the first name, plus " " and the last name when there is one ("" when both are blank). */
export function memberFullName(member: Pick<HouseholdMember, 'firstName' | 'lastName'>): string {
  return [member.firstName.trim(), member.lastName?.trim() ?? ''].filter(Boolean).join(' ');
}

/** A member row's label: the full name, with "(You)" on the caller's own row. */
export function memberLabel(member: Pick<HouseholdMember, 'firstName' | 'lastName' | 'isYou'>): string {
  const name = memberFullName(member) || i18n.t('households.unnamed');
  return member.isYou ? i18n.t('households.you', { name }) : name;
}

export function roleLabel(role: HouseholdMember['role']): string {
  return role === 'owner' ? i18n.t('households.owner') : i18n.t('households.member');
}

/** A member row's VoiceOver label when it opens a sheet: "Sam, Member". */
export function memberRowAccessibilityLabel(member: HouseholdMember): string {
  return i18n.t('households.memberRow', { name: memberLabel(member), role: roleLabel(member.role) });
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
 * The alert for a failed leave, removal, rename, Combine English and Spanish names switch, role
 * change or delete. Nothing changed, so it only says why.
 */
export function householdActionAlert(
  action: 'leave' | 'remove' | 'rename' | 'combine-languages' | 'delete' | RoleChange,
  error: unknown,
  names: { householdName?: string | null; memberName?: string | null } = {},
): { title: string; message: string } {
  const { kind } = toHouseholdActionError(error);
  const household = householdOrThis(names.householdName);
  const member = names.memberName?.trim() || i18n.t('households.errors.them');
  if (kind === 'offline') return { title: i18n.t('common.offline'), message: i18n.t('households.errors.offline') };
  const titles: Record<typeof action, string> = {
    leave: i18n.t('households.errors.leave', { household }),
    rename: i18n.t('households.errors.rename', { household }),
    'combine-languages': i18n.t('households.errors.combineLanguages', { household }),
    delete: i18n.t('households.errors.delete', { household }),
    remove: i18n.t('households.errors.remove', { member }),
    'make-owner': i18n.t('households.errors.makeOwner', { member }),
    'remove-owner': i18n.t('households.errors.removeOwner', { member }),
    'step-down': i18n.t('households.errors.stepDown'),
  };
  const title = titles[action];
  const aboutThem = action === 'remove' || action === 'make-owner' || action === 'remove-owner';
  switch (kind) {
    case 'not-member':
      return {
        title,
        message: aboutThem
          ? i18n.t('households.errors.theyLeft', { household })
          : i18n.t('households.errors.youLeft', { household }),
      };
    case 'not-owner':
      return {
        title,
        message:
          action === 'rename'
            ? i18n.t('households.errors.ownersRename')
            : action === 'delete'
              ? i18n.t('households.errors.ownersDelete')
              : action === 'remove'
                ? i18n.t('households.errors.ownersRemove')
                : i18n.t('households.errors.ownersRoles'),
      };
    case 'last-owner': {
      const name = names.householdName?.trim();
      return {
        title,
        message: name
          ? i18n.t('households.errors.lastOwner', { household: name })
          : i18n.t('households.errors.lastOwnerUnnamed'),
      };
    }
    case 'blank':
      return { title, message: i18n.t('households.errors.blank') };
    case 'too-long':
      return { title, message: i18n.t('households.errors.tooLong', { max: HOUSEHOLD_NAME_MAX }) };
    default:
      return { title, message: i18n.t('households.errors.failed') };
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
 * Turns a household's Combine English and Spanish names on or off (spec 4.15,
 * `set_combine_languages`; any member). Like a rename, it asks the server first, then the local row
 * takes the new value (the next pull agrees with the server). Throws a `HouseholdActionError`
 * (offline before asking the server); a failure changes nothing locally.
 */
export async function setCombineLanguages(householdId: string, on: boolean): Promise<void> {
  await assertOnline();
  await callRpc('set_combine_languages', { p_household_id: householdId, p_on: on });
  db.update(households).set({ combineLanguages: on, updatedAt: new Date() }).where(eq(households.id, householdId)).run();
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
  const name = householdOrThis(householdName);
  const me = members.find((m) => m.isYou);
  const heir = earliestJoinedOther(members);
  const lines: string[] = [];
  let title = i18n.t('households.leave.title', { name });
  let confirmLabel = i18n.t('households.leave.confirm');
  if (!heir) {
    title = i18n.t('households.leave.titleDelete', { name });
    confirmLabel = i18n.t('households.leave.confirmDelete');
    lines.push(i18n.t('households.leave.onlyMember', countsParams(listCount, recipeCount)));
  } else {
    lines.push(i18n.t('households.leave.loseAccess'));
    const lastOwner = me?.role === 'owner' && !members.some((m) => !m.isYou && m.role === 'owner');
    if (lastOwner) {
      lines.push(i18n.t('households.leave.heir', { name: memberFullName(heir) || i18n.t('households.leave.earliestMember') }));
    }
  }
  if (onlyHousehold) lines.push(i18n.t('households.leave.newHousehold'));
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
  const counts = countsParams(listCount, recipeCount);
  const lines = [
    memberCount > 1
      ? i18n.t('households.delete.messageForAll', { ...counts, count: memberCount })
      : i18n.t('households.delete.message', counts),
  ];
  if (onlyHousehold) lines.push(i18n.t('households.leave.newHousehold'));
  return {
    title: i18n.t('households.delete.title', { name: householdOrThis(householdName) }),
    message: lines.join(' '),
    confirmLabel: i18n.t('common.delete'),
  };
}

/** Settings' toast after a household is deleted: "Deleted Cabin", the name in bold. */
export function deletedHouseholdToast(householdName: string): { message: string; emphasis?: string } {
  const name = householdName.trim();
  return name
    ? { message: i18n.t('households.delete.deleted', { name }), emphasis: name }
    : { message: i18n.t('households.delete.deletedUnnamed') };
}

/** The action sheet for another member's row (owners only): Remove, then Cancel. */
export function removeMemberSheet(householdName: string): {
  options: string[];
  destructiveButtonIndex: number;
  cancelButtonIndex: number;
} {
  return {
    options: [i18n.t('households.members.removeFrom', { household: householdOrThis(householdName) }), i18n.t('common.cancel')],
    destructiveButtonIndex: 0,
    cancelButtonIndex: 1,
  };
}

/** The confirm after choosing Remove. */
export function removeMemberConfirmation(memberName: string, householdName: string): { title: string; message: string } {
  return {
    title: i18n.t('households.members.removeTitle', { name: memberName.trim() || i18n.t('households.members.thisMember') }),
    message: i18n.t('households.members.removeMessage', { household: householdOrThis(householdName) }),
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
    return {
      options: [i18n.t('households.members.stepDown'), i18n.t('common.cancel')],
      actions: ['step-down'],
      cancelButtonIndex: 1,
      hint: i18n.t('households.members.stepDownHint'),
    };
  }
  const remove = removeMemberSheet(householdName);
  const owner = member.role === 'owner';
  return {
    options: [owner ? i18n.t('households.members.removeOwner') : i18n.t('households.members.makeOwner'), ...remove.options],
    actions: [owner ? 'remove-owner' : 'make-owner', 'remove'],
    destructiveButtonIndex: remove.destructiveButtonIndex + 1,
    cancelButtonIndex: remove.cancelButtonIndex + 1,
    hint: owner ? i18n.t('households.members.ownerHint') : i18n.t('households.members.memberHint'),
  };
}

/** The confirm after choosing a role change on a member's row (4.7). */
export function roleChangeConfirmation(
  change: RoleChange,
  memberName: string,
): { title: string; message: string; confirmLabel: string; destructive: boolean } {
  const name = memberName.trim() || i18n.t('households.members.thisMember');
  switch (change) {
    case 'make-owner':
      return {
        title: i18n.t('households.members.makeOwnerTitle', { name }),
        message: i18n.t('households.members.makeOwnerMessage'),
        confirmLabel: i18n.t('households.members.makeOwner'),
        destructive: false,
      };
    case 'remove-owner':
      return {
        title: i18n.t('households.members.removeOwnerTitle', { name }),
        message: i18n.t('households.members.removeOwnerMessage'),
        confirmLabel: i18n.t('households.members.removeOwner'),
        destructive: true,
      };
    case 'step-down':
      return {
        title: i18n.t('households.members.stepDownTitle'),
        message: i18n.t('households.members.stepDownMessage'),
        confirmLabel: i18n.t('households.members.stepDownConfirm'),
        destructive: true,
      };
  }
}

/** The role someone has after a role change. */
export function roleAfter(change: RoleChange): HouseholdMember['role'] {
  return change === 'make-owner' ? 'owner' : 'member';
}
