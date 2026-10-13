import { Directory, File, Paths } from 'expo-file-system';

import type { z } from 'zod';

import {
  ListSnapshotSchema,
  ShareEnvelopeSchema,
  SiriEnvelopeSchema,
  type ListSnapshot,
  type ShareEnvelope,
  type SiriEnvelope,
} from '@/shared';

export const APP_GROUP_ID = 'group.com.jgp.perfectbite';

// App Group layout (spec 4.9). Written by targets/_shared/SiriQueue.swift and ShareQueue.swift.
export const PENDING_DIR = 'siri/pending';
export const SHARE_PENDING_DIR = 'share/pending';
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
 * Deletes every file in the Siri and share queues, `.tmp` writes too (account deletion, spec 4.8):
 * their envelopes are the user's words. Does nothing without the App Group.
 */
export function emptyQueues(): void {
  const root = getAppGroupContainer();
  if (!root) return;
  for (const dir of [PENDING_DIR, SHARE_PENDING_DIR]) {
    const pending = new Directory(root, dir);
    if (!pending.exists) continue;
    for (const entry of pending.list()) if (entry instanceof File) entry.delete();
  }
}

export function readNativeLog(): string {
  const root = getAppGroupContainer();
  if (!root) return '';
  const log = new File(root, LOG_FILE);
  return log.exists ? log.textSync() : '';
}
