import { useMemo, type ReactNode } from 'react';

import { useAccountState } from '@/features/auth/account';
import { loadCatalogSeed } from '@/features/categories/categories';
import { ensureStarterData } from '@/features/lists/lists';
import { backfillUsage } from '@/features/lists/usage';

/**
 * Local data every screen expects: the bundled catalog (spec 6.2), the one-time ingredient
 * history backfill (spec 4.2) and, once signed in, the user's starter household and list. Render
 * inside DatabaseProvider. Runs during render (every step is idempotent and fast) so no screen
 * ever sees the data missing.
 */
export function AppDataGate({ children }: { children: ReactNode }) {
  const account = useAccountState();
  const userId = account.status === 'ready' ? account.account.userId : null;
  useMemo(() => {
    loadCatalogSeed();
    backfillUsage();
    if (userId) ensureStarterData(userId);
  }, [userId]);
  return children;
}
