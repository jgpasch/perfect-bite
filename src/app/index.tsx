import { Redirect } from 'expo-router';

import { useAccountState } from '@/features/auth/account';

// The app launches at `/`, which no screen matches. Signed in, it opens the List tab, which shows the
// current list (spec 4.1); otherwise sign-in.
export default function Index() {
  const account = useAccountState();
  if (account.status !== 'ready') return <Redirect href="/sign-in" />;
  return <Redirect href="/lists" />;
}
