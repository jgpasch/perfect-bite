// Failed in-app imports (spec 4.10), kept on the device only and shown on the Recipes tab with Try
// again and Dismiss until one of them clears it. Failed shares are server state (share-reconcile.ts).
import { desc, eq } from 'drizzle-orm';

import { db, failedImports, type FailedImportReason } from '@/db';
import { limitResetsAt } from '@/features/plans/limits';
import { i18n } from '@/i18n';
import { newId } from '@/lib/id';

import { importRecipe, type ImportRecipeResult } from './import';
import { importLimitMessage, NOT_ENTITLED_MESSAGE } from './import-sheet';
import { requestedFromRecord, resolveImportTarget } from './import-target';
/** An in-app import that failed (spec 4.10), and where it was going, so Try again goes there too. */
export type FailedImportRecord = {
  url: string;
  /** The page title, when there was one. */
  title: string | null;
  reason: FailedImportReason;
  /** A list and its household, or a household alone (recipe-only). Absent or null: the default list. */
  householdId?: string | null;
  listId?: string | null;
};

/** Records an import that won't go through, and where it was going. Returns its id. */
export function recordFailedImport(failed: FailedImportRecord): string {
  const id = newId();
  db.insert(failedImports)
    .values({
      id,
      url: failed.url,
      title: failed.title,
      reason: failed.reason,
      householdId: failed.householdId ?? null,
      listId: failed.listId ?? null,
    })
    .run();
  return id;
}

/** Failed imports, newest first. */
export function failedImportsQuery() {
  return db.select().from(failedImports).orderBy(desc(failedImports.createdAt), desc(failedImports.id));
}

export function dismissFailedImport(id: string): void {
  db.delete(failedImports).where(eq(failedImports.id, id)).run();
}

const retrying = new Set<string>();

/**
 * Imports a failed import again, where it was going: recipe-only into its household, or onto its
 * list, falling back to the default list when that's gone; rows recorded before targets were kept go
 * to `userId`'s default list. Success removes it; another failure keeps it with the new reason. With
 * nowhere to import into, nothing is tried. A retry already running for the same import, or one
 * already dismissed, does nothing and gives null.
 */
export async function retryFailedImport(id: string, userId: string): Promise<ImportRecipeResult | null> {
  if (retrying.has(id)) return null;
  const row = db.select().from(failedImports).where(eq(failedImports.id, id)).get();
  if (!row) return null;
  const target = resolveImportTarget(requestedFromRecord(row), userId);
  if (!target) return { ok: false, error: 'failed' };
  retrying.add(id);
  try {
    const result = await importRecipe({ ...target, url: row.url });
    if (result.ok) dismissFailedImport(id);
    else db.update(failedImports).set({ reason: result.error }).where(eq(failedImports.id, id)).run();
    return result;
  } finally {
    retrying.delete(id);
  }
}

/** A row's name: the page title, else the link's host without `www.`, else the link as shared. */
export { importName as failedImportName } from './share-queue-status';

/**
 * Why it failed, in plain words. `limit_reached` (a Try again past the plan's monthly imports) says
 * when they reset: the start of next month, as the row keeps no date.
 */
export function failedImportReason(reason: FailedImportReason, now: number = Date.now()): string {
  switch (reason) {
    case 'limit_reached':
      return importLimitMessage(limitResetsAt(null, now));
    case 'daily_limit':
      return i18n.t('errors.dailyLimit');
    case 'not_a_recipe':
      return i18n.t('recipes.imports.reasons.notARecipe');
    case 'blocked':
      return i18n.t('recipes.imports.reasons.blocked');
    case 'rate_limited':
      return i18n.t('recipes.imports.reasons.rateLimited');
    case 'offline':
      return i18n.t('recipes.imports.reasons.offline');
    case 'not_entitled':
      return NOT_ENTITLED_MESSAGE;
    case 'failed':
      return i18n.t('recipes.imports.reasons.failed');
  }
}
