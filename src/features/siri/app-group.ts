import { Directory, File, Paths } from 'expo-file-system';

import type { z } from 'zod';

import {
  ListSnapshotSchema,
  ShareEnvelopeSchema,
  shareKind,
  SiriEnvelopeSchema,
  type ListSnapshot,
  type ShareEnvelope,
  type ShareKind,
  type SiriEnvelope,
} from '@/shared';

export const APP_GROUP_ID = 'group.com.jgp.perfectbite';

// App Group layout (spec 4.9). Written by targets/_shared/SiriQueue.swift and ShareQueue.swift.
export const PENDING_DIR = 'siri/pending';
export const SHARE_PENDING_DIR = 'share/pending';
/** The extension's background upload: its request body and its state, by envelope id (spec 4.10). */
export const SHARE_UPLOAD_DIR = 'share/upload';
export const SHARE_UPLOAD_STATE_DIR = 'share/upload-state';
/** A photo share's page thumbnails, `<id>/<n>.jpg` with n from 1, written by the extension (spec 4.10). */
export const SHARE_THUMBS_DIR = 'share/thumbs';
export const LISTS_FILE = 'siri/lists.json';
export const LOG_FILE = 'logs/native.log';

/** A queued file: its envelope, or why it couldn't be read. */
type Pending<T> = { ok: true; file: File; envelope: T } | { ok: false; file: File; fileName: string; error: string };
export type PendingSiriAdd = Pending<SiriEnvelope>;
export type PendingShare = Pending<ShareEnvelope>;

export function getAppGroupContainer(): Directory | undefined {
  return Paths.appleSharedContainers[APP_GROUP_ID];
}

function requireContainer(): Directory {
  const root = getAppGroupContainer();
  if (!root) throw new Error(`App Group ${APP_GROUP_ID} is not available (missing entitlement?)`);
  return root;
}

function parseEnvelope<T>(file: File, schema: z.ZodType<T>): Pending<T> {
  try {
    return { ok: true, file, envelope: schema.parse(JSON.parse(file.textSync())) };
  } catch (err) {
    return { ok: false, file, fileName: file.name, error: String(err) };
  }
}

/** The `.json` files in a queue directory, oldest first. In-progress `<id>.json.tmp` writes are skipped. */
function pendingFiles(dir: string): File[] {
  const pending = new Directory(requireContainer(), dir);
  if (!pending.exists) return [];
  return pending
    .list()
    .filter((entry): entry is File => entry instanceof File && entry.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name)); // UUIDv7 file names sort by time
}

/** Parses one queued file. Never throws. */
export function parseSiriEnvelope(file: File): PendingSiriAdd {
  return parseEnvelope(file, SiriEnvelopeSchema);
}

/** Queued adds, oldest first. In-progress `<id>.json.tmp` writes are skipped. Deletes nothing. */
export function readPendingSiriAdds(): PendingSiriAdd[] {
  return pendingFiles(PENDING_DIR).map(parseSiriEnvelope);
}

/** Parses one queued share. Never throws. */
export function parseShareEnvelope(file: File): PendingShare {
  return parseEnvelope(file, ShareEnvelopeSchema);
}

/** Queued shares, oldest first. In-progress `<id>.json.tmp` writes are skipped. Deletes nothing. */
export function readPendingShares(): PendingShare[] {
  return pendingFiles(SHARE_PENDING_DIR).map(parseShareEnvelope);
}

/**
 * What the share reconcile and the imports card need of an envelope, without a photo share's
 * pages (about 3 MB) or a link's captured page text.
 */
export type ShareSummary = Pick<ShareEnvelope, 'id' | 'userId' | 'url' | 'listId' | 'householdId' | 'addToList'> & {
  kind: ShareKind;
  /** A photo share's page count; null for a link. */
  pageCount: number | null;
  /** The page title Safari captured, if any. */
  title: string | null;
};
export type PendingShareSummary = Pending<ShareSummary>;

export function summarizeShareEnvelope(envelope: ShareEnvelope): ShareSummary {
  const { id, userId, url, listId, householdId, addToList } = envelope;
  return {
    id,
    userId,
    url,
    listId,
    householdId,
    addToList,
    kind: shareKind(envelope),
    pageCount: envelope.images?.length ?? null,
    title: envelope.page?.title ?? null,
  };
}

/**
 * Summaries already read, by file URI, with the file's size and modification time when read. An
 * envelope is written once (atomically) and never changed, so each is read and parsed in full only
 * the first time it's seen; later reconciles reuse its summary.
 */
const summaryCache = new Map<string, { size: number; modified: number | null; summary: ShareSummary }>();

/**
 * Queued shares as summaries, oldest first, like `readPendingShares` (bad files come back as not
 * ok). Only envelopes not seen before are read and parsed. Deletes nothing.
 */
export function readPendingShareSummaries(): PendingShareSummary[] {
  const files = pendingFiles(SHARE_PENDING_DIR);
  const seen = new Set<string>();
  const result = files.map((file): PendingShareSummary => {
    seen.add(file.uri);
    const size = file.size;
    const modified = file.modificationTime ?? null;
    const cached = summaryCache.get(file.uri);
    if (cached && cached.size === size && cached.modified === modified) return { ok: true, file, envelope: cached.summary };
    const parsed = parseShareEnvelope(file);
    if (!parsed.ok) return parsed;
    const summary = summarizeShareEnvelope(parsed.envelope);
    summaryCache.set(file.uri, { size, modified, summary });
    return { ok: true, file, envelope: summary };
  });
  for (const uri of summaryCache.keys()) if (!seen.has(uri)) summaryCache.delete(uri);
  return result;
}

/** When a UUIDv7 was made (ms since epoch), or null when `id` isn't one. */
export function uuidv7Time(id: string): number | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

/** The ids with page thumbnails (`share/thumbs/<id>/`). Empty without the App Group. */
export function listShareThumbIds(): string[] {
  const root = getAppGroupContainer();
  if (!root) return [];
  const thumbs = new Directory(root, SHARE_THUMBS_DIR);
  if (!thumbs.exists) return [];
  return thumbs
    .list()
    .filter((entry): entry is Directory => entry instanceof Directory)
    .map((entry) => entry.name);
}

/**
 * A photo share's page thumbnails (`share/thumbs/<id>/<n>.jpg`) as URIs, in page order. Empty when
 * they're missing (another device's share, or pruned) or without the App Group. Never throws.
 */
export function shareThumbUris(id: string): string[] {
  const root = getAppGroupContainer();
  if (!root) return [];
  try {
    const dir = new Directory(root, SHARE_THUMBS_DIR, id);
    if (!dir.exists) return [];
    return dir
      .list()
      .filter((entry): entry is File => entry instanceof File && /^\d+\.jpg$/.test(entry.name))
      .sort((a, b) => parseInt(a.name, 10) - parseInt(b.name, 10))
      .map((entry) => entry.uri);
  } catch (err) {
    console.warn('[share] reading a share’s thumbnails failed', id, err);
    return [];
  }
}

/** Deletes a photo share's page thumbnails (`share/thumbs/<id>/`), best effort. */
export function removeShareThumbs(id: string): void {
  const root = getAppGroupContainer();
  if (!root) return;
  try {
    const dir = new Directory(root, SHARE_THUMBS_DIR, id);
    if (dir.exists) dir.delete();
  } catch (err) {
    console.warn('[share] deleting a share’s thumbnails failed', id, err);
  }
}

/**
 * Deletes a share's envelope and its upload files (`share/pending/`, `share/upload/` and
 * `share/upload-state/` `<id>.json`), each best effort. Leaves its thumbnails, which the card shows
 * while the server imports it (`removeShareThumbs`). Does nothing without the App Group.
 */
export function removeShareFiles(id: string): void {
  const root = getAppGroupContainer();
  if (!root) return;
  for (const dir of [SHARE_PENDING_DIR, SHARE_UPLOAD_DIR, SHARE_UPLOAD_STATE_DIR]) {
    try {
      const file = new File(root, `${dir}/${id}.json`);
      if (file.exists) file.delete();
    } catch (err) {
      console.warn('[share] deleting a share file failed', dir, id, err);
    }
  }
}

/** Writes `lists.json` for the intent's list picker. Call whenever lists or memberships change. */
export function writeListSnapshot(snapshot: ListSnapshot): void {
  const valid = ListSnapshotSchema.parse(snapshot);
  const root = requireContainer();
  new Directory(root, 'siri').create({ intermediates: true, idempotent: true });
  const file = new File(root, LISTS_FILE);
  if (!file.exists) file.create();
  file.write(JSON.stringify(valid));
}

/** Deletes `lists.json` (sign-out), so Siri offers no lists. Does nothing without the App Group. */
export function clearListSnapshot(): void {
  const root = getAppGroupContainer();
  if (!root) return;
  const file = new File(root, LISTS_FILE);
  if (file.exists) file.delete();
}

/**
 * Deletes every file in the Siri and share queues and the share uploads, `.tmp` writes too, and
 * every photo share's thumbnails (sign-out and account deletion, spec 4.8): their envelopes are the
 * user's words, and the thumbnails their photos. Does nothing without the App Group.
 */
export function emptyQueues(): void {
  const root = getAppGroupContainer();
  if (!root) return;
  for (const dir of [PENDING_DIR, SHARE_PENDING_DIR, SHARE_UPLOAD_DIR, SHARE_UPLOAD_STATE_DIR]) {
    const pending = new Directory(root, dir);
    if (!pending.exists) continue;
    for (const entry of pending.list()) if (entry instanceof File) entry.delete();
  }
  const thumbs = new Directory(root, SHARE_THUMBS_DIR);
  if (thumbs.exists) thumbs.delete();
}

export function readNativeLog(): string {
  const root = getAppGroupContainer();
  if (!root) return '';
  const log = new File(root, LOG_FILE);
  return log.exists ? log.textSync() : '';
}
