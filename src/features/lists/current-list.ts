import { router } from 'expo-router';
import { useSyncExternalStore } from 'react';

import { getAccount } from '@/features/auth/account';
import { launchListId } from '@/features/lists/list-view';
import { getDefaultListId, getList, LAST_OPENED_LIST_KEY } from '@/features/lists/lists';
import { getDeviceSetting } from '@/features/settings/device-settings';
import { recordListOpened } from '@/features/siri/list-snapshot';

/**
 * The List tab shows the current list (spec 4.1): the one last shown on this device
 * (`lastOpenedListId`), else the default list, else the first. The device setting is the source of
 * truth; this store only tells the tab to re-read it when another screen picks a list.
 */
let version = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes whenever a list is picked, so the List tab re-resolves the current list. */
export function useCurrentListVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** The current list among `open` (the unarchived lists, in order), or null when there are none. */
export function resolveCurrentListId(open: readonly { id: string }[], userId: string | null): string | null {
  const lastOpenedId = getDeviceSetting<string | null>(LAST_OPENED_LIST_KEY, null);
  // A list picked the moment it was made (New list in Your lists) isn't in `open` until the caller's
  // live query re-runs. Falling back meanwhile would let the old list's focus effect re-record itself.
  if (lastOpenedId !== null && !open.some((l) => l.id === lastOpenedId) && getList(lastOpenedId)?.archivedAt === null) {
    return lastOpenedId;
  }
  const defaultId = userId && open.length > 0 ? getDefaultListId(userId) : null;
  return launchListId(lastOpenedId, defaultId, open);
}

/** Makes `listId` the current list, without navigating. */
export function setCurrentList(listId: string): void {
  recordListOpened(listId, getAccount()?.userId ?? null);
  version++;
  listeners.forEach((l) => l());
}

/** Makes `listId` the current list and shows the List tab. */
export function openList(listId: string): void {
  setCurrentList(listId);
  router.navigate('/lists');
}
