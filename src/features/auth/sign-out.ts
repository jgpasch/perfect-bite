// Signing out (spec 4.8): the device keeps nothing of the user's, so the next account to sign in
// on it starts from its own data, not the last user's households and lists.
import { signOut } from '@/features/auth/account';
import { wipeLocalData } from '@/features/auth/local-wipe';
import { reportError } from '@/lib/sentry';
import { getPullState, whenIdle as pullIdle } from '@/sync/pull';
import { pushNow, whenIdle as pushIdle } from '@/sync/push';
import { stopRealtime } from '@/sync/realtime';

/** How long the pending outbox gets to go up before signing out (or deleting the account) anyway. */
export const PUSH_BEFORE_SIGN_OUT_MS = 3000;

/** Pushes the outbox, so the user's last changes reach the server; gives up after `ms`. Never throws. */
export async function pushBriefly(ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([pushNow({ force: true }).catch(() => {}), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stops Realtime and waits for any push or pull still running, so none of them writes the user's
 * rows or cursors after the wipe that follows (they drop their work once the user has changed).
 */
export async function stopSync(): Promise<void> {
  stopRealtime();
  await Promise.all([pushIdle(), pullIdle()]);
}

/**
 * Settings > Sign out: pushes pending changes (best effort), signs out of Supabase and Google, then
 * waits for sync to stop and wipes the device. Throws if Supabase refuses the sign-out; then
 * nothing local has changed.
 */
export async function signOutAndWipe(options: { pushTimeoutMs?: number } = {}): Promise<void> {
  await pushBriefly(options.pushTimeoutMs ?? PUSH_BEFORE_SIGN_OUT_MS);
  await signOut();
  await stopSync();
  wipeLocalData();
}

/**
 * Runs before an account becomes ready: if this device's data was synced for another user (a
 * sign-out that didn't wipe, or one from before sign-out wiped), wipes it first. Never throws.
 */
export function wipeIfOtherUser(userId: string): void {
  try {
    const owner = getPullState().userId;
    if (owner && owner !== userId) {
      console.info(`[account] this device holds another user's data; wiping it before ${userId} signs in`);
      wipeLocalData();
    }
  } catch (err) {
    console.error('[account] checking or wiping the last user’s data failed', err);
    reportError(err, { area: 'account', event: 'other_user_wipe_failed' });
  }
}
