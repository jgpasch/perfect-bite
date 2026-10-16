import { eq } from 'drizzle-orm';

import type { ItemRowStyle } from '@/components/appearance';
import { db, deviceSettings } from '@/db';
import {
  AISLE_COLORS_KEY,
  ITEM_ROW_STYLE_KEY,
  manualOrderEntries,
  manualOrderKey,
  readAisleColorStyle,
  readItemRowStyle,
  readManualOrder,
  type AisleColorStyle,
  type ManualOrderEntry,
  type NewestItem,
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

/** A list's manual As added order on this device (none if never saved or unreadable). */
export function getManualOrder(listId: string): ManualOrderEntry[] {
  return readManualOrder(getDeviceSetting<unknown>(manualOrderKey(listId), null));
}

/**
 * Saves the order on screen after a drop (`visibleIds`, top first) as the list's manual order, keeping
 * the entries for checked `items`. Returns what it saved.
 */
export function saveManualOrder(listId: string, visibleIds: readonly string[], items: readonly NewestItem[]): ManualOrderEntry[] {
  const entries = manualOrderEntries(visibleIds, items, getManualOrder(listId));
  setDeviceSetting(manualOrderKey(listId), entries);
  return entries;
}

/** Forgets the list's manual order, back to plain As added. */
export function clearManualOrder(listId: string): void {
  clearDeviceSetting(manualOrderKey(listId));
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

/** The meal plan's Agenda or Grid (spec 4.16), the same on the Plan tab and in Recipes: Grid unless changed on this device. */
export const PLAN_VIEW_KEY = 'plan.view';
export type PlanView = 'agenda' | 'grid';

export function getPlanView(): PlanView {
  return getDeviceSetting<unknown>(PLAN_VIEW_KEY, 'grid') === 'agenda' ? 'agenda' : 'grid';
}

export function setPlanView(view: PlanView): void {
  setDeviceSetting(PLAN_VIEW_KEY, view);
}

/**
 * Settings > Meal plan > Plan tab (spec 4.16): off unless turned on on this device. Off, the week lives in
 * Recipes under This week.
 */
export const PLAN_TAB_KEY = 'plan.tab';
const planTabListeners = new Set<() => void>();

export function getPlanTab(): boolean {
  return getDeviceSetting<unknown>(PLAN_TAB_KEY, false) === true;
}

export function setPlanTab(on: boolean): void {
  setDeviceSetting(PLAN_TAB_KEY, on);
  planTabListeners.forEach((listener) => listener());
}

/** Calls `listener` whenever Plan tab is changed, so the tab bar and Recipes follow it at once. */
export function onPlanTabChange(listener: () => void): () => void {
  planTabListeners.add(listener);
  return () => void planTabListeners.delete(listener);
}

/** The household whose plan this device shows (spec 4.16), or null if never picked. */
export const PLAN_HOUSEHOLD_KEY = 'plan.householdId';

export function getPlanHouseholdId(): string | null {
  const value = getDeviceSetting<unknown>(PLAN_HOUSEHOLD_KEY, null);
  return typeof value === 'string' ? value : null;
}

export function setPlanHouseholdId(householdId: string): void {
  setDeviceSetting(PLAN_HOUSEHOLD_KEY, householdId);
}
