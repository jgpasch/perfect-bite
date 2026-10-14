// Deleting your own account from Settings (spec 4.8). The server does the work (`delete_account`),
// so it needs a connection; afterwards the device keeps nothing of the user's (`wipeLocalData`).
import { getNetworkStateAsync, type NetworkState } from 'expo-network';

import { signOutLocally } from '@/features/auth/account';
import { wipeLocalData } from '@/features/auth/local-wipe';
import { pushBriefly } from '@/features/auth/sign-out';
import { isOnline } from '@/features/categories/catch-up';
import { fetchHouseholdMembers, householdsWithCountsQuery } from '@/features/households/households';
import { supabase } from '@/lib/supabase';

/** One of the user's households, for the confirm: its counts and how many members it has. */
export type HouseholdForDeletion = { name: string; listCount: number; recipeCount: number; memberCount: number };

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * The first confirm. `households` is null when the members couldn't be fetched: then it says only
 * what's true for everyone, without the per-household lines.
 */
export function deleteAccountConfirmation(households: HouseholdForDeletion[] | null): { title: string; message: string } {
  const lines = ["This can't be undone. Your account, your aisle order and your settings will be deleted."];
  if (households) {
    for (const h of households.filter((h) => h.memberCount <= 1)) {
      lines.push(
        `${h.name} and its ${plural(h.listCount, 'list')} and ${plural(h.recipeCount, 'recipe')} will be deleted, because you're its only member.`,
      );
    }
    const shared = households.filter((h) => h.memberCount > 1).map((h) => h.name);
    if (shared.length > 0) {
      lines.push(`Your lists and recipes in ${shared.join(', ')} stay with ${shared.length === 1 ? 'its' : 'their'} other members.`);
    }
  }
  return { title: 'Delete your account?', message: lines.join('\n\n') };
}

/** The second confirm, so one mis-tap can't delete the account. */
export const DELETE_ACCOUNT_SECOND_CONFIRM = { title: 'Are you sure?', message: 'Your account will be deleted now.' };
export const DELETE_ACCOUNT_OFFLINE = { title: "You're offline", message: 'Connect to the internet to delete your account.' };
export const DELETE_ACCOUNT_FAILED = { title: "Couldn't delete your account", message: 'Nothing was deleted. Try again later.' };
export const DELETING_ACCOUNT = 'Deleting your account…';
export const ACCOUNT_DELETED_TOAST = 'Your account was deleted.';

/** True when the OS says there's no connection. Unknown counts as online: the call finds out. */
export async function isOffline(): Promise<boolean> {
  let state: NetworkState;
  try {
    state = await getNetworkStateAsync();
  } catch {
    return false;
  }
  return !isOnline(state);
}

/**
 * The user's local households with their counts and member counts (`get_household_members`), for
 * the confirm. Null when any household's members can't be fetched (offline, or a household the
 * server doesn't have yet).
 */
export async function householdsForDeletion(userId: string): Promise<HouseholdForDeletion[] | null> {
  const rows = householdsWithCountsQuery().all();
  try {
    return await Promise.all(
      rows.map(async (h) => ({
        name: h.name,
        listCount: Number(h.listCount),
        recipeCount: Number(h.recipeCount),
        memberCount: (await fetchHouseholdMembers(h.id, userId)).length,
      })),
    );
  } catch {
    return null;
  }
}

/** How long the pending outbox gets to go up before the account is deleted anyway. */
export const PUSH_BEFORE_DELETE_MS = 3000;

export class DeleteAccountError extends Error {
  constructor(readonly kind: 'offline' | 'failed', message: string) {
    super(message);
    this.name = 'DeleteAccountError';
  }
}

let deletedNotice = false;

/** True once after a deletion: the sign-in screen shows `ACCOUNT_DELETED_TOAST`. */
export function takeAccountDeletedNotice(): boolean {
  const notice = deletedNotice;
  deletedNotice = false;
  return notice;
}

/**
 * Deletes the signed-in user's account: pushes pending changes (best effort), calls
 * `delete_account`, then wipes the device and signs out locally and of Google, which lands on
 * sign-in. Throws a `DeleteAccountError` when offline or when the server refuses or can't be
 * reached; then nothing local has changed.
 */
export async function deleteAccount(options: { pushTimeoutMs?: number } = {}): Promise<void> {
  if (await isOffline()) throw new DeleteAccountError('offline', 'offline');
  await pushBriefly(options.pushTimeoutMs ?? PUSH_BEFORE_DELETE_MS);
  let error: unknown;
  try {
    ({ error } = await supabase.rpc('delete_account'));
  } catch (err) {
    error = err;
  }
  if (error) {
    const message = (error as { message?: unknown }).message;
    throw new DeleteAccountError('failed', typeof message === 'string' && message ? message : 'delete_account failed');
  }
  // The account is gone on the server: whatever happens here, the device must end up signed out.
  try {
    wipeLocalData();
  } catch (err) {
    console.error('[delete-account] wipe failed', err);
  }
  deletedNotice = true;
  await signOutLocally();
}
