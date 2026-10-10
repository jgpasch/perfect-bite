import { Redirect } from 'expo-router';
import { useState } from 'react';

import { useAccountState } from '@/features/auth/account';
import { getLaunchListId } from '@/features/lists/lists';

// Only the first time `/` shows in this process is a cold launch; later visits (after signing in
// again) go to the Lists home as before.
let launched = false;

// The app launches at `/`, which no screen matches. Signed in, a cold launch opens the last list
// (spec 4.1) with the Lists home under it (`withAnchor` loads the root's initial `(tabs)` route
// first), so Back goes to "Your lists". Otherwise the default tab, or sign-in with no account yet.
export default function Index() {
  const account = useAccountState();
  const [listId] = useState(() => {
    const coldLaunch = !launched;
    launched = true;
    return coldLaunch && account.status === 'ready' ? getLaunchListId(account.account.userId) : null;
  });
  if (account.status !== 'ready') return <Redirect href="/sign-in" />;
  if (listId) return <Redirect href={{ pathname: '/list/[id]', params: { id: listId } }} withAnchor />;
  return <Redirect href="/lists" />;
}
