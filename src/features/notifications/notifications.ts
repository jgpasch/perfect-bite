// In-app notifications (spec 4.11): banners that drop in at the top of the screen when something the
// user started finishes while they're doing something else. Features post them with `notify`; the
// NotificationHost in the root layout shows the first one and dismisses it. Kept in memory only.

import { useSyncExternalStore } from 'react';

import type { IconName } from '@/components/icon';
import type { AisleHue } from '@/domain/aisle-color';

/** One per use case, so per-kind settings (spec 11.1) can switch them off later. */
export type NotificationKind = 'recipeImport';

export type AppNotification = {
  /** Posting the same id again replaces the notification in place. */
  id: string;
  kind: NotificationKind;
  /** The icon tile's glyph and hue. */
  icon: IconName;
  hue: AisleHue;
  /** The haptic when it appears. */
  tone: 'success' | 'warning';
  title: string;
  body?: string;
  /** Part of the body to set in bold, e.g. the recipe's name. */
  emphasis?: string;
  /** VoiceOver's hint for what tapping does, e.g. "Opens Groceries". */
  hint?: string;
  /** Tapping the banner runs this, then dismisses it. */
  onPress?: () => void;
};

// The first is showing; the rest wait their turn.
let queue: readonly AppNotification[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Queues a notification, or replaces the queued or showing one with the same id. */
export function notify(notification: AppNotification): void {
  const index = queue.findIndex((n) => n.id === notification.id);
  queue = index === -1 ? [...queue, notification] : queue.with(index, notification);
  emit();
}

/** Takes a notification off the queue (the banner timed out, was swiped away or tapped). */
export function dismissNotification(id: string): void {
  const next = queue.filter((n) => n.id !== id);
  if (next.length === queue.length) return;
  queue = next;
  emit();
}

/** Drops every notification, e.g. on sign-out. */
export function clearNotifications(): void {
  if (queue.length === 0) return;
  queue = [];
  emit();
}

/** The notification to show, or null. */
export function currentNotification(): AppNotification | null {
  return queue[0] ?? null;
}

export function onNotificationsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The notification to show, live. */
export function useCurrentNotification(): AppNotification | null {
  return useSyncExternalStore(onNotificationsChange, currentNotification);
}
