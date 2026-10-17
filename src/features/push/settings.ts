// Settings > Notifications (spec 4.13): the user's row in `notification_settings`, read and written
// online (no outbox, no sync), held in a small store the screen renders from. Every save also sends
// the device's time zone, and `startTimeZoneSync` re-sends it on foreground when it has changed, so
// quiet hours follow the phone when travelling.
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { getAccount } from '@/features/auth/account';
import { cameToForeground } from '@/features/categories/catch-up';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { supabase } from '@/lib/supabase';

/** Quiet hours as local `HH:MM` times; a start later than the end wraps past midnight. */
export type QuietHours = { start: string; end: string };

export type NotificationSettings = {
  itemsAdded: boolean;
  shopping: boolean;
  /** Null = off. */
  quietHours: QuietHours | null;
};

/** What a user with no row gets (the table's defaults). */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = { itemsAdded: true, shopping: true, quietHours: null };

/** Where quiet hours start when they're first turned on. */
export const DEFAULT_QUIET_HOURS: QuietHours = { start: '22:00', end: '07:00' };

/** Device setting: the time zone last saved, and for whom, so a foreground only re-sends a change. */
export const SAVED_TIME_ZONE_KEY = 'push.timeZone';

type SettingsRow = {
  items_added: boolean;
  shopping: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
};

/** The device's IANA time zone ("America/Mexico_City"), or UTC if the runtime doesn't say. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** `HH:MM` from Postgres' `HH:MM:SS` (or `HH:MM`); null for anything else. */
export function toHourMinute(value: string | null | undefined): string | null {
  const match = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value ?? '');
  if (!match) return null;
  const [h, m] = [Number(match[1]), Number(match[2])];
  return h < 24 && m < 60 ? `${match[1]}:${match[2]}` : null;
}

/** Quiet hours the server takes: both times well formed, and the start isn't the end. */
export function validQuietHours(quietHours: QuietHours): boolean {
  const start = toHourMinute(quietHours.start);
  const end = toHourMinute(quietHours.end);
  return start !== null && end !== null && start !== end;
}

/** A picker's time as `HH:MM` in the device's time. */
export function hourMinuteOf(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Today at `HH:MM` in the device's time, for a picker's selection. */
export function dateAt(hourMinute: string, today = new Date()): Date {
  const [h, m] = (toHourMinute(hourMinute) ?? '00:00').split(':').map(Number);
  const date = new Date(today);
  date.setHours(h, m, 0, 0);
  return date;
}

export function settingsFromRow(row: SettingsRow | null | undefined): NotificationSettings {
  if (!row) return DEFAULT_NOTIFICATION_SETTINGS;
  const start = toHourMinute(row.quiet_hours_start);
  const end = toHourMinute(row.quiet_hours_end);
  return {
    itemsAdded: row.items_added,
    shopping: row.shopping,
    quietHours: start && end ? { start, end } : null,
  };
}

/** Thrown for quiet hours that start when they end; nothing is saved. */
export class QuietHoursError extends Error {
  constructor() {
    super('Quiet hours must start and end at different times');
    this.name = 'QuietHoursError';
  }
}

/** The signed-in user's settings (the defaults when they have no row). Throws when it can't load. */
export async function fetchNotificationSettings(): Promise<NotificationSettings> {
  const userId = getAccount()?.userId;
  if (!userId) throw new Error('not signed in');
  const { data, error } = await supabase
    .from('notification_settings')
    .select('items_added, shopping, quiet_hours_start, quiet_hours_end')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return settingsFromRow(data as SettingsRow | null);
}

function rememberTimeZone(userId: string, timeZone: string) {
  setDeviceSetting(SAVED_TIME_ZONE_KEY, { userId, timeZone });
}

/** The time zone last saved for `userId` on this device, if any. */
export function savedTimeZone(userId: string): string | null {
  const value = getDeviceSetting<unknown>(SAVED_TIME_ZONE_KEY, null) as { userId?: unknown; timeZone?: unknown } | null;
  return value && value.userId === userId && typeof value.timeZone === 'string' ? value.timeZone : null;
}

/** Upserts the user's whole row, with the device's time zone. Throws on failure or bad quiet hours. */
export async function saveNotificationSettings(settings: NotificationSettings): Promise<void> {
  if (settings.quietHours && !validQuietHours(settings.quietHours)) throw new QuietHoursError();
  const userId = getAccount()?.userId;
  if (!userId) throw new Error('not signed in');
  const timeZone = deviceTimeZone();
  const { error } = await supabase.from('notification_settings').upsert(
    {
      user_id: userId,
      items_added: settings.itemsAdded,
      shopping: settings.shopping,
      quiet_hours_start: settings.quietHours?.start ?? null,
      quiet_hours_end: settings.quietHours?.end ?? null,
      time_zone: timeZone,
    },
    { onConflict: 'user_id' },
  );
  if (error) throw error;
  rememberTimeZone(userId, timeZone);
}

/**
 * Sends the device's time zone when it differs from the one last saved for this user (or none was).
 * Only `time_zone` is written, so the other settings stay as they are (a new row gets the defaults).
 * Returns whether it saved. Never throws: a failure is retried on the next foreground.
 */
export async function syncTimeZone(): Promise<boolean> {
  const userId = getAccount()?.userId;
  if (!userId) return false;
  const timeZone = deviceTimeZone();
  try {
    if (savedTimeZone(userId) === timeZone) return false;
    const { error } = await supabase
      .from('notification_settings')
      .upsert({ user_id: userId, time_zone: timeZone }, { onConflict: 'user_id' });
    if (error) throw error;
    rememberTimeZone(userId, timeZone);
    return true;
  } catch (err) {
    console.warn('[push] saving the time zone failed', err);
    return false;
  }
}

/** While signed in: the time zone now and on every return to the foreground. Returns a stop function. */
export function startTimeZoneSync(): () => void {
  void syncTimeZone();
  let appState = AppState.currentState;
  const app = AppState.addEventListener('change', (next) => {
    if (cameToForeground(appState, next)) void syncTimeZone();
    appState = next;
  });
  return () => app.remove();
}

// --- The screen's store ------------------------------------------------------------------------

export type NotificationSettingsState =
  | { status: 'loading' }
  /** Couldn't load (offline, or the server failed): the screen shows the defaults, disabled. */
  | { status: 'failed' }
  | { status: 'ready'; settings: NotificationSettings; saving: boolean };

let state: NotificationSettingsState = { status: 'loading' };
const listeners = new Set<() => void>();

function setState(next: NotificationSettingsState) {
  state = next;
  for (const listener of listeners) listener();
}

export function getNotificationSettingsState(): NotificationSettingsState {
  return state;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The store, live. */
export function useNotificationSettings(): NotificationSettingsState {
  return useSyncExternalStore(subscribe, getNotificationSettingsState);
}

let loadRun = 0;

/** (Re)loads the settings from the server. A screen already showing settings keeps them on failure. */
export async function loadNotificationSettings(): Promise<void> {
  const run = ++loadRun;
  if (state.status !== 'ready') setState({ status: 'loading' });
  try {
    const settings = await fetchNotificationSettings();
    if (run === loadRun) setState({ status: 'ready', settings, saving: false });
  } catch (err) {
    console.warn('[push] loading the notification settings failed', err);
    if (run === loadRun && state.status !== 'ready') setState({ status: 'failed' });
  }
}

/**
 * Applies `patch` at once and saves it. A failed save (offline included) puts the settings back and
 * rethrows, so the screen can say so; a `QuietHoursError` changes nothing at all.
 */
export async function updateNotificationSettings(patch: Partial<NotificationSettings>): Promise<void> {
  if (state.status !== 'ready') throw new Error('notification settings not loaded');
  const before = state.settings;
  const next = { ...before, ...patch };
  if (next.quietHours && !validQuietHours(next.quietHours)) throw new QuietHoursError();
  loadRun++; // a load still running would overwrite this change
  setState({ status: 'ready', settings: next, saving: true });
  try {
    await saveNotificationSettings(next);
    if (state.status === 'ready' && state.settings === next) setState({ status: 'ready', settings: next, saving: false });
  } catch (err) {
    if (state.status === 'ready' && state.settings === next) setState({ status: 'ready', settings: before, saving: false });
    throw err;
  }
}

/** Forgets the loaded settings (sign-out, tests). */
export function resetNotificationSettings(): void {
  loadRun++;
  setState({ status: 'loading' });
}
