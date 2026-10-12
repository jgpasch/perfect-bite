import { eq } from 'drizzle-orm';

import { db, deviceSettings } from '@/db';
import { AISLE_COLORS_KEY, readAisleColorStyle, type AisleColorStyle } from '@/features/lists/list-view';

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
