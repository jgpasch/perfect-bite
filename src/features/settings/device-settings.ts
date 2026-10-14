import { eq } from 'drizzle-orm';

import type { ItemRowStyle } from '@/components/appearance';
import { db, deviceSettings } from '@/db';
import {
  AISLE_COLORS_KEY,
  ITEM_ROW_STYLE_KEY,
  readAisleColorStyle,
  readItemRowStyle,
  type AisleColorStyle,
} from '@/features/lists/list-view';

/** Reads a per-device setting (spec 4.6), or `fallback` if it was never set. */
export function getDeviceSetting<T>(key: string, fallback: T): T {
  const row = db.select().from(deviceSettings).where(eq(deviceSettings.key, key)).get();
  return row ? (row.value as T) : fallback;
}

export function setDeviceSetting<T>(key: string, value: T): void {
  db.insert(deviceSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: deviceSettings.key, set: { value } })
    .run();
}

/** Forgets a per-device setting, so `getDeviceSetting` gives its fallback again. */
export function clearDeviceSetting(key: string): void {
  db.delete(deviceSettings).where(eq(deviceSettings.key, key)).run();
}

/** Settings > Aisle colours on this device. */
export function getAisleColorStyle(): AisleColorStyle {
  return readAisleColorStyle(getDeviceSetting<unknown>(AISLE_COLORS_KEY, null));
}

export function setAisleColorStyle(style: AisleColorStyle): void {
  setDeviceSetting(AISLE_COLORS_KEY, style);
}

/** Settings > Aisle colours > Item rows on this device. */
export function getItemRowStyle(): ItemRowStyle {
  return readItemRowStyle(getDeviceSetting<unknown>(ITEM_ROW_STYLE_KEY, null));
}

export function setItemRowStyle(style: ItemRowStyle): void {
  setDeviceSetting(ITEM_ROW_STYLE_KEY, style);
}

/** Settings > Shopping > Keep screen on (spec 4.1): on unless turned off on this device. */
export const KEEP_SCREEN_ON_KEY = 'list.keepScreenOn';
const keepScreenOnListeners = new Set<() => void>();

export function getKeepScreenOn(): boolean {
  return getDeviceSetting<unknown>(KEEP_SCREEN_ON_KEY, true) !== false;
}

export function setKeepScreenOn(on: boolean): void {
  setDeviceSetting(KEEP_SCREEN_ON_KEY, on);
  keepScreenOnListeners.forEach((listener) => listener());
}

/** Calls `listener` whenever Keep screen on is changed, so an open list follows it at once. */
export function onKeepScreenOnChange(listener: () => void): () => void {
  keepScreenOnListeners.add(listener);
  return () => void keepScreenOnListeners.delete(listener);
}

/** Settings > Shopping > Always show checked items (spec 4.6): off unless turned on on this device. */
export const ALWAYS_SHOW_CHECKED_KEY = 'list.alwaysShowChecked';

export function getAlwaysShowChecked(): boolean {
  return getDeviceSetting<unknown>(ALWAYS_SHOW_CHECKED_KEY, false) === true;
}

export function setAlwaysShowChecked(on: boolean): void {
  setDeviceSetting(ALWAYS_SHOW_CHECKED_KEY, on);
}
