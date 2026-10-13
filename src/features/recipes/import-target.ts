// Where a queued or failed share imports to (spec 4.10): onto a list, or recipe-only into a
// household. The share drain and the imports card's Try again both resolve it here, so a share
// whose list or household is gone by then falls back the same way.
import { eq } from 'drizzle-orm';

import { db, households } from '@/db';
import { getDefaultListId, getList } from '@/features/lists/lists';
import { siriTargetListId } from '@/features/siri/drain';

import type { ImportTarget } from './import';

/** Where a share asked to go: a list (null: the default list), or recipe-only into a household. */
export type RequestedTarget =
  | { addToList: true; listId: string | null }
  | { addToList: false; householdId: string | null };

/**
 * The live target for `requested`: its list if it's live and not archived, else the default list;
 * for a recipe-only share, its household if the user is still in it, else the default list's
 * household. Null when there's nowhere to import (no lists at all).
 */
export function resolveImportTarget(requested: RequestedTarget, userId: string): ImportTarget | null {
  if (requested.addToList) {
    const listId = siriTargetListId({ listId: requested.listId }, userId);
    return listId ? { listId } : null;
  }
  const kept = requested.householdId
    ? db.select({ id: households.id }).from(households).where(eq(households.id, requested.householdId)).get()
    : undefined;
  if (kept) return { householdId: kept.id };
  const defaultListId = getDefaultListId(userId);
  const fallback = defaultListId ? getList(defaultListId)?.householdId : undefined;
  return fallback ? { householdId: fallback } : null;
}

/** A resolved target as `failed_imports` keeps it: the list and its household, or the household alone. */
export function recordedTarget(target: ImportTarget): { householdId: string | null; listId: string | null } {
  if (target.listId) return { householdId: getList(target.listId)?.householdId ?? null, listId: target.listId };
  return { householdId: target.householdId ?? null, listId: null };
}

/**
 * What a `failed_imports` row asks for: a household with no list is recipe-only; anything else goes
 * on its list, or the default list for rows recorded before targets were kept.
 */
export function requestedFromRecord(row: { householdId: string | null; listId: string | null }): RequestedTarget {
  if (row.householdId && !row.listId) return { addToList: false, householdId: row.householdId };
  return { addToList: true, listId: row.listId };
}
