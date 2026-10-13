// Lists (spec 4.1): local reads, and writes through the sync helpers (outbox, spec 7.1).
import { and, asc, eq, isNull, max, sql } from 'drizzle-orm';

import { db, households, listItems, lists, userSettings, type List } from '@/db';
import type { ListHue } from '@/domain/aisle-color';
import { positionBetween, positionForMove } from '@/domain/position';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { newId } from '@/lib/id';
import { insertRow, updateRows, upsertRow } from '@/sync/mutate';

import { launchListId } from './list-view';

const live = isNull(lists.deletedAt);

/**
 * First run: a personal household with a "Groceries" list, which is also the default list.
 * Written through the outbox, so the push creates the household on the server (`create_household`).
 * Called after the sign-in pull (AppDataGate), so an account's existing households count.
 */
export function ensureStarterData(userId: string): void {
  db.transaction((tx) => {
    if (tx.select({ id: households.id }).from(households).limit(1).get()) return;
    const householdId = newId();
    const listId = newId();
    insertRow(tx, households, { id: householdId, name: 'Personal' });
    insertRow(tx, lists, { id: listId, householdId, name: 'Groceries', position: 1 });
    upsertRow(tx, userSettings, { userId, defaultListId: listId }, { defaultListId: listId });
  });
}

/** The household new lists go in. M7 asks which household when there is more than one. */
function currentHouseholdId(): string {
  const row = db.select({ id: households.id }).from(households).orderBy(asc(households.createdAt)).get();
  if (!row) throw new Error('No household yet (ensureStarterData has not run)');
  return row.id;
}

/**
 * Live lists (archived ones too, with `archivedAt` set) in the user's order, each with its household
 * and its unchecked item count.
 */
export function listsWithCountsQuery() {
  return db
    .select({
      id: lists.id,
      name: lists.name,
      householdId: lists.householdId,
      householdName: households.name,
      emoji: lists.emoji,
      color: lists.color,
      position: lists.position,
      archivedAt: lists.archivedAt,
      uncheckedCount: sql<number>`count(${listItems.id})`,
    })
    .from(lists)
    .innerJoin(households, eq(households.id, lists.householdId))
    .leftJoin(
      listItems,
      and(eq(listItems.listId, lists.id), isNull(listItems.deletedAt), isNull(listItems.checkedAt)),
    )
    .where(live)
    .groupBy(lists.id)
    .orderBy(asc(lists.position));
}
export type ListSummary = Awaited<ReturnType<typeof listsWithCountsQuery>>[number];

export function listQuery(id: string) {
  return db.select().from(lists).where(and(eq(lists.id, id), live));
}

export function getList(id: string): List | undefined {
  return listQuery(id).get();
}

/** Adds a list at the end, in `householdId` (default: the first household). */
export function createList(name: string, householdId?: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('A list needs a name');
  const id = newId();
  const last = db.select({ position: max(lists.position) }).from(lists).where(live).get();
  insertRow(db, lists, {
    id,
    householdId: householdId ?? currentHouseholdId(),
    name: trimmed,
    position: positionBetween(last?.position ?? null, null),
  });
  return id;
}

export function renameList(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  updateRows(db, lists, eq(lists.id, id), { name: trimmed });
}

/** Sets the list's colour, or `null` for Default. Shared with the household like its name. */
export function setListColor(id: string, hue: ListHue | null): void {
  updateRows(db, lists, eq(lists.id, id), { color: hue });
}

export function setListArchived(id: string, archived: boolean): void {
  updateRows(db, lists, eq(lists.id, id), { archivedAt: archived ? new Date() : null });
}

/** Soft-deletes the list. Its items go with it (they are only reachable through the list). */
export function deleteList(id: string): void {
  updateRows(db, lists, eq(lists.id, id), { deletedAt: new Date() });
}

/**
 * Moves a non-archived list from index `from` to index `to` in the visible order. Writes one row.
 * `visible` is the order the user sees (positions ascending).
 */
export function moveList(visible: readonly Pick<List, 'id' | 'position'>[], from: number, to: number): void {
  if (from === to || !visible[from]) return;
  const position = positionForMove(
    visible.map((l) => l.position),
    from,
    to,
  );
  updateRows(db, lists, eq(lists.id, visible[from].id), { position });
}

// --- Default list (Siri, spec 4.1) ---------------------------------------------------------

export function setDefaultList(userId: string, listId: string): void {
  upsertRow(db, userSettings, { userId, defaultListId: listId }, { defaultListId: listId });
}

/**
 * The user's default list: the chosen one if it is still live and not archived, else the first
 * remaining list. Resolved on read, so deleting or archiving the default needs no extra write.
 */
export function getDefaultListId(userId: string): string | null {
  const chosen = db
    .select({ id: lists.id })
    .from(userSettings)
    .innerJoin(lists, eq(lists.id, userSettings.defaultListId))
    .where(and(eq(userSettings.userId, userId), live, isNull(lists.archivedAt)))
    .get();
  if (chosen) return chosen.id;
  const first = db
    .select({ id: lists.id })
    .from(lists)
    .where(and(live, isNull(lists.archivedAt)))
    .orderBy(asc(lists.position))
    .get();
  return first?.id ?? null;
}

// --- Launch (spec 4.1) ---------------------------------------------------------------------

/** Device setting: the list screen that last gained focus. */
export const LAST_OPENED_LIST_KEY = 'lastOpenedListId';

export function setLastOpenedList(listId: string): void {
  setDeviceSetting(LAST_OPENED_LIST_KEY, listId);
}

/** The list a cold launch opens, or null when there are none. Archived lists don't count. */
export function getLaunchListId(userId: string): string | null {
  const open = db
    .select({ id: lists.id })
    .from(lists)
    .where(and(live, isNull(lists.archivedAt)))
    .orderBy(asc(lists.position))
    .all();
  return launchListId(getDeviceSetting<string | null>(LAST_OPENED_LIST_KEY, null), getDefaultListId(userId), open);
}
