import { useEffect, useMemo, type ReactNode } from 'react';

import { useAccountState } from '@/features/auth/account';
import { loadCatalogSeed } from '@/features/categories/categories';
import { registerHouseholds } from '@/features/households/households';
import { ensureStarterData } from '@/features/lists/lists';
import { backfillUnitUsage, backfillUsage } from '@/features/lists/usage';

/**
 * Local data every screen expects: the bundled catalog (spec 6.2), the one-time ingredient
 * history and unit backfills (spec 4.2) and, once signed in, the user's starter household and list (then
 * registered on the server, in the background). Render
 * inside DatabaseProvider. Runs during render (every step is idempotent and fast) so no screen
 * ever sees the data missing.
 */
export function AppDataGate({ children }: { children: ReactNode }) {
  const account = useAccountState();
  const userId = account.status === 'ready' ? account.account.userId : null;
  useMemo(() => {
    loadCatalogSeed();
    backfillUsage();
    backfillUnitUsage();
    if (userId) ensureStarterData(userId);
  }, [userId]);
  // Async and online, so it runs after render. TODO(M5): sync replaces this.
  useEffect(() => {
    if (userId) void registerHouseholds(userId);
  }, [userId]);
  return children;
}
