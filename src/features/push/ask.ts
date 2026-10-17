// Asking once at a good moment (spec 4.13): the first time the user shares a household with someone
// (they accepted an invite, or a pull or Realtime shows a household-mate joined one that was just
// theirs), the app offers to turn notifications on, once per device whatever the answer. Never at
// launch or on sign-in: those fill the member cache from empty, which isn't a moment.
import { useSyncExternalStore } from 'react';

import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';

/** Device setting: true once the prompt has shown. */
export const PUSH_ASKED_KEY = 'push.asked';

export function pushAsked(): boolean {
  return getDeviceSetting<unknown>(PUSH_ASKED_KEY, false) === true;
}

export function setPushAsked(): void {
  setDeviceSetting(PUSH_ASKED_KEY, true);
}

let pending = false;
const listeners = new Set<() => void>();

function setPending(next: boolean) {
  if (pending === next) return;
  pending = next;
  for (const listener of listeners) listener();
}

/** A moment to ask: the user now shares a household. Ignored once the prompt has shown. */
export function notePushMoment(): void {
  try {
    if (pushAsked()) return;
  } catch (err) {
    console.warn('[push] reading push.asked failed', err);
    return;
  }
  setPending(true);
}

/** Whether a moment is waiting for the prompt to take it. */
export function pushMomentPending(): boolean {
  return pending;
}

/** Takes the waiting moment (the prompt shows, or it isn't needed). */
export function clearPushMoment(): void {
  setPending(false);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePushMomentPending(): boolean {
  return useSyncExternalStore(subscribe, pushMomentPending);
}

/**
 * Whether a refresh of a household's members is the moment: the device already knew the household
 * with only `userId` in it, and now someone else is in it too. An empty `before` (sign-in, a
 * household just pulled in) is not.
 */
export function householdMateJoined(before: readonly string[], after: readonly string[], userId: string | null): boolean {
  if (!userId || before.length === 0) return false;
  return before.every((id) => id === userId) && after.some((id) => id !== userId);
}
