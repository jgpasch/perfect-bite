import { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

import { clearDeviceSetting, getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';

/**
 * The + hint (spec 4.1): a one-time callout above the tab bar's +, "Hold + for more ways to add". It comes up
 * after the third tap on +, the next time add mode ends on a list, and never once the long-press menu was
 * opened. Device state, not synced.
 */
export const ADD_TAP_COUNT_KEY = 'tabBar.addTapCount';
export const ADD_HINT_SEEN_KEY = 'tabBar.addHintSeen';
/** Taps on + before the hint shows. The count stops here. */
export const ADD_HINT_TAP_THRESHOLD = 3;
/** The hint goes by itself after this long. */
export const ADD_HINT_TIMEOUT_MS = 8000;

export type AddHintState = {
  tapCount: number;
  seen: boolean;
  screenReaderOn: boolean;
  /** A sheet is over the list. */
  sheetOpen: boolean;
  /** The list is in Select mode. */
  selecting: boolean;
};

/** Whether add mode ending should show the hint. */
export function shouldShowAddHint({ tapCount, seen, screenReaderOn, sheetOpen, selecting }: AddHintState): boolean {
  return tapCount >= ADD_HINT_TAP_THRESHOLD && !seen && !screenReaderOn && !sheetOpen && !selecting;
}

function getTapCount(): number {
  const count = getDeviceSetting<unknown>(ADD_TAP_COUNT_KEY, 0);
  return typeof count === 'number' ? count : 0;
}

function getSeen(): boolean {
  return getDeviceSetting<unknown>(ADD_HINT_SEEN_KEY, false) === true;
}

let visible = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function setVisible(next: boolean) {
  if (timer) clearTimeout(timer);
  timer = next ? setTimeout(dismissAddHint, ADD_HINT_TIMEOUT_MS) : null;
  if (visible === next) return;
  visible = next;
  listeners.forEach((listener) => listener());
}

/** A tap on + (not a long-press). */
export function countAddTap(): void {
  const count = getTapCount();
  if (count < ADD_HINT_TAP_THRESHOLD) setDeviceSetting(ADD_TAP_COUNT_KEY, count + 1);
}

/** The long-press menu was opened, or the hint dismissed: it never shows again, and goes if it's up. */
export function markAddHintSeen(): void {
  if (!getSeen()) setDeviceSetting(ADD_HINT_SEEN_KEY, true);
  setVisible(false);
}

/** A tap anywhere, a long-press on +, or the timeout. */
export function dismissAddHint(): void {
  if (visible) markAddHintSeen();
}

/** What's over the list right now. */
export type AddHintContext = { sheetOpen: boolean; selecting: boolean };

/**
 * Add mode ended on a list (the add field lost focus and the bar hid): shows the hint if it's due. With
 * VoiceOver on, which offers "More ways to add" on + already, it's marked seen instead. `context` is read
 * again after asking VoiceOver: the blur can come before Select mode or a sheet shows on screen.
 */
export async function addModeEnded(context: () => AddHintContext): Promise<void> {
  const state = () => ({ tapCount: getTapCount(), seen: getSeen(), ...context() });
  // Nothing to ask VoiceOver about if the hint isn't due anyway.
  if (!shouldShowAddHint({ ...state(), screenReaderOn: false })) return;
  const screenReaderOn = await AccessibilityInfo.isScreenReaderEnabled();
  if (screenReaderOn) markAddHintSeen();
  else if (shouldShowAddHint({ ...state(), screenReaderOn })) setVisible(true);
}

/** Settings > Developer > Show the + hint again: it shows after the next add. */
export function resetAddHint(): void {
  clearDeviceSetting(ADD_HINT_SEEN_KEY);
  setDeviceSetting(ADD_TAP_COUNT_KEY, ADD_HINT_TAP_THRESHOLD);
}

export function isAddHintVisible(): boolean {
  return visible;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Whether the hint is up, for the tab bar. */
export function useAddHintVisible(): boolean {
  return useSyncExternalStore(subscribe, isAddHintVisible);
}
