// Failed in-app imports (spec 4.10), kept on the device only and shown on the Recipes tab with Try
// again and Dismiss until one of them clears it. Failed shares are server state (share-reconcile.ts).
// A failed photo import keeps its pages on the phone (failed-photo-pages.ts), and they go with it.
import { desc, eq } from 'drizzle-orm';

import { db, failedImports, type FailedImport, type FailedImportReason } from '@/db';
import { limitResetsAt } from '@/features/plans/limits';
import { i18n } from '@/i18n';
import { newId } from '@/lib/id';

import { deleteFailedPages, failedPagesExist, failedPageUris } from './failed-photo-pages';
import { importRecipe, importRecipeFromPhotos, type ImportRecipeResult } from './import';
import { importErrorMessage, importLimitMessage, NOT_ENTITLED_MESSAGE } from './import-sheet';
import { requestedFromRecord, resolveImportTarget } from './import-target';
import { importName } from './share-queue-status';

export {
  recordFailedPhotoImport,
  updateFailedPhotoImport,
  pruneFailedPhotoImports,
  type FailedPhotoImportEdit,
} from './failed-photo-pages';

/** An in-app link import that failed (spec 4.10), and where it was going, so Try again goes there too. */
export type FailedImportRecord = {
  url: string;
  /** The page title, when there was one. */
  title: string | null;
  reason: FailedImportReason;
  /** A list and its household, or a household alone (recipe-only). Absent or null: the default list. */
  householdId?: string | null;
  listId?: string | null;
};

/** Records a link import that won't go through, and where it was going. Returns its id. */
export function recordFailedImport(failed: FailedImportRecord): string {
  const id = newId();
  db.insert(failedImports)
    .values({
      id,
      kind: 'link',
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

/** A photo row's pages as URIs, in page order (for its thumbnails and the review sheet); [] for a link. */
export function failedImportPageUris(row: Pick<FailedImport, 'id' | 'pages'>): string[] {
  return row.pages ? failedPageUris(row.id, row.pages) : [];
}

/** Deletes a failed import, and a photo import's kept pages with it. */
export function dismissFailedImport(id: string): void {
  db.delete(failedImports).where(eq(failedImports.id, id)).run();
  deleteFailedPages(id);
}

const retrying = new Set<string>();

/**
 * Imports a failed import again, where it was going: recipe-only into its household, or onto its
 * list, falling back to the default list when that's gone; rows recorded before targets were kept go
 * to `userId`'s default list. A photo row sends its kept pages through the photo import. Success
 * removes it (and its pages, after they went up with the recipe); another failure keeps it with the
 * new reason. With nowhere to import into, nothing is tried. A retry already running for the same
 * import, or one already dismissed, does nothing and gives null; so does a photo row whose pages
 * have gone, which is deleted quietly.
 */
export async function retryFailedImport(id: string, userId: string): Promise<ImportRecipeResult | null> {
  if (retrying.has(id)) return null;
  const row = db.select().from(failedImports).where(eq(failedImports.id, id)).get();
  if (!row) return null;
  if (row.kind === 'photo' && !failedPagesExist(row.id, row.pages)) {
    dismissFailedImport(id);
    return null;
  }
  const target = resolveImportTarget(requestedFromRecord(row), userId);
  if (!target) return { ok: false, error: 'failed' };
  retrying.add(id);
  try {
    const result =
      row.kind === 'photo'
        ? await importRecipeFromPhotos({ ...target, photoUris: failedImportPageUris(row), retryOf: id })
        : await importRecipe({ ...target, url: row.url ?? '' });
    if (result.ok) dismissFailedImport(id);
    else db.update(failedImports).set({ reason: result.error }).where(eq(failedImports.id, id)).run();
    return result;
  } finally {
    retrying.delete(id);
  }
}

/**
 * A row's name: "From a photo" for a photo import; for a link, the page title, else the link's host
 * without `www.`, else the link as shared.
 */
export function failedImportName(row: { kind?: FailedImport['kind']; url: string | null; title: string | null }): string {
  if (row.kind === 'photo' || row.url === null) return i18n.t('recipes.imports.fromAPhoto');
  return importName({ url: row.url, title: row.title });
}

/**
 * Why it failed, in plain words; a photo import's in the photo wording of its notification (spec
 * 4.10). `limit_reached` (a Try again past the plan's monthly imports) says when they reset: the
 * start of the month after `now`, as the row keeps no date.
 */
export function failedImportReason(
  reason: FailedImportReason,
  now: number = Date.now(),
  kind: FailedImport['kind'] = 'link',
): string {
  if (kind === 'photo') {
    if (reason === 'limit_reached') return importLimitMessage(limitResetsAt(null, now));
    return importErrorMessage({ ok: false, error: reason }, 'photo');
  }
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
