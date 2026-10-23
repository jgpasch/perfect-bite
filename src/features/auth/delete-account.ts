// Deleting your own account from Settings (spec 4.8). The server does the work (`delete_account`),
// so it needs a connection; afterwards the device keeps nothing of the user's (`wipeLocalData`).
import { getNetworkStateAsync, type NetworkState } from 'expo-network';

import { signOutLocally } from '@/features/auth/account';
import { wipeLocalData } from '@/features/auth/local-wipe';
import { pushBriefly } from '@/features/auth/sign-out';
import { isOnline } from '@/features/categories/catch-up';
import { fetchHouseholdMembers, householdsWithCountsQuery } from '@/features/households/households';
import { i18n, onLanguageChanged } from '@/i18n';
import { reportError } from '@/lib/sentry';
import { supabase } from '@/lib/supabase';

/** One of the user's households, for the confirm: its counts and how many members it has. */
export type HouseholdForDeletion = { name: string; listCount: number; recipeCount: number; memberCount: number };

/**
 * The first confirm. `households` is null when the members couldn't be fetched: then it says only
 * what's true for everyone, without the per-household lines.
 */
export function deleteAccountConfirmation(households: HouseholdForDeletion[] | null): { title: string; message: string } {
  const lines = [i18n.t('account.confirmMessage')];
  if (households) {
    for (const h of households.filter((h) => h.memberCount <= 1)) {
      lines.push(
        i18n.t('account.onlyMember', {
          name: h.name,
          lists: i18n.t('households.lists', { count: h.listCount }),
          recipes: i18n.t('households.recipes', { count: h.recipeCount }),
        }),
      );
    }
    const shared = households.filter((h) => h.memberCount > 1).map((h) => h.name);
    if (shared.length > 0) lines.push(i18n.t('account.shared', { names: shared.join(', '), count: shared.length }));
  }
  return { title: i18n.t('account.confirmTitle'), message: lines.join('\n\n') };
}

type AlertText = { title: string; message: string };

// Live bindings, in the app's language.
/** The second confirm, so one mis-tap can't delete the account. */
export let DELETE_ACCOUNT_SECOND_CONFIRM: AlertText = { title: '', message: '' };
export let DELETE_ACCOUNT_OFFLINE: AlertText = { title: '', message: '' };
export let DELETE_ACCOUNT_FAILED: AlertText = { title: '', message: '' };
export let ACCOUNT_DELETED_TOAST = '';
onLanguageChanged(() => {
  DELETE_ACCOUNT_SECOND_CONFIRM = { title: i18n.t('account.sureTitle'), message: i18n.t('account.sureMessage') };
  DELETE_ACCOUNT_OFFLINE = { title: i18n.t('common.offline'), message: i18n.t('account.offlineMessage') };
  DELETE_ACCOUNT_FAILED = { title: i18n.t('account.failedTitle'), message: i18n.t('account.failedMessage') };
  ACCOUNT_DELETED_TOAST = i18n.t('account.deleted');
});

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
    reportError(err, { area: 'account', event: 'delete_wipe_failed' });
  }
  deletedNotice = true;
  await signOutLocally();
}
