import { Redirect } from 'expo-router';

import { useAccountState } from '@/features/auth/account';
import { ToListTab } from '@/features/lists/to-list-tab';

// The app launches at `/`, which no screen matches. Signed in, it opens the List tab, which shows the
// current list (spec 4.1); otherwise sign-in.
export default function Index() {
  const account = useAccountState();
  if (account.status !== 'ready') return <Redirect href="/sign-in" />;
  return <ToListTab />;
}
