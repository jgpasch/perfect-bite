import { useEffect, useMemo, type ReactNode } from 'react';

import { useAccountState } from '@/features/auth/account';
import { ensureMissingIngredients, loadCatalogSeed } from '@/features/categories/categories';
import { startCatchUpTriggers } from '@/features/categories/catch-up';
import { categorizePending } from '@/features/categories/categorization';
import { ensureStarterData } from '@/features/lists/lists';
import { backfillUnitUsage, backfillUsage } from '@/features/lists/usage';
import { startSiriDrain } from '@/features/siri/drain';
import { clearSiriListSnapshot, startListSnapshot } from '@/features/siri/list-snapshot';
import { pullNow, startPull } from '@/sync/pull';
import { pushNow, startPush } from '@/sync/push';
import { startRealtime } from '@/sync/realtime';

/**
 * Local data every screen expects: the bundled catalog (spec 6.2), pending rows for names it
 * doesn't know (spec 6.3), the one-time ingredient
 * history and unit backfills (spec 4.2) and, once signed in, the user's starter household and list
 * (written through the outbox, so the push creates them on the server). Render
 * inside DatabaseProvider. Runs during render (every step is idempotent and fast) so no screen
 * ever sees the data missing.
 */
export function AppDataGate({ children }: { children: ReactNode }) {
  const account = useAccountState();
  const userId = account.status === 'ready' ? account.account.userId : null;
  useMemo(() => {
    loadCatalogSeed();
    ensureMissingIngredients();
    backfillUsage();
    backfillUnitUsage();
    if (userId) ensureStarterData(userId);
  }, [userId]);
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
  // Pull (spec 7.2): on launch, foreground, reconnect and sign-in.
  useEffect(() => startPull(), []);
  useEffect(() => {
    if (userId) void pullNow();
  }, [userId]);
  // Realtime (spec 7.2): live changes while signed in and in the foreground.
  useEffect(() => (userId ? startRealtime(userId) : undefined), [userId]);
  // Siri's list snapshot (spec 4.9): on launch and when lists, memberships or the default list
  // change; deleted on sign-out so Siri offers no lists.
  const signedOut = account.status === 'signedOut';
  useEffect(() => {
    if (userId) return startListSnapshot(userId);
    if (signedOut) clearSiriListSnapshot();
  }, [userId, signedOut]);
  // Siri's queue (spec 4.9): applied on launch, foreground and sign-in; signed out, adds wait.
  useEffect(() => (userId ? startSiriDrain(userId) : undefined), [userId]);
  return children;
}
