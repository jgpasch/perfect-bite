import { Directory, File, Paths } from 'expo-file-system';

import { ListSnapshotSchema, SiriEnvelopeSchema, type ListSnapshot, type SiriEnvelope } from '@/shared';

export const APP_GROUP_ID = 'group.com.jgp.perfectbite';

// App Group layout (spec 4.9). Written by targets/_shared/SiriQueue.swift.
export const PENDING_DIR = 'siri/pending';
export const LISTS_FILE = 'siri/lists.json';
export const LOG_FILE = 'logs/native.log';

export type PendingSiriAdd =
  | { ok: true; file: File; envelope: SiriEnvelope }
  | { ok: false; file: File; fileName: string; error: string };

export function getAppGroupContainer(): Directory | undefined {
  return Paths.appleSharedContainers[APP_GROUP_ID];
}

function requireContainer(): Directory {
  const root = getAppGroupContainer();
  if (!root) throw new Error(`App Group ${APP_GROUP_ID} is not available (missing entitlement?)`);
  return root;
}

/** Parses one queued file. Never throws. */
export function parseSiriEnvelope(file: File): PendingSiriAdd {
  try {
    return { ok: true, file, envelope: SiriEnvelopeSchema.parse(JSON.parse(file.textSync())) };
  } catch (err) {
    return { ok: false, file, fileName: file.name, error: String(err) };
  }
}

/** Queued adds, oldest first. In-progress `<id>.json.tmp` writes are skipped. Deletes nothing. */
export function readPendingSiriAdds(): PendingSiriAdd[] {
  const pending = new Directory(requireContainer(), PENDING_DIR);
  if (!pending.exists) return [];
  return pending
    .list()
    .filter((entry): entry is File => entry instanceof File && entry.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name)) // UUIDv7 file names sort by time
    .map(parseSiriEnvelope);
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

export function readNativeLog(): string {
  const root = getAppGroupContainer();
  if (!root) return '';
  const log = new File(root, LOG_FILE);
  return log.exists ? log.textSync() : '';
}
