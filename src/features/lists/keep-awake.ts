import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { getKeepScreenOn, onKeepScreenOnChange } from '@/features/settings/device-settings';

/**
 * Whether the user is still shopping on list `listId` at `pathname` (spec 4.1): the List tab, one of
 * this list's own sheets (edit item, edit list, add to recipe), or the Your lists sheet over it.
 * Another tab, a pushed screen or a sheet for something else is not.
 */
export function shoppingOnList(pathname: string, listId: string): boolean {
  return pathname === '/lists' || pathname === '/lists-sheet' || pathname.startsWith(`/list/${listId}/`);
}

/** Settings > Shopping > Keep screen on, kept current while it's switched. */
export function useKeepScreenOnSetting(): boolean {
  return useSyncExternalStore(onKeepScreenOnChange, getKeepScreenOn);
}

function isForeground(state: AppStateStatus): boolean {
  return state !== 'background';
}

/**
 * Keeps the screen from auto-locking while `wanted` (a list on screen with items to get), the app is
 * in the foreground and Keep screen on is on; otherwise the system's normal auto-lock applies.
 */
export function useKeepListAwake(listId: string, wanted: boolean): void {
  // One tag per list screen, so two mounted screens can't release each other's lock.
  useKeepAwake(`list:${listId}:${useId()}`, wanted);
}

/**
 * Keeps the screen on under `tag` while `wanted`, the app is in the foreground and Keep screen on is on.
 * Each screen passes its own tag, so one closing doesn't release another's lock.
 */
export function useKeepAwake(tag: string, wanted: boolean): void {
  const setting = useKeepScreenOnSetting();
  const [foreground, setForeground] = useState(() => isForeground(AppState.currentState));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setForeground(isForeground(state)));
    return () => subscription.remove();
  }, []);
  const on = wanted && setting && foreground;
  useEffect(() => {
    if (!on) return;
    // Best effort: a device that can't keep the screen on just locks as usual.
    activateKeepAwakeAsync(tag).catch(() => {});
    return () => void deactivateKeepAwake(tag).catch(() => {});
  }, [on, tag]);
}
