import { addNetworkStateListener, getNetworkStateAsync } from 'expo-network';
import { useEffect, useState } from 'react';

import { isOnline } from '@/features/categories/catch-up';

/** Online until the OS says otherwise; follows connectivity changes. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    let live = true;
    getNetworkStateAsync()
      .then((state) => live && setOnline(isOnline(state)))
      .catch(() => {});
    const subscription = addNetworkStateListener((state) => setOnline(isOnline(state)));
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);
  return online;
}
