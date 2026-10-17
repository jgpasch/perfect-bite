// Settings > Notifications' store (spec 4.13): reading and upserting the user's notification_settings
// row with the device's time zone, quiet-hours checks, and re-sending the time zone on foreground.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AppState, type AppStateStatus } from 'react-native';

import { queries, queriesFor, resetSupabase, respondTo } from '@/test/fake-supabase';
import { resetDb } from '@/test/db';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';

import {
  dateAt,
  DEFAULT_NOTIFICATION_SETTINGS,
  deviceTimeZone,
  fetchNotificationSettings,
  getNotificationSettingsState,
  hourMinuteOf,
  loadNotificationSettings,
  QuietHoursError,
  resetNotificationSettings,
  SAVED_TIME_ZONE_KEY,
  saveNotificationSettings,
  savedTimeZone,
  settingsFromRow,
  startTimeZoneSync,
  syncTimeZone,
  toHourMinute,
  updateNotificationSettings,
  validQuietHours,
} from '../settings';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
const mockAccount: { userId: string | null } = { userId: 'user-1' };
jest.mock('@/features/auth/account', () => ({
  getAccount: () => (mockAccount.userId ? { userId: mockAccount.userId, email: 'jo@example.com' } : null),
}));

let timeZone = 'America/Mexico_City';
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  resetDb();
  resetSupabase();
  resetNotificationSettings();
  mockAccount.userId = 'user-1';
  timeZone = 'America/Mexico_City';
  jest
    .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
    .mockImplementation(() => ({ timeZone }) as Intl.ResolvedDateTimeFormatOptions);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

const upserts = () => queriesFor('notification_settings').filter((q) => q.ops[0][0] === 'upsert');

describe('helpers', () => {
  it('reads the device time zone, falling back to UTC', () => {
    expect(deviceTimeZone()).toBe('America/Mexico_City');
    timeZone = '';
    expect(deviceTimeZone()).toBe('UTC');
  });

  it("turns Postgres' times into HH:MM and rejects anything else", () => {
    expect(toHourMinute('22:00:00')).toBe('22:00');
    expect(toHourMinute('07:30')).toBe('07:30');
    expect(toHourMinute('23:59:59.5')).toBe('23:59');
    expect(toHourMinute('24:00:00')).toBeNull();
    expect(toHourMinute('12:60')).toBeNull();
    expect(toHourMinute('7:30')).toBeNull();
    expect(toHourMinute('')).toBeNull();
    expect(toHourMinute(null)).toBeNull();
  });

  it('allows quiet hours only when the start is not the end', () => {
    expect(validQuietHours({ start: '22:00', end: '07:00' })).toBe(true);
    expect(validQuietHours({ start: '07:00', end: '22:00' })).toBe(true);
    expect(validQuietHours({ start: '22:00', end: '22:00' })).toBe(false);
    expect(validQuietHours({ start: '22:00', end: '22:00:00' })).toBe(false);
    expect(validQuietHours({ start: 'late', end: '07:00' })).toBe(false);
  });

  it('converts between pickers and HH:MM in the device time', () => {
    const today = new Date(2026, 9, 17, 15, 45, 12);
    const date = dateAt('06:05', today);
    expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()]).toEqual([
      2026, 9, 17, 6, 5, 0,
    ]);
    expect(hourMinuteOf(date)).toBe('06:05');
    expect(hourMinuteOf(new Date(2026, 0, 1, 23, 9))).toBe('23:09');
    expect(hourMinuteOf(dateAt('nonsense', today))).toBe('00:00');
  });

  it('maps a row, and no row means the defaults', () => {
    expect(settingsFromRow(null)).toEqual({ itemsAdded: true, shopping: true, quietHours: null });
    expect(
      settingsFromRow({ items_added: false, shopping: true, quiet_hours_start: '22:30:00', quiet_hours_end: '06:45:00' }),
    ).toEqual({ itemsAdded: false, shopping: true, quietHours: { start: '22:30', end: '06:45' } });
    // A half-set pair is off.
    expect(
      settingsFromRow({ items_added: true, shopping: false, quiet_hours_start: '22:00:00', quiet_hours_end: null }),
    ).toEqual({ itemsAdded: true, shopping: false, quietHours: null });
  });
});

describe('fetchNotificationSettings', () => {
  it("reads the user's own row", async () => {
    respondTo('notification_settings', {
      data: { items_added: true, shopping: false, quiet_hours_start: '21:00:00', quiet_hours_end: '08:00:00' },
    });
    expect(await fetchNotificationSettings()).toEqual({
      itemsAdded: true,
      shopping: false,
      quietHours: { start: '21:00', end: '08:00' },
    });
    expect(queriesFor('notification_settings')[0].ops).toEqual([
      ['select', 'items_added, shopping, quiet_hours_start, quiet_hours_end'],
      ['eq', 'user_id', 'user-1'],
      ['maybeSingle'],
    ]);
  });

  it('gives the defaults when there is no row', async () => {
    respondTo('notification_settings', { data: null });
    expect(await fetchNotificationSettings()).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });

  it('throws on an error, and when signed out', async () => {
    respondTo('notification_settings', { error: { message: 'offline' } });
    await expect(fetchNotificationSettings()).rejects.toEqual({ message: 'offline' });
    mockAccount.userId = null;
    await expect(fetchNotificationSettings()).rejects.toThrow('not signed in');
  });
});

describe('saveNotificationSettings', () => {
  it('upserts the whole row with the time zone, and remembers the zone', async () => {
    await saveNotificationSettings({ itemsAdded: false, shopping: true, quietHours: { start: '22:00', end: '07:00' } });
    expect(upserts()[0].ops).toEqual([
      [
        'upsert',
        {
          user_id: 'user-1',
          items_added: false,
          shopping: true,
          quiet_hours_start: '22:00',
          quiet_hours_end: '07:00',
          time_zone: 'America/Mexico_City',
        },
        { onConflict: 'user_id' },
      ],
    ]);
    expect(getDeviceSetting(SAVED_TIME_ZONE_KEY, null)).toEqual({ userId: 'user-1', timeZone: 'America/Mexico_City' });
  });

  it('sends nulls for quiet hours turned off', async () => {
    await saveNotificationSettings({ itemsAdded: true, shopping: true, quietHours: null });
    expect(upserts()[0].ops[0][1]).toMatchObject({ quiet_hours_start: null, quiet_hours_end: null });
  });

  it('refuses quiet hours that start when they end, sending nothing', async () => {
    await expect(
      saveNotificationSettings({ itemsAdded: true, shopping: true, quietHours: { start: '07:00', end: '07:00' } }),
    ).rejects.toBeInstanceOf(QuietHoursError);
    expect(queries).toHaveLength(0);
  });

  it("throws the server's error and doesn't remember the zone", async () => {
    respondTo('notification_settings', { error: { message: 'invalid time zone', code: '22023' } });
    await expect(saveNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS)).rejects.toEqual({
      message: 'invalid time zone',
      code: '22023',
    });
    expect(getDeviceSetting(SAVED_TIME_ZONE_KEY, null)).toBeNull();
  });
});

describe('the time zone following the device', () => {
  it('sends only the time zone the first time, then not again while it is unchanged', async () => {
    expect(await syncTimeZone()).toBe(true);
    expect(upserts()[0].ops).toEqual([
      ['upsert', { user_id: 'user-1', time_zone: 'America/Mexico_City' }, { onConflict: 'user_id' }],
    ]);
    expect(await syncTimeZone()).toBe(false);
    expect(upserts()).toHaveLength(1);
  });

  it('sends a new zone after travelling', async () => {
    await syncTimeZone();
    timeZone = 'Asia/Tokyo';
    expect(await syncTimeZone()).toBe(true);
    expect(upserts()[1].ops[0][1]).toEqual({ user_id: 'user-1', time_zone: 'Asia/Tokyo' });
    expect(savedTimeZone('user-1')).toBe('Asia/Tokyo');
  });

  it("sends it again for another user, as the saved zone was someone else's", async () => {
    setDeviceSetting(SAVED_TIME_ZONE_KEY, { userId: 'user-2', timeZone: 'America/Mexico_City' });
    expect(savedTimeZone('user-1')).toBeNull();
    expect(await syncTimeZone()).toBe(true);
  });

  it('keeps trying after a failure, and never throws', async () => {
    respondTo('notification_settings', { error: { message: 'Failed to fetch' } });
    expect(await syncTimeZone()).toBe(false);
    expect(savedTimeZone('user-1')).toBeNull();
    expect(await syncTimeZone()).toBe(true);
  });

  it('does nothing signed out', async () => {
    mockAccount.userId = null;
    expect(await syncTimeZone()).toBe(false);
    expect(queries).toHaveLength(0);
  });

  it('runs on start and on each return to the foreground', async () => {
    let onChange: ((next: AppStateStatus) => void) | undefined;
    const remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      onChange = listener as (next: AppStateStatus) => void;
      return { remove } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
    Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
    const stop = startTimeZoneSync();
    await flush();
    expect(upserts()).toHaveLength(1);

    // Back from the background, same zone: nothing sent.
    onChange?.('background');
    onChange?.('active');
    await flush();
    expect(upserts()).toHaveLength(1);

    timeZone = 'Europe/Madrid';
    onChange?.('background');
    onChange?.('active');
    await flush();
    expect(upserts()).toHaveLength(2);
    expect(upserts()[1].ops[0][1]).toEqual({ user_id: 'user-1', time_zone: 'Europe/Madrid' });

    stop();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('the store', () => {
  it('loads, and shows failed when it cannot', async () => {
    expect(getNotificationSettingsState()).toEqual({ status: 'loading' });
    respondTo('notification_settings', { error: { message: 'offline' } });
    await loadNotificationSettings();
    expect(getNotificationSettingsState()).toEqual({ status: 'failed' });
    respondTo('notification_settings', { data: { items_added: false, shopping: true, quiet_hours_start: null, quiet_hours_end: null } });
    await loadNotificationSettings();
    expect(getNotificationSettingsState()).toEqual({
      status: 'ready',
      saving: false,
      settings: { itemsAdded: false, shopping: true, quietHours: null },
    });
  });

  it('keeps loaded settings when a reload fails', async () => {
    await loadNotificationSettings();
    respondTo('notification_settings', { error: { message: 'offline' } });
    await loadNotificationSettings();
    expect(getNotificationSettingsState()).toMatchObject({ status: 'ready', settings: DEFAULT_NOTIFICATION_SETTINGS });
  });

  it('shows a change at once and saves it', async () => {
    await loadNotificationSettings();
    const saving = updateNotificationSettings({ shopping: false });
    expect(getNotificationSettingsState()).toEqual({
      status: 'ready',
      saving: true,
      settings: { itemsAdded: true, shopping: false, quietHours: null },
    });
    await saving;
    expect(getNotificationSettingsState()).toMatchObject({ saving: false, settings: { shopping: false } });
    expect(upserts()[0].ops[0][1]).toMatchObject({ shopping: false, items_added: true, time_zone: 'America/Mexico_City' });
  });

  it('puts a change back when the save fails, and rethrows', async () => {
    await loadNotificationSettings();
    respondTo('notification_settings', { error: { message: 'Failed to fetch' } });
    await expect(updateNotificationSettings({ itemsAdded: false })).rejects.toEqual({ message: 'Failed to fetch' });
    expect(getNotificationSettingsState()).toEqual({ status: 'ready', saving: false, settings: DEFAULT_NOTIFICATION_SETTINGS });
  });

  it('changes nothing for quiet hours that start when they end', async () => {
    await loadNotificationSettings();
    await expect(updateNotificationSettings({ quietHours: { start: '22:00', end: '22:00' } })).rejects.toBeInstanceOf(
      QuietHoursError,
    );
    expect(getNotificationSettingsState()).toEqual({ status: 'ready', saving: false, settings: DEFAULT_NOTIFICATION_SETTINGS });
    expect(upserts()).toHaveLength(0);
  });

  it("can't change settings that haven't loaded", async () => {
    await expect(updateNotificationSettings({ shopping: false })).rejects.toThrow('not loaded');
    expect(upserts()).toHaveLength(0);
  });
});
