// A failed photo import's pages (spec 4.10 **Failed photo imports**): the JPEGs it sent, moved out
// of the cache (which iOS may clear) into `failed-imports/<id>/<n>.jpg` under the document
// directory, and recorded in `failed_imports`. They stay on this phone: never uploaded or synced
// until a Try again imports them, and they go with their row.
import { eq } from 'drizzle-orm';
import { Directory, File, Paths } from 'expo-file-system';

import { db, failedImports, type FailedImportReason } from '@/db';
import { newId } from '@/lib/id';
import { reportError } from '@/lib/sentry';

/** The folder under the document directory that holds every failed photo import's pages. */
export const FAILED_IMPORTS_DIR = 'failed-imports';

/** A row's folder: `<documentDirectory>/failed-imports/<id>/`. */
function folder(id: string): Directory {
  return new Directory(Paths.document, FAILED_IMPORTS_DIR, id);
}

/** The pages' URIs, in page order, as `importRecipeFromPhotos` reads them. */
export function failedPageUris(id: string, pages: readonly string[]): string[] {
  const dir = folder(id);
  return pages.map((name) => new File(dir, name).uri);
}

/** Whether every page's file is still there (false for no pages). */
export function failedPagesExist(id: string, pages: readonly string[] | null): boolean {
  if (!pages || pages.length === 0) return false;
  const dir = folder(id);
  try {
    return pages.every((name) => new File(dir, name).exists);
  } catch {
    return false;
  }
}

/**
 * Moves `uris` into the row's folder as the next free `<n>.jpg` names after `taken` (from 1), in
 * order, and gives their names. Throws if one can't be moved; the ones moved stay in the folder.
 */
function movePages(id: string, uris: readonly string[], taken: readonly string[] = []): string[] {
  const dir = folder(id);
  dir.create({ intermediates: true, idempotent: true });
  let next = Math.max(0, ...taken.map((name) => Number.parseInt(name, 10)).filter(Number.isFinite)) + 1;
  const names: string[] = [];
  for (const uri of uris) {
    const name = `${next++}.jpg`;
    new File(uri).moveSync(new File(dir, name));
    names.push(name);
  }
  return names;
}

/** Deletes a row's folder and its pages. Never throws. */
export function deleteFailedPages(id: string): void {
  try {
    const dir = folder(id);
    if (dir.exists) dir.delete();
  } catch (e) {
    console.warn('[failed-imports] deleting the pages failed', e);
  }
}

/** Deletes every failed photo import's pages (the sign-out wipe, spec 4.8). Never throws. */
export function deleteAllFailedPages(): void {
  try {
    const dir = new Directory(Paths.document, FAILED_IMPORTS_DIR);
    if (dir.exists) dir.delete();
  } catch (e) {
    console.warn('[failed-imports] deleting the pages failed', e);
    reportError(e, { area: 'import', event: 'failed_pages_wipe_failed' });
  }
}

/** Where a failed import was going, as `failed_imports` keeps it (`recordedTarget`). */
export type RecordedTarget = { householdId: string | null; listId: string | null };

/**
 * Records a failed photo import: moves its pages out of the cache into the row's folder and adds
 * the `photo` row with where it was going. Gives its id, or null when a page couldn't be moved (a
 * row without all its pages can't be tried again; whatever moved is deleted).
 */
export function recordFailedPhotoImport(
  photoUris: readonly string[],
  reason: FailedImportReason,
  target: RecordedTarget,
): string | null {
  if (photoUris.length === 0) return null;
  const id = newId();
  let pages: string[];
  try {
    pages = movePages(id, photoUris);
  } catch (e) {
    console.warn('[failed-imports] keeping the pages failed', e);
    reportError(e, { area: 'import', event: 'failed_pages_keep_failed' });
    deleteFailedPages(id);
    return null;
  }
  db.insert(failedImports)
    .values({ id, kind: 'photo', url: null, title: null, reason, householdId: target.householdId, listId: target.listId, pages })
    .run();
  return id;
}

/** What the review sheet saves to a failed photo import before its Try again (spec 4.10). */
export type FailedPhotoImportEdit = RecordedTarget & {
  /**
   * The pages in order: the row's own (as `failedPageUris` gave them) and new ones, which are moved
   * into its folder. One to three.
   */
  pages: readonly string[];
};

/**
 * Saves the review sheet's pages and target to a failed photo import: new pages move into its
 * folder, removed ones' files are deleted. False when there's no such photo row, or no pages.
 */
export function updateFailedPhotoImport(id: string, edit: FailedPhotoImportEdit): boolean {
  const row = db.select().from(failedImports).where(eq(failedImports.id, id)).get();
  if (!row || row.kind !== 'photo' || edit.pages.length === 0) return false;
  const current = row.pages ?? [];
  const byUri = new Map(failedPageUris(id, current).map((uri, i) => [uri, current[i]]));
  const added = edit.pages.filter((uri) => !byUri.has(uri));
  let moved: string[];
  try {
    moved = movePages(id, added, current);
  } catch (e) {
    console.warn('[failed-imports] adding pages failed', e);
    reportError(e, { area: 'import', event: 'failed_pages_keep_failed' });
    return false;
  }
  const newNames = new Map(added.map((uri, i) => [uri, moved[i]]));
  const pages = edit.pages.map((uri) => byUri.get(uri) ?? newNames.get(uri)!);
  const dir = folder(id);
  for (const name of current) {
    if (pages.includes(name)) continue;
    try {
      new File(dir, name).delete();
    } catch {}
  }
  db.update(failedImports)
    .set({ pages, householdId: edit.householdId, listId: edit.listId })
    .where(eq(failedImports.id, id))
    .run();
  return true;
}

/** How long a failed photo import's pages are kept (spec 4.10). */
export const FAILED_PAGES_KEPT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The launch prune (spec 4.10): deletes photo rows failed 30 days ago or more, or whose pages have
 * gone, with their folders, and folders no row owns. Never throws.
 */
export function pruneFailedPhotoImports(now: number = Date.now()): void {
  try {
    const rows = db.select().from(failedImports).where(eq(failedImports.kind, 'photo')).all();
    const kept = new Set<string>();
    for (const row of rows) {
      if (now - row.createdAt.getTime() >= FAILED_PAGES_KEPT_MS || !failedPagesExist(row.id, row.pages)) {
        db.delete(failedImports).where(eq(failedImports.id, row.id)).run();
        deleteFailedPages(row.id);
      } else {
        kept.add(row.id);
      }
    }
    const root = new Directory(Paths.document, FAILED_IMPORTS_DIR);
    if (!root.exists) return;
    for (const entry of root.list()) {
      if (!kept.has(entry.name)) entry.delete();
    }
  } catch (e) {
    console.warn('[failed-imports] pruning failed', e);
    reportError(e, { area: 'import', event: 'failed_pages_prune_failed' });
  }
}
