import { beforeEach, expect, jest, test } from '@jest/globals';

import { resetDb } from '@/test/db';

import {
  KEEP_SCREEN_ON_KEY,
  getDeviceSetting,
  getKeepScreenOn,
  onKeepScreenOnChange,
  setDeviceSetting,
  setKeepScreenOn,
} from '../device-settings';

jest.mock('@/db/client', () => require('@/test/db'));

beforeEach(() => resetDb());

test('returns the fallback until a value is set', () => {
  expect(getDeviceSetting('list.abc.viewMode', 'category')).toBe('category');
});

test('stores JSON values and overwrites on set', () => {
  setDeviceSetting('list.abc.viewMode', 'recipe');
  setDeviceSetting('list.abc.viewMode', 'category');
  setDeviceSetting('flags', { a: 1 });
  expect(getDeviceSetting('list.abc.viewMode', 'x')).toBe('category');
  expect(getDeviceSetting('flags', {})).toEqual({ a: 1 });
});

test('Keep screen on defaults on, persists, and tells listeners', () => {
  expect(getKeepScreenOn()).toBe(true);
  const listener = jest.fn();
  const stop = onKeepScreenOnChange(listener);
  setKeepScreenOn(false);
  expect(getKeepScreenOn()).toBe(false);
  expect(getDeviceSetting(KEEP_SCREEN_ON_KEY, null)).toBe(false);
  expect(listener).toHaveBeenCalledTimes(1);
  setKeepScreenOn(true);
  expect(getKeepScreenOn()).toBe(true);
  expect(listener).toHaveBeenCalledTimes(2);
  stop();
  setKeepScreenOn(false);
  expect(listener).toHaveBeenCalledTimes(2);
});

test('Keep screen on reads anything but a stored false as on', () => {
  setDeviceSetting(KEEP_SCREEN_ON_KEY, 'garbage');
  expect(getKeepScreenOn()).toBe(true);
  setDeviceSetting(KEEP_SCREEN_ON_KEY, 0);
  expect(getKeepScreenOn()).toBe(true);
});
