// The list snapshot Siri reads (spec 4.9): every list across the user's households, plus the
// default list. Written on launch and whenever lists, memberships or the default list change.
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { addDatabaseChangeListener } from 'expo-sqlite';

import { households, lists, userSettings } from '@/db';
import { getDefaultListId, LAST_OPENED_LIST_KEY, listsWithCountsQuery, setLastOpenedList } from '@/features/lists/lists';
import { getDeviceSetting } from '@/features/settings/device-settings';
import type { ListSnapshot } from '@/shared';

import { clearListSnapshot, getAppGroupContainer, writeListSnapshot } from './app-group';

export type SnapshotListRow = {
  id: string;
  name: string;
  householdName: string;
  archivedAt: Date | null;
};

/**
 * The snapshot for `rows` (live lists in the user's order). Archived lists are left out, as Siri
 * can't add to them; `defaultListId` and `lastOpenedListId` are kept only if that list is offered.
 */
export function buildListSnapshot(
  rows: readonly SnapshotListRow[],
  defaultListId: string | null,
  lastOpenedListId: string | null = null,
): ListSnapshot {
  const offered = rows
    .filter((l) => !l.archivedAt)
    .map(({ id, name, householdName }) => ({ id, name, householdName }));
  const isOffered = (id: string | null): id is string => !!id && offered.some((l) => l.id === id);
  const snapshot: ListSnapshot = { lastOpenedListId: isOffered(lastOpenedListId) ? lastOpenedListId : null, lists: offered };
  if (isOffered(defaultListId)) snapshot.defaultListId = defaultListId;
  return snapshot;
}

export type SiriListChoice = { id: string; name: string; householdName?: string; selected: boolean };

/**
 * Rows for the "Siri adds to" picker: the lists Siri offers, with the household named only when
 * there is more than one, and the default ticked.
 */
export function siriListChoices(snapshot: ListSnapshot): SiriListChoice[] {
  const several = new Set(snapshot.lists.map((l) => l.householdName)).size > 1;
  return snapshot.lists.map((l) => ({
    id: l.id,
    name: l.name,
    ...(several ? { householdName: l.householdName } : {}),
    selected: l.id === snapshot.defaultListId,
  }));
}

/** The snapshot from SQLite (every household on this device is one the user belongs to). */
export function currentListSnapshot(userId: string): ListSnapshot {
  return buildListSnapshot(
    listsWithCountsQuery().all(),
    getDefaultListId(userId),
    getDeviceSetting<string | null>(LAST_OPENED_LIST_KEY, null),
  );
}

/** Tables whose changes can change the snapshot: lists, memberships (households), the default list. */
export const SNAPSHOT_TABLES = [lists, households, userSettings].map((t) => getTableConfig(t).name);

let lastWritten: string | null = null;

/**
 * Writes the current snapshot if it changed since the last write. Never throws: without the App
 * Group (Expo Go, tests) it does nothing, and a failed write is logged.
 */
export function syncListSnapshot(userId: string): void {
  if (!getAppGroupContainer()) return;
  try {
    const snapshot = currentListSnapshot(userId);
    const json = JSON.stringify(snapshot);
    if (json === lastWritten) return;
    writeListSnapshot(snapshot);
    lastWritten = json;
  } catch (err) {
    console.warn('[siri] writing the list snapshot failed', err);
  }
}

/**
 * A list screen gained focus: remember it for the next launch (spec 4.1) and rewrite the snapshot,
 * so the share extension defaults to it (spec 4.10).
 */
export function recordListOpened(listId: string, userId: string | null): void {
  setLastOpenedList(listId);
  if (userId) syncListSnapshot(userId);
}

/** Deletes the snapshot (sign-out). Never throws. */
export function clearSiriListSnapshot(): void {
  lastWritten = null;
  try {
    clearListSnapshot();
  } catch (err) {
    console.warn('[siri] clearing the list snapshot failed', err);
  }
}

const DEBOUNCE_MS = 250;

/**
 * Writes the snapshot now, then again after changes to `SNAPSHOT_TABLES` (debounced, so a pull
 * writes once). Returns a stop function.
 */
export function startListSnapshot(userId: string): () => void {
  syncListSnapshot(userId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listener = addDatabaseChangeListener(({ tableName }) => {
    if (!SNAPSHOT_TABLES.includes(tableName)) return;
    clearTimeout(timer);
    timer = setTimeout(() => syncListSnapshot(userId), DEBOUNCE_MS);
  });
  return () => {
    clearTimeout(timer);
    listener.remove();
  };
}
