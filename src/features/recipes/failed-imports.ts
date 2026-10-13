// Failed imports (spec 4.10): shares that won't import, kept on the device only and shown on the
// Recipes tab with Try again and Dismiss until one of them clears it.
import { desc, eq } from 'drizzle-orm';

import { db, failedImports, type FailedImportReason } from '@/db';
import { newId } from '@/lib/id';

import { importRecipe, type ImportRecipeResult } from './import';
import { NOT_ENTITLED_MESSAGE } from './import-sheet';
import { requestedFromRecord, resolveImportTarget } from './import-target';
import type { FailedShare } from './share-drain';

/** The share drain's writer: records a share that won't import, and where it was going. Returns its id. */
export function recordFailedImport(failed: FailedShare): string {
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
 * list, falling back as the drain does when that's gone; rows recorded before targets were kept go
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

/** Why it failed, in plain words. */
export function failedImportReason(reason: FailedImportReason): string {
  switch (reason) {
    case 'not_a_recipe':
      return "That page doesn't look like a recipe";
    case 'blocked':
      return 'The site blocked the import';
    case 'rate_limited':
      return 'The import service was busy';
    case 'offline':
      return "Couldn't connect";
    case 'not_entitled':
      return NOT_ENTITLED_MESSAGE;
    case 'failed':
      return "Couldn't read that page";
  }
}
