import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { setAppGroupRoot } from '@/test/fake-file-system';

import {
  clearListSnapshot,
  getAppGroupContainer,
  LISTS_FILE,
  LOG_FILE,
  PENDING_DIR,
  readNativeLog,
  readPendingShares,
  readPendingSiriAdds,
  SHARE_PENDING_DIR,
  writeListSnapshot,
} from '../app-group';

jest.mock('expo-file-system', () => require('@/test/fake-file-system'));

// UUIDv7 envelope ids, in the order they were shared.
const S1 = '019a5e21-4b7c-7a10-9c3e-5d2f8a6b1e04';
const S2 = '019a5e22-03d1-7b55-8e19-a4c07f3b9d61';
const S3 = '019a5e23-77aa-7c01-8d42-1f0e9c8b7a65';
const COSTCO = '019a4c10-0000-7000-8000-00000000c057';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'share-queue-'));
  setAppGroupRoot(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const shareDir = () => path.join(root, SHARE_PENDING_DIR);
const write = (name: string, body: string) => {
  fs.mkdirSync(shareDir(), { recursive: true });
  fs.writeFileSync(path.join(shareDir(), name), body);
};
/** Writes a queued share as the extension does: `share/pending/<id>.json`. */
const enqueue = (id: string, extra: Record<string, unknown> = {}) =>
  write(
    `${id}.json`,
    JSON.stringify({
      id,
      url: `https://example.com/recipes/${id}`,
      listId: null,
      createdAt: '2026-10-11T09:12:40.512-05:00',
      appVersion: '1.0.0',
      source: 'share',
      ...extra,
    }),
  );

describe('readPendingShares', () => {
  test('the queue lives in share/pending', () => {
    expect(SHARE_PENDING_DIR).toBe('share/pending');
  });

  test('no queue directory yet: nothing pending', () => {
    expect(readPendingShares()).toEqual([]);
  });

  test('reads every share, oldest first, with its envelope', () => {
    enqueue(S3);
    enqueue(S1, { listId: COSTCO, page: { title: 'Ramen', jsonLd: ['{}'], text: 'Ramen' } });
    enqueue(S2);
    const pending = readPendingShares();
    expect(pending.map((p) => p.file.name)).toEqual([`${S1}.json`, `${S2}.json`, `${S3}.json`]);
    expect(pending.every((p) => p.ok)).toBe(true);
    const first = pending[0];
    if (!first.ok) throw new Error('expected an envelope');
    expect(first.envelope).toEqual({
      id: S1,
      url: `https://example.com/recipes/${S1}`,
      listId: COSTCO,
      page: { title: 'Ramen', jsonLd: ['{}'], text: 'Ramen' },
      createdAt: '2026-10-11T09:12:40.512-05:00',
      appVersion: '1.0.0',
      source: 'share',
    });
  });

  test('skips in-progress .tmp writes and other files', () => {
    enqueue(S1);
    write(`${S2}.json.tmp`, '{"id":');
    write('.DS_Store', '');
    fs.mkdirSync(path.join(shareDir(), 'nested.json'));
    expect(readPendingShares().map((p) => p.file.name)).toEqual([`${S1}.json`]);
  });

  test('a bad file comes back as an error entry, in order, and nothing is deleted', () => {
    enqueue(S1);
    write(`${S2}.json`, 'not json');
    enqueue(S3, { url: 'ftp://example.com/x' }); // valid JSON, fails the schema
    const pending = readPendingShares();
    expect(pending.map((p) => p.ok)).toEqual([true, false, false]);
    const [, notJson, badUrl] = pending;
    if (notJson.ok || badUrl.ok) throw new Error('expected errors');
    expect(notJson.fileName).toBe(`${S2}.json`);
    expect(notJson.error).toMatch(/JSON/);
    expect(badUrl.fileName).toBe(`${S3}.json`);
    expect(badUrl.error).toMatch(/http\(s\)/);
    expect(fs.readdirSync(shareDir()).sort()).toEqual([`${S1}.json`, `${S2}.json`, `${S3}.json`]);
  });

  test('a page over the caps is an error entry', () => {
    enqueue(S1, { page: { jsonLd: Array(11).fill('{}') } });
    expect(readPendingShares()[0].ok).toBe(false);
  });

  test('is separate from the Siri queue', () => {
    enqueue(S1);
    fs.mkdirSync(path.join(root, PENDING_DIR), { recursive: true });
    fs.writeFileSync(path.join(root, PENDING_DIR, `${S2}.json`), '{}');
    expect(readPendingShares().map((p) => p.file.name)).toEqual([`${S1}.json`]);
    expect(readPendingSiriAdds().map((p) => p.file.name)).toEqual([`${S2}.json`]);
  });

  test('throws without the App Group, as the Siri queue does', () => {
    setAppGroupRoot(null);
    expect(() => readPendingShares()).toThrow(/App Group/);
  });
});

describe('getAppGroupContainer', () => {
  test('is the shared container, or undefined without the App Group (Expo Go)', () => {
    expect((getAppGroupContainer() as unknown as { path: string } | undefined)?.path).toBe(root);
    setAppGroupRoot(null);
    expect(getAppGroupContainer()).toBeUndefined();
  });
});

describe('list snapshot', () => {
  const GROCERIES = '019a4c10-0000-7000-8000-00000000a001';
  const snapshot = {
    defaultListId: GROCERIES,
    lastOpenedListId: COSTCO,
    lists: [
      { id: GROCERIES, name: 'Groceries', householdName: 'Smith home' },
      { id: COSTCO, name: 'Costco', householdName: 'Smith home' },
    ],
  };
  const listsFile = () => path.join(root, LISTS_FILE);
  const readLists = () => JSON.parse(fs.readFileSync(listsFile(), 'utf8'));

  test('lives at siri/lists.json, where the intent reads it', () => {
    expect(LISTS_FILE).toBe('siri/lists.json');
  });

  test('writes lists.json, creating the siri directory on first write', () => {
    expect(fs.existsSync(path.join(root, 'siri'))).toBe(false);
    writeListSnapshot(snapshot);
    expect(readLists()).toEqual(snapshot);
  });

  test('replaces the whole file on the next write', () => {
    writeListSnapshot(snapshot);
    writeListSnapshot({ lastOpenedListId: null, lists: [{ id: COSTCO, name: 'Costco', householdName: 'Smith home' }] });
    expect(readLists()).toEqual({ lastOpenedListId: null, lists: [{ id: COSTCO, name: 'Costco', householdName: 'Smith home' }] });
  });

  test('writes alongside a queue the intent already made', () => {
    fs.mkdirSync(path.join(root, PENDING_DIR), { recursive: true });
    fs.writeFileSync(path.join(root, PENDING_DIR, `${S1}.json`), '{}');
    writeListSnapshot(snapshot);
    expect(readLists()).toEqual(snapshot);
    expect(fs.readdirSync(path.join(root, PENDING_DIR))).toEqual([`${S1}.json`]);
  });

  test('strips unknown fields so the Swift decoder only sees the contract', () => {
    writeListSnapshot({ ...snapshot, extra: 'nope' } as typeof snapshot);
    expect(readLists()).not.toHaveProperty('extra');
  });

  test('an invalid snapshot throws and leaves the previous file alone', () => {
    writeListSnapshot(snapshot);
    expect(() => writeListSnapshot({ lastOpenedListId: null, lists: [{ id: 'not-a-uuid', name: 'x', householdName: 'y' }] })).toThrow();
    expect(readLists()).toEqual(snapshot);
  });

  test('writing throws without the App Group', () => {
    setAppGroupRoot(null);
    expect(() => writeListSnapshot(snapshot)).toThrow(/App Group/);
  });

  test('clearing deletes lists.json, and is a no-op when there is none or no App Group', () => {
    writeListSnapshot(snapshot);
    clearListSnapshot();
    expect(fs.existsSync(listsFile())).toBe(false);
    expect(() => clearListSnapshot()).not.toThrow();
    setAppGroupRoot(null);
    expect(() => clearListSnapshot()).not.toThrow();
  });
});

describe('readNativeLog', () => {
  test('reads logs/native.log', () => {
    fs.mkdirSync(path.dirname(path.join(root, LOG_FILE)), { recursive: true });
    fs.writeFileSync(path.join(root, LOG_FILE), 'siri: queued 019a\n');
    expect(readNativeLog()).toBe('siri: queued 019a\n');
  });

  test('is empty with no log yet, or without the App Group', () => {
    expect(readNativeLog()).toBe('');
    setAppGroupRoot(null);
    expect(readNativeLog()).toBe('');
  });
});
