import { useEffect, useMemo, type ReactNode } from 'react';

import { useAccountState } from '@/features/auth/account';
import { ensureMissingIngredients, loadCatalogSeed } from '@/features/categories/categories';
import { startCatchUpTriggers } from '@/features/categories/catch-up';
import { categorizePending, startCategorizeOnGain } from '@/features/categories/categorization';
import { clearFeatures, startFeatures } from '@/features/plans/load';
import { startMyInvites } from '@/features/households/my-invites';
import { ensureStarterData } from '@/features/lists/lists';
import { backfillUnitUsage, backfillUsage } from '@/features/lists/usage';
import { shareAttemptsKey, startShareDrain } from '@/features/recipes/share-drain';
import { startSiriDrain } from '@/features/siri/drain';
import { clearSiriListSnapshot, startListSnapshot } from '@/features/siri/list-snapshot';
import { pullNow, startPull } from '@/sync/pull';
import { pushNow, startPush } from '@/sync/push';
import { startRealtime } from '@/sync/realtime';
// TEMP one-shot: drop the stuck share envelope. Remove after it runs.
import { File } from 'expo-file-system';
import { clearDeviceSetting } from '@/features/settings/device-settings';
import { getAppGroupContainer } from '@/features/siri/app-group';
function dropStuckShare() {
  const STUCK_SHARE_ID = '01a12dbd-9404-7d9d-ad3b-7f5dddabae35';
  try {
    const root = getAppGroupContainer();
    if (!root) return;
    const file = new File(root, `share/pending/${STUCK_SHARE_ID}.json`);
    const existed = file.exists;
    if (existed) file.delete();
    clearDeviceSetting(shareAttemptsKey(STUCK_SHARE_ID));
    console.warn(`[TEMP] stuck share ${STUCK_SHARE_ID}: ${existed ? 'deleted' : 'not found'}`);
  } catch (e) {
    console.warn('[TEMP] stuck share cleanup failed', e);
  }
}

/**
 * Local data every screen expects: the bundled catalog (spec 6.2), pending rows for names it
 * doesn't know (spec 6.3), the one-time ingredient
 * history and unit backfills (spec 4.2) and, once signed in and pulled, the user's starter household
 * and list if they have none (written through the outbox, so the push creates them on the server).
 * Render inside DatabaseProvider. The local steps run during render (each is idempotent and fast) so
 * no screen ever sees the catalog missing.
 */
export function AppDataGate({ children }: { children: ReactNode }) {
  const account = useAccountState();
  const userId = account.status === 'ready' ? account.account.userId : null;
  useMemo(() => {
    dropStuckShare(); // TEMP
    loadCatalogSeed();
    ensureMissingIngredients();
    backfillUsage();
    backfillUnitUsage();
  }, []);
  // Plan features (spec 4.12): loaded on sign-in, foreground and reconnect, cached for offline
  // launches, cleared on sign-out. Before the catch-up below, so it goes by the cached plan.
  // Gaining `categorize` runs the catch-up for leftover names.
  useEffect(() => (userId ? startFeatures(userId) : undefined), [userId]);
  useEffect(() => {
    if (account.status === 'signedOut') clearFeatures();
  }, [account.status]);
  useEffect(() => startCategorizeOnGain(), []);
  // Categorization catch-up (spec 6.3): after the pending rows above exist, again on sign-in, and on
  // every foreground and reconnect.
  useEffect(() => {
    void categorizePending();
  }, [userId]);
  useEffect(() => startCatchUpTriggers(() => void categorizePending()), []);
  // Push (spec 7.2): after writes, on foreground and reconnect, and on sign-in.
  useEffect(() => startPush(), []);
  useEffect(() => {
    if (userId) void pushNow({ force: true });
  }, [userId]);
  // Pull (spec 7.2): on launch, foreground, reconnect and sign-in. The starter household waits for
  // the sign-in pull, so an account that already has households (another device, a reinstall)
  // gets those instead of a new one. Offline, the pull is skipped and the starter is made anyway.
  useEffect(() => startPull(), []);
  useEffect(() => {
    if (userId) void pullNow().then(() => ensureStarterData(userId));
  }, [userId]);
  // Realtime (spec 7.2): live changes while signed in and in the foreground.
  useEffect(() => (userId ? startRealtime(userId) : undefined), [userId]);
  // Invites sent to the user's email (spec 4.7): fetched on sign-in, foreground and reconnect;
  // cleared on sign-out.
  useEffect(() => (userId ? startMyInvites() : undefined), [userId]);
  // Siri's list snapshot (spec 4.9): on launch and when lists, memberships or the default list
  // change; deleted on sign-out so Siri offers no lists.
  const signedOut = account.status === 'signedOut';
  useEffect(() => {
    if (userId) return startListSnapshot(userId);
    if (signedOut) clearSiriListSnapshot();
  }, [userId, signedOut]);
  // Siri's queue (spec 4.9): applied on launch, foreground and sign-in; signed out, adds wait.
  useEffect(() => (userId ? startSiriDrain(userId) : undefined), [userId]);
  // The share queue (spec 4.10): imported on launch, foreground, reconnect and sign-in; signed out, shares wait.
  useEffect(() => (userId ? startShareDrain(userId) : undefined), [userId]);
  return children;
}
