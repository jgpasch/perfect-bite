import { Redirect } from 'expo-router';

import { useAccountState } from '@/features/auth/account';

// The app launches at `/`, which no screen matches; send it to the default tab,
// or to sign-in when there's no account yet.
export default function Index() {
  const account = useAccountState();
  return <Redirect href={account.status === 'ready' ? '/lists' : '/sign-in'} />;
}
