import { beforeEach, expect, jest, test } from '@jest/globals';

import { manualOrderKey } from '@/features/lists/list-view';
import { resetDb } from '@/test/db';

import {
  KEEP_SCREEN_ON_KEY,
  clearManualOrder,
  getDeviceSetting,
  getKeepScreenOn,
  getManualOrder,
  onKeepScreenOnChange,
  saveManualOrder,
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

const t = (minutes: number) => new Date(Date.UTC(2026, 9, 10, 9, minutes));
const orderItem = (id: string, minutes: number, checked = false) => ({
  id,
  createdAt: t(0),
  checkedAt: checked ? t(59) : null,
  contributions: [{ id: `c-${id}`, createdAt: t(minutes) }],
});

test('saveManualOrder saves the order on screen and getManualOrder reads it back', () => {
  const items = [orderItem('milk', 1), orderItem('eggs', 2), orderItem('bread', 3)];
  const saved = saveManualOrder('abc', ['milk', 'bread', 'eggs'], items);
  expect(saved).toEqual([
    { id: 'milk', at: t(1).getTime() },
    { id: 'bread', at: t(3).getTime() },
    { id: 'eggs', at: t(2).getTime() },
  ]);
  expect(getDeviceSetting(manualOrderKey('abc'), null)).toEqual(saved);
  expect(getManualOrder('abc')).toEqual(saved);
  expect(getManualOrder('other')).toEqual([]);
});

test('saveManualOrder keeps a checked item’s entry from the last save, and drops a deleted one', () => {
  saveManualOrder('abc', ['milk', 'eggs', 'bread', 'jam'], [orderItem('milk', 1), orderItem('eggs', 2), orderItem('bread', 3), orderItem('jam', 4)]);
  // Eggs is checked off and Jam deleted; then Bread is dragged to the top.
  const items = [orderItem('milk', 1), orderItem('eggs', 2, true), orderItem('bread', 3)];
  expect(saveManualOrder('abc', ['bread', 'milk'], items)).toEqual([
    { id: 'bread', at: t(3).getTime() },
    { id: 'milk', at: t(1).getTime() },
    { id: 'eggs', at: t(2).getTime() },
  ]);
});

test('clearManualOrder forgets the order, and only that list’s', () => {
  const items = [orderItem('milk', 1), orderItem('eggs', 2)];
  saveManualOrder('abc', ['milk', 'eggs'], items);
  saveManualOrder('xyz', ['eggs', 'milk'], items);
  clearManualOrder('abc');
  expect(getManualOrder('abc')).toEqual([]);
  expect(getDeviceSetting(manualOrderKey('abc'), null)).toBeNull();
  expect(getManualOrder('xyz').map((e) => e.id)).toEqual(['eggs', 'milk']);
});

test('getManualOrder reads garbage in storage as no order', () => {
  setDeviceSetting(manualOrderKey('abc'), 'garbage');
  expect(getManualOrder('abc')).toEqual([]);
});
