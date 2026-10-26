// Failed in-app imports (spec 4.10), kept on the device only and shown on the Recipes tab with Try
// again and Dismiss until one of them clears it. Failed shares are server state (share-reconcile.ts).
// A failed photo import keeps its pages on the phone (failed-photo-pages.ts), and they go with it.
import { desc, eq } from 'drizzle-orm';

import { db, failedImports, households, type FailedImport, type FailedImportReason } from '@/db';
import { getList } from '@/features/lists/lists';
import { limitResetsAt, resetDate } from '@/features/plans/limits';
import { formatDate, i18n, shortDate } from '@/i18n';
import { newId } from '@/lib/id';

import { deleteFailedPages, failedPagesExist, failedPageUris } from './failed-photo-pages';
import { importRecipe, importRecipeFromPhotos, type ImportRecipeResult, type ImportTarget } from './import';
import { importErrorMessage, importLimitMessage, NOT_ENTITLED_MESSAGE } from './import-sheet';
import { requestedFromRecord, resolveImportTarget } from './import-target';
import type { SheetEntry } from './save-choice';
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

/** One failed import, or undefined when it's gone (dismissed, imported or pruned). */
export function getFailedImport(id: string): FailedImport | undefined {
  return db.select().from(failedImports).where(eq(failedImports.id, id)).get();
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

type RowFacts = Pick<FailedImport, 'kind' | 'reason' | 'createdAt'>;

/**
 * A row's reason as the imports card and the review sheet show it. A photo row's monthly limit
 * resets on the 1st after it failed, the date its Try again waits for.
 */
export function failedImportRowReason(row: RowFacts, now: number = Date.now()): string {
  if (row.kind === 'photo') return failedImportReason(row.reason, row.createdAt.getTime(), 'photo');
  return failedImportReason(row.reason, now);
}

/** Ends `text` with a full stop unless it ends a sentence already (the reasons come both ways). */
function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/** The collapsed card's one failed photo import (board A): "Try again in a minute. Your photos are kept." */
export function photosKeptReason(row: RowFacts, now: number = Date.now()): string {
  return i18n.t('recipes.imports.photosKept', { reason: sentence(failedImportRowReason(row, now)) });
}

/**
 * When a photo import over the monthly limit can be tried again (spec 4.10 board E): the 1st of
 * the month after it failed, in UTC, as an ISO date. Null for any other row, or once that's come.
 */
export function failedImportRetryOn(row: RowFacts, now: number = Date.now()): string | null {
  if (row.kind !== 'photo' || row.reason !== 'limit_reached') return null;
  const at = limitResetsAt(null, row.createdAt.getTime());
  return now < Date.parse(at) ? at : null;
}

/** The disabled Try again for `failedImportRetryOn`'s date: "Try again Nov 1". */
export function tryAgainOnLabel(retryOn: string): string {
  return i18n.t('recipes.imports.tryAgainOn', { date: resetDate(retryOn) });
}

/** A photo that doesn't look like a recipe: the same pages can't succeed, so it offers Use other photos (board E). */
export function needsOtherPhotos(row: Pick<FailedImport, 'kind' | 'reason'>): boolean {
  return row.kind === 'photo' && row.reason === 'not_a_recipe';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The review sheet's banner (board D): when it failed, on this phone's clock, and why: "Couldn't
 * import this yesterday at 6:42 PM. Try again in a minute."
 */
export function failedImportBanner(row: RowFacts, now: number = Date.now()): string {
  const at = row.createdAt;
  const today = new Date(now);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const daysAgo = Math.round((startOf(today) - startOf(at)) / DAY_MS);
  const time = formatDate(at, { hour: 'numeric', minute: '2-digit' });
  const reason = sentence(failedImportRowReason(row, now));
  if (daysAgo === 0) return i18n.t('recipes.import.failedToday', { time, reason });
  if (daysAgo === 1) return i18n.t('recipes.import.failedYesterday', { time, reason });
  return i18n.t('recipes.import.failedOn', { date: shortDate(at, today), time, reason });
}

/** Where a row's Try again goes now (with the same fallbacks), or null with nowhere to go. */
function liveTarget(row: Pick<FailedImport, 'householdId' | 'listId'>, userId: string | null): ImportTarget | null {
  return userId ? resolveImportTarget(requestedFromRecord(row), userId) : null;
}

/** The name of where a row's Try again goes: its list, or its household when it's recipe-only. */
export function failedImportDestination(row: Pick<FailedImport, 'householdId' | 'listId'>, userId: string | null): string | null {
  const target = liveTarget(row, userId);
  if (!target) return null;
  if (target.listId) return getList(target.listId)?.name ?? null;
  return target.householdId ? householdName(target.householdId) : null;
}

/** A household's name, or null when it isn't on the device. */
export function householdName(id: string): string | null {
  return db.select({ name: households.name }).from(households).where(eq(households.id, id)).get()?.name ?? null;
}

/** A failed photo import's row (board B): "2 pages · to Groceries", or "1 page · to Smith home" when recipe-only. */
export function failedPhotoDetail(row: Pick<FailedImport, 'householdId' | 'listId' | 'pages'>, userId: string | null): string {
  const parts = [i18n.t('recipes.imports.pages', { count: row.pages?.length ?? 0 })];
  const to = failedImportDestination(row, userId);
  if (to) parts.push(i18n.t('recipes.imports.to', { name: to }));
  return parts.join(' · ');
}

/** A photo import's Try again running (board C): "From a photo · to Groceries". */
export function retryingPhotoDetail(row: Pick<FailedImport, 'householdId' | 'listId'>, userId: string | null): string {
  const to = failedImportDestination(row, userId);
  const name = i18n.t('recipes.imports.fromAPhoto');
  return to ? `${name} · ${i18n.t('recipes.imports.to', { name: to })}` : name;
}

/** The review sheet's starting Save to, switch and list: where the row was going, falling back as Try again does. */
export function failedImportEntry(
  row: Pick<FailedImport, 'householdId' | 'listId'>,
  userId: string | null,
): Extract<SheetEntry, { from: 'retry' }> {
  const target = liveTarget(row, userId);
  if (target?.listId) {
    return { from: 'retry', householdId: getList(target.listId)?.householdId ?? null, addToList: true, listId: target.listId };
  }
  return { from: 'retry', householdId: target?.householdId ?? row.householdId, addToList: false, listId: null };
}
