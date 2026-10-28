import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, failedImports, households, recipes } from '@/db';
import { createList, ensureStarterData, getDefaultListId, getList } from '@/features/lists/lists';
import { SHARE_PENDING_DIR, SHARE_THUMBS_DIR, SHARE_UPLOAD_DIR, SHARE_UPLOAD_STATE_DIR, uuidv7Time } from '@/features/siri/app-group';
import { initI18n } from '@/i18n';
import { reportSyncActivity, resetSyncActivity } from '@/sync/activity';
import { resetDb } from '@/test/db';
import { setAppGroupRoot } from '@/test/fake-file-system';
import { makeSession, onQuery, onRpc, queriesFor, resetSupabase, rpcCallsFor, supabase } from '@/test/fake-supabase';

import {
  dismissShareImport,
  isUsersShare,
  reconcileShares,
  refreshShareImports,
  removeQueuedShare,
  retryShareImport,
  runShareReconcile,
  SHARE_THUMBS_GRACE_MS,
  SHARE_THUMBS_MAX_AGE_MS,
  startShareReconcile,
  type ShareImportRow,
  type ShareImportStatus,
} from '../share-reconcile';
import {
  EMPTY_SHARE_QUEUE_STATUS,
  getShareQueueStatus,
  importsBadgeCount,
  importsCardHeading,
  photoShareDetail,
  queuedShareDetail,
  setShareQueueStatus,
  shareName,
} from '../share-queue-status';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('expo-file-system', () => require('@/test/fake-file-system'));
jest.mock('expo-network', () => ({ addNetworkStateListener: () => ({ remove: () => {} }) }));
const mockPushListeners = new Set<(notification: unknown) => void>();
jest.mock('expo-notifications', () => ({
  addNotificationReceivedListener: (listener: (notification: unknown) => void) => {
    mockPushListeners.add(listener);
    return { remove: () => mockPushListeners.delete(listener) };
  },
}));
const push = (data: Record<string, unknown>) =>
  mockPushListeners.forEach((listener) => listener({ request: { identifier: 'p1', content: { title: 'x', body: 'y', data } } }));
const mockReportError = jest.fn();
jest.mock('@/lib/sentry', () => ({ reportError: (...args: unknown[]) => mockReportError(...args) }));

const USER = '0199c0de-0000-7000-8000-000000000001';
const OTHER_USER = '0199c0de-0000-7000-8000-000000000002';
const invoke = supabase.functions.invoke;

// UUIDv7 envelope ids, in the order they were shared.
const E1 = '019a4c2e-7d3b-7a10-8f2e-3b9d1c0e5a71';
const E2 = '019a4c2e-9e01-7c44-b1aa-0f6e2d8c3b92';
const E3 = '019a4c2f-0102-7d55-a2bb-1a2b3c4d5e6f';
const E4 = '019a4c2f-2233-7e66-b3cc-2b3c4d5e6f70';

const TIKKA_URL = 'https://www.example.com/tikka';

/** What `functions.invoke` gives for a non-2xx answer. */
const httpError = (status: number, error: string) => ({
  data: null,
  error: {
    name: 'FunctionsHttpError',
    message: 'Edge Function returned a non-2xx status code',
    context: { status, json: () => Promise.resolve({ error }) },
  },
});
const offline = { data: null, error: { name: 'FunctionsFetchError', message: 'Failed to send a request' } };

// --- A tiny server: share_imports by id, as share-ingest, share_import_status and the view see it. ---

/** `dismissed`: `dismissed_at` is set, so the view leaves it out (share_import_status still reports it). */
type ServerOp = ShareImportRow & { user_id: string; body: string; dismissed?: boolean };
let server: Map<string, ServerOp>;
/** Runs once, between share_import_status answering and the next submit (a background upload landing). */
let afterStatus: (() => void) | null;

function serverOp(id: string, userId: string, status: ShareImportStatus, extra: Partial<ServerOp> = {}): ServerOp {
  return {
    id,
    user_id: userId,
    household_id: personal,
    list_id: costco,
    add_to_list: true,
    kind: 'link',
    url: TIKKA_URL,
    title: null,
    page_count: null,
    pages_kept: false,
    status,
    error_code: null,
    resets_at: null,
    created_at: `2026-10-23T12:00:0${server.size}.000Z`,
    body: '',
    ...extra,
  };
}

/** share-ingest: insert … on conflict (id) do nothing; the same id answers the existing operation. */
function ingest(body: string, idempotencyKey: string) {
  const envelope = JSON.parse(body) as { id: string; url?: string; images?: unknown[] };
  if (envelope.id !== idempotencyKey) return httpError(400, 'invalid_request');
  const existing = server.get(envelope.id);
  if (existing) {
    if (existing.body !== body) return httpError(409, 'operation_conflict');
    return { data: { id: envelope.id, status: existing.status }, error: null };
  }
  const shared = envelope.images
    ? { kind: 'photo' as const, url: null, page_count: envelope.images.length, pages_kept: true }
    : { url: envelope.url! };
  server.set(envelope.id, serverOp(envelope.id, USER, 'received', { ...shared, body }));
  return { data: { id: envelope.id, status: 'received' }, error: null };
}

let root: string;
let costco: string;
let personal: string;

beforeEach(() => {
  initI18n('en');
  resetDb();
  resetSupabase();
  resetSyncActivity();
  ensureStarterData(USER);
  costco = createList('Costco');
  personal = getList(getDefaultListId(USER)!)!.householdId;
  supabase.auth.getSession.mockResolvedValue({ data: { session: makeSession(USER) }, error: null });
  server = new Map();
  afterStatus = null;
  onRpc((call) => {
    if (call.fn === 'share_import_status') {
      const ids = (call.args!.p_ids as string[]).map((id) => id.toLowerCase());
      const data = [...server.values()]
        .filter((op) => op.user_id === USER && ids.includes(op.id.toLowerCase()))
        .map(({ id, status }) => ({ id, status }));
      afterStatus?.();
      afterStatus = null;
      return { data };
    }
    if (call.fn === 'retry_share_import') {
      const op = server.get(call.args!.p_id as string);
      if (!op || op.user_id !== USER) return { data: null, error: { code: 'P0002', message: 'not found' } };
      if (op.status === 'failed') Object.assign(op, { status: 'received', error_code: null, resets_at: null });
      return { data: op.status };
    }
    if (call.fn === 'dismiss_share_import') {
      const op = server.get(call.args!.p_id as string);
      if (!op || op.user_id !== USER) return { data: null, error: { code: 'P0002', message: 'not found' } };
      if (op.status !== 'failed') return { data: null, error: { code: '55000', message: 'dismiss_refused' } };
      op.dismissed = true;
      return { data: null };
    }
    return {};
  });
  onQuery((query) => {
    if (query.table !== 'my_share_imports') return {};
    const rows = [...server.values()]
      .filter((op) => op.user_id === USER && op.status !== 'done' && !op.dismissed)
      .map(({ user_id: _user, body: _body, dismissed: _dismissed, ...row }) => row);
    return { data: rows };
  });
  invoke.mockImplementation(async (fn: string, options?: { body?: unknown; headers?: Record<string, string> }) => {
    if (fn !== 'share-ingest') throw new Error(`unexpected function ${fn}`);
    return ingest(options!.body as string, options!.headers!['Idempotency-Key']);
  });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'share-reconcile-'));
  for (const dir of [SHARE_PENDING_DIR, SHARE_UPLOAD_DIR, SHARE_UPLOAD_STATE_DIR]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  setAppGroupRoot(root);
  setShareQueueStatus(EMPTY_SHARE_QUEUE_STATUS);
  mockReportError.mockClear();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Writes a queued share as the extension does, with its upload files when `uploaded`. Returns the file's text. */
function enqueue(
  id: string,
  extra: { userId?: string; url?: string; title?: string; listId?: string | null; householdId?: string; addToList?: boolean } = {},
  uploaded = false,
): string {
  const { title, ...rest } = extra;
  const envelope = {
    id,
    url: TIKKA_URL,
    listId: costco,
    createdAt: '2026-10-23T07:42:05.123-05:00',
    appVersion: '1.2.0',
    source: 'share',
    v: 2,
    userId: USER,
    ...(title ? { page: { title } } : {}),
    ...rest,
  };
  // `userId: undefined` (an older extension's envelope) leaves the key out.
  const body = JSON.stringify(envelope);
  fs.writeFileSync(path.join(root, SHARE_PENDING_DIR, `${id}.json`), body);
  if (uploaded) {
    fs.writeFileSync(path.join(root, SHARE_UPLOAD_DIR, `${id}.json`), body);
    fs.writeFileSync(path.join(root, SHARE_UPLOAD_STATE_DIR, `${id}.json`), JSON.stringify({ startedAt: 'x', attempts: 1 }));
  }
  return body;
}
const filesIn = (dir: string) => fs.readdirSync(path.join(root, dir)).sort();
const pendingFiles = () => filesIn(SHARE_PENDING_DIR);
const submittedIds = () => invoke.mock.calls.map(([, options]) => (options as { headers: Record<string, string> }).headers['Idempotency-Key']);

describe('reconcileShares', () => {
  test('mixed local and server ids: deletes what the server has, submits the rest, shows the server rows', async () => {
    enqueue(E1, {}, true);
    enqueue(E2, { title: 'Pho' }, true);
    const e3Body = enqueue(E3, { title: '  Leek soup ' });
    server.set(E1, serverOp(E1, USER, 'done'));
    server.set(E2, serverOp(E2, USER, 'failed', { title: 'Pho', error_code: 'not_a_recipe' }));

    const result = await reconcileShares(USER);

    expect(result).toEqual({ onServer: [E1, E2], submitted: [E3], refused: [], otherUsers: [], offline: false });
    // The envelope and its upload files go once the server has it.
    expect(pendingFiles()).toEqual([]);
    expect(filesIn(SHARE_UPLOAD_DIR)).toEqual([]);
    expect(filesIn(SHARE_UPLOAD_STATE_DIR)).toEqual([]);
    // Only E3 was submitted: the file as the extension wrote it, with the user's session and its id as the key.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('share-ingest', {
      body: e3Body,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': E3 },
    });
    expect(rpcCallsFor('share_import_status')).toEqual([{ fn: 'share_import_status', args: { p_ids: [E1, E2, E3] } }]);
    // The card: E3 waiting on the server (no Remove), E2 failed with its reason; E1 is done and gone.
    expect(getShareQueueStatus()).toEqual({
      queued: [{ id: E3, url: TIKKA_URL, title: null, listName: 'Costco', householdName: null, onServer: true }],
      failed: [{ id: E2, url: TIKKA_URL, title: 'Pho', errorCode: 'not_a_recipe', resetsAt: null }],
      offline: false,
    });
    expect(queriesFor('my_share_imports').map((q) => q.ops)).toEqual([
      [
        [
          'select',
          'id, household_id, list_id, add_to_list, kind, url, title, page_count, pages_kept, status, error_code, resets_at, created_at',
        ],
        ['neq', 'status', 'done'],
        ['order', 'created_at', { ascending: true }],
      ],
    ]);
    // Nothing is imported on the device: no recipe, no failed_imports row.
    expect(db.select().from(recipes).all()).toEqual([]);
    expect(db.select().from(failedImports).all()).toEqual([]);
  });

  test('an upload that lands while the app submits too is one operation, and no second recipe', async () => {
    const body = enqueue(E1, {}, true);
    // The background upload reaches the server after the status check, before the app's submit.
    afterStatus = () => server.set(E1, serverOp(E1, USER, 'extracting', { body }));

    const result = await reconcileShares(USER);

    expect(result.submitted).toEqual([E1]);
    expect(submittedIds()).toEqual([E1]);
    expect([...server.keys()]).toEqual([E1]);
    expect(server.get(E1)!.status).toBe('extracting');
    expect(pendingFiles()).toEqual([]);
    expect(filesIn(SHARE_UPLOAD_DIR)).toEqual([]);
    expect(db.select().from(recipes).all()).toEqual([]);
    expect(getShareQueueStatus().queued.map((s) => [s.id, s.onServer])).toEqual([[E1, true]]);

    // The next reconcile finds nothing left to do.
    invoke.mockClear();
    expect(await reconcileShares(USER)).toMatchObject({ onServer: [], submitted: [] });
    expect(invoke).not.toHaveBeenCalled();
  });

  test("another user's envelope is kept and never submitted; one without userId counts as the user's", async () => {
    enqueue(E1, { userId: OTHER_USER }, true);
    enqueue(E2, { userId: undefined });
    enqueue(E3, { userId: USER.toUpperCase() });

    const result = await reconcileShares(USER);

    expect(result).toMatchObject({ submitted: [E2, E3], otherUsers: [E1] });
    expect(rpcCallsFor('share_import_status')[0].args).toEqual({ p_ids: [E2, E3] });
    expect(submittedIds()).toEqual([E2, E3]);
    expect(pendingFiles()).toEqual([`${E1}.json`]);
    expect(filesIn(SHARE_UPLOAD_DIR)).toEqual([`${E1}.json`]);
    // Not on this user's card either.
    expect(getShareQueueStatus().queued.map((s) => s.id)).toEqual([E2, E3]);
  });

  test("another user's envelope the server holds for that user is still left alone", async () => {
    enqueue(E1, { userId: OTHER_USER });
    server.set(E1, serverOp(E1, OTHER_USER, 'done'));
    const result = await reconcileShares(USER);
    expect(result).toEqual({ onServer: [], submitted: [], refused: [], otherUsers: [E1], offline: false });
    expect(rpcCallsFor('share_import_status')).toEqual([]);
    expect(pendingFiles()).toEqual([`${E1}.json`]);
  });

  test('a queued photo share (v 3, no url) parses and waits on the card like any envelope', async () => {
    const photo = {
      v: 3,
      id: E2,
      userId: USER,
      images: [{ mediaType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' }],
      listId: costco,
      createdAt: '2026-10-23T07:42:05.123-05:00',
      appVersion: '1.2.0',
      source: 'share',
    };
    fs.writeFileSync(path.join(root, SHARE_PENDING_DIR, `${E2}.json`), JSON.stringify(photo));
    enqueue(E1, { title: 'Pho' });
    onRpc(() => ({ data: null, error: { message: 'TypeError: Network request failed' }, status: 0 }));

    const result = await reconcileShares(USER);

    // Read as the user's (not deleted as unreadable), so it waits like any envelope.
    expect(result).toMatchObject({ offline: true, otherUsers: [] });
    expect(pendingFiles()).toEqual([`${E1}.json`, `${E2}.json`]);
    expect(getShareQueueStatus().queued).toEqual([
      { id: E1, url: TIKKA_URL, title: 'Pho', listName: 'Costco', householdName: null, onServer: false },
      { id: E2, kind: 'photo', pageCount: 1, title: null, listName: 'Costco', householdName: null, onServer: false },
    ]);
  });

  test('offline at the status check: nothing is deleted or submitted, and the card says offline', async () => {
    enqueue(E1, { title: 'Pho' });
    onRpc(() => ({ data: null, error: { message: 'TypeError: Network request failed' }, status: 0 }));

    const result = await reconcileShares(USER);

    expect(result).toMatchObject({ offline: true, onServer: [], submitted: [] });
    expect(invoke).not.toHaveBeenCalled();
    expect(pendingFiles()).toEqual([`${E1}.json`]);
    // Offline, the view isn't read; the envelope shows waiting, removable.
    expect(queriesFor('my_share_imports')).toEqual([]);
    const status = getShareQueueStatus();
    expect(status).toMatchObject({ offline: true, queued: [{ id: E1, title: 'Pho', listName: 'Costco', onServer: false }] });
    expect(importsCardHeading(0, status)).toEqual({
      tone: 'waiting',
      title: '1 recipe waiting',
      subtitle: "You're offline. They'll import when you're back.",
    });
  });

  test('a submit that goes offline stops there and keeps the rest', async () => {
    enqueue(E1);
    enqueue(E2);
    invoke.mockResolvedValueOnce(offline);
    const result = await reconcileShares(USER);
    expect(result).toMatchObject({ offline: true, submitted: [] });
    expect(submittedIds()).toEqual([E1]);
    expect(pendingFiles()).toEqual([`${E1}.json`, `${E2}.json`]);
  });

  test('paused (503), rate-limited (429) or signed out (401): the envelope waits, and so do the rest', async () => {
    for (const [status, code] of [
      [503, 'unavailable'],
      [429, 'rate_limited'],
      [401, 'unauthorized'],
      [500, 'internal'],
    ] as const) {
      invoke.mockClear();
      enqueue(E1);
      enqueue(E2);
      invoke.mockResolvedValueOnce(httpError(status, code));
      const result = await reconcileShares(USER);
      expect(result).toMatchObject({ offline: false, submitted: [], refused: [] });
      expect(submittedIds()).toEqual([E1]);
      expect(pendingFiles()).toEqual([`${E1}.json`, `${E2}.json`]);
    }
  });

  test('refused for good (400, 409, 413, not a member): the envelope is deleted and the next one goes', async () => {
    for (const [status, code] of [
      [400, 'invalid_request'],
      [409, 'operation_conflict'],
      [413, 'payload_too_large'],
      [403, 'not_a_member'],
    ] as const) {
      invoke.mockClear();
      enqueue(E1, {}, true);
      enqueue(E2);
      invoke.mockResolvedValueOnce(httpError(status, code));
      const result = await reconcileShares(USER);
      expect(result).toMatchObject({ refused: [E1], submitted: [E2] });
      expect(pendingFiles()).toEqual([]);
      expect(filesIn(SHARE_UPLOAD_DIR)).toEqual([]);
      expect(mockReportError).toHaveBeenLastCalledWith(new Error(`share-ingest refused a queued share: ${status} ${code}`), {
        area: 'share',
        event: 'share_refused',
      });
      server.clear();
    }
  });

  test("account_mismatch (another account's share) keeps it and goes on", async () => {
    enqueue(E1);
    enqueue(E2);
    invoke.mockResolvedValueOnce(httpError(403, 'account_mismatch'));
    const result = await reconcileShares(USER);
    expect(result).toMatchObject({ submitted: [E2], refused: [] });
    expect(pendingFiles()).toEqual([`${E1}.json`]);
  });

  test("a file that can't be read is deleted and reported; the rest still go", async () => {
    fs.writeFileSync(path.join(root, SHARE_PENDING_DIR, `${E1}.json`), '{ not json');
    enqueue(E2);
    const result = await reconcileShares(USER);
    expect(result.submitted).toEqual([E2]);
    expect(pendingFiles()).toEqual([]);
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError.mock.calls[0][1]).toEqual({ area: 'share', event: 'bad_queued_share' });
  });

  test('with nothing queued it still reads the server, so failures show on every device', async () => {
    server.set(E4, serverOp(E4, USER, 'failed', { error_code: 'daily_limit', resets_at: '2026-10-24T00:00:00.000Z' }));
    server.set(E3, serverOp(E3, OTHER_USER, 'failed'));
    const result = await reconcileShares(USER);
    expect(result).toEqual({ onServer: [], submitted: [], refused: [], otherUsers: [], offline: false });
    expect(rpcCallsFor('share_import_status')).toEqual([]);
    expect(getShareQueueStatus()).toEqual({
      queued: [],
      failed: [{ id: E4, url: TIKKA_URL, title: null, errorCode: 'daily_limit', resetsAt: '2026-10-24T00:00:00.000Z' }],
      offline: false,
    });
  });

  test('a recipe-only share shows its household; reading the view failing keeps the last rows', async () => {
    enqueue(E1, { listId: null, addToList: false, householdId: personal });
    invoke.mockResolvedValueOnce(httpError(503, 'unavailable'));
    const household = db.select().from(households).where(eq(households.id, personal)).get()!;
    await reconcileShares(USER);
    expect(getShareQueueStatus().queued).toEqual([
      { id: E1, url: TIKKA_URL, title: null, listName: null, householdName: household.name, onServer: false },
    ]);

    const failed = { id: E4, url: TIKKA_URL, title: null, errorCode: 'not_a_recipe', resetsAt: null };
    setShareQueueStatus({ ...getShareQueueStatus(), failed: [failed] });
    onQuery(() => ({ data: null, error: { message: 'boom' }, status: 500 }));
    await reconcileShares(USER);
    expect(getShareQueueStatus().failed).toEqual([failed]);
  });
});

describe('isUsersShare', () => {
  test('matches the user case-insensitively, and an envelope without userId is theirs', () => {
    const base = { id: E1, url: TIKKA_URL, createdAt: 'x', appVersion: '1', source: 'share' } as never;
    expect(isUsersShare({ ...(base as object), userId: USER } as never, USER)).toBe(true);
    expect(isUsersShare({ ...(base as object), userId: USER.toUpperCase() } as never, USER)).toBe(true);
    expect(isUsersShare(base, USER)).toBe(true);
    expect(isUsersShare({ ...(base as object), userId: OTHER_USER } as never, USER)).toBe(false);
  });
});

describe('Try again and Remove', () => {
  test('Try again calls retry_share_import with the same id, and the share moves to waiting', async () => {
    server.set(E1, serverOp(E1, USER, 'failed', { error_code: 'limit_reached', resets_at: '2026-11-01T00:00:00.000Z' }));
    const stop = startShareReconcile(USER);
    await runShareReconcile(USER);
    expect(getShareQueueStatus().failed.map((f) => f.id)).toEqual([E1]);

    expect(await retryShareImport(E1)).toBe(true);

    expect(rpcCallsFor('retry_share_import')).toEqual([{ fn: 'retry_share_import', args: { p_id: E1 } }]);
    expect([...server.keys()]).toEqual([E1]);
    expect(getShareQueueStatus()).toMatchObject({ failed: [], queued: [{ id: E1, onServer: true }] });
    stop();
  });

  test('Try again the server refuses gives false and leaves the card', async () => {
    const before = { queued: [], failed: [{ id: E2, url: TIKKA_URL, title: null, errorCode: null, resetsAt: null }], offline: false };
    setShareQueueStatus(before);
    expect(await retryShareImport(E2)).toBe(false);
    expect(getShareQueueStatus()).toBe(before);
  });

  test("Remove deletes an envelope the server doesn't have, with its upload files; one on the server stays", async () => {
    enqueue(E1, {}, true);
    enqueue(E2);
    server.set(E2, serverOp(E2, USER, 'received'));
    onRpc(() => ({ data: null, error: { message: 'Network request failed' }, status: 0 }));
    await reconcileShares(USER);
    // Offline: both still local, neither known to be on the server.
    expect(getShareQueueStatus().queued.map((s) => [s.id, s.onServer])).toEqual([
      [E1, false],
      [E2, false],
    ]);
    expect(removeQueuedShare(E1)).toBe(true);
    expect(pendingFiles()).toEqual([`${E2}.json`]);
    expect(filesIn(SHARE_UPLOAD_DIR)).toEqual([]);
    expect(filesIn(SHARE_UPLOAD_STATE_DIR)).toEqual([]);
    expect(getShareQueueStatus().queued.map((s) => s.id)).toEqual([E2]);

    setShareQueueStatus({ ...getShareQueueStatus(), queued: [{ ...getShareQueueStatus().queued[0], onServer: true }] });
    expect(removeQueuedShare(E2)).toBe(false);
    expect(removeQueuedShare(E3)).toBe(false);
  });
});

describe('Dismiss', () => {
  const thumbsDir = (id: string) => path.join(root, SHARE_THUMBS_DIR, id);
  const keepThumbs = (id: string) => {
    fs.mkdirSync(thumbsDir(id), { recursive: true });
    fs.writeFileSync(path.join(thumbsDir(id), '1.jpg'), 'jpeg');
  };
  const photoFailed = (id: string) =>
    serverOp(id, USER, 'failed', { kind: 'photo', url: null, page_count: 1, pages_kept: true, error_code: 'not_a_recipe' });

  test('a failed share goes off the card and the badge at once, is dismissed on the server, and stays gone', async () => {
    server.set(E1, serverOp(E1, USER, 'failed', { error_code: 'fetch_failed' }));
    server.set(E2, photoFailed(E2));
    server.set(E3, serverOp(E3, USER, 'received'));
    const stop = startShareReconcile(USER);
    await runShareReconcile(USER);
    expect(getShareQueueStatus().failed.map((f) => f.id)).toEqual([E2, E1]);
    expect(importsBadgeCount(getShareQueueStatus(), 0)).toBe(3);
    // (After the reconcile, which prunes these old ids' thumbnails by age.)
    keepThumbs(E2);

    const dismissed = dismissShareImport(E2);
    // Before the server answers: gone from the card and the badge.
    expect(getShareQueueStatus().failed.map((f) => f.id)).toEqual([E1]);
    expect(importsBadgeCount(getShareQueueStatus(), 0)).toBe(2);
    expect(await dismissed).toBe(true);

    expect(rpcCallsFor('dismiss_share_import')).toEqual([{ fn: 'dismiss_share_import', args: { p_id: E2 } }]);
    expect(server.get(E2)!.dismissed).toBe(true);
    expect(fs.existsSync(thumbsDir(E2))).toBe(false);
    await refreshShareImports();
    expect(getShareQueueStatus().failed.map((f) => f.id)).toEqual([E1]);
    expect(importsBadgeCount(getShareQueueStatus(), 0)).toBe(2);

    // A link share too.
    expect(await dismissShareImport(E1)).toBe(true);
    expect(getShareQueueStatus().failed).toEqual([]);
    expect(importsBadgeCount(getShareQueueStatus(), 0)).toBe(1);
    stop();
  });

  test('a read that raced the call (the view still had it) doesn’t bring the row back', async () => {
    server.set(E1, serverOp(E1, USER, 'failed'));
    const stop = startShareReconcile(USER);
    await runShareReconcile(USER);
    let refreshDuring: Promise<void> | null = null;
    onRpc((call) => {
      if (call.fn !== 'dismiss_share_import') return {};
      // The view is read again before the dismiss lands on the server.
      refreshDuring = refreshShareImports();
      return { data: null };
    });
    expect(await dismissShareImport(E1)).toBe(true);
    await refreshDuring;
    expect(getShareQueueStatus().failed).toEqual([]);
    // Once the view leaves it out, it stays gone.
    server.get(E1)!.dismissed = true;
    await refreshShareImports();
    expect(getShareQueueStatus().failed).toEqual([]);
    stop();
  });

  test('a failed call puts the row back where it was and gives false; the thumbnails stay', async () => {
    server.set(E1, serverOp(E1, USER, 'failed', { error_code: 'fetch_failed' }));
    server.set(E2, photoFailed(E2));
    server.set(E3, serverOp(E3, USER, 'failed'));
    await reconcileShares(USER);
    // (After the reconcile, which prunes these old ids' thumbnails by age.)
    keepThumbs(E2);
    const before = getShareQueueStatus().failed;
    expect(before.map((f) => f.id)).toEqual([E3, E2, E1]);
    onRpc(() => ({ data: null, error: { message: 'TypeError: Network request failed' }, status: 0 }));

    const dismissed = dismissShareImport(E2);
    expect(getShareQueueStatus().failed.map((f) => f.id)).toEqual([E3, E1]);
    expect(await dismissed).toBe(false);

    expect(getShareQueueStatus().failed).toEqual(before);
    expect(fs.existsSync(thumbsDir(E2))).toBe(true);
    // It can be dismissed again once the server answers.
    onRpc(() => {
      server.get(E2)!.dismissed = true;
      return { data: null };
    });
    expect(await dismissShareImport(E2)).toBe(true);
    expect(getShareQueueStatus().failed.map((f) => f.id)).toEqual([E3, E1]);
    await reconcileShares(USER);
    expect(getShareQueueStatus().failed.map((f) => f.id)).toEqual([E3, E1]);
  });

  test('the server refusing (not failed any more) brings it back too', async () => {
    server.set(E1, serverOp(E1, USER, 'failed'));
    await reconcileShares(USER);
    // Another device tried it again meanwhile.
    server.get(E1)!.status = 'received';
    expect(await dismissShareImport(E1)).toBe(false);
    expect(getShareQueueStatus().failed.map((f) => f.id)).toEqual([E1]);
  });

  test('a share not on the card, or one already being dismissed, does nothing', async () => {
    expect(await dismissShareImport(E4)).toBe(false);
    expect(rpcCallsFor('dismiss_share_import')).toEqual([]);
    server.set(E1, serverOp(E1, USER, 'failed'));
    await reconcileShares(USER);
    const first = dismissShareImport(E1);
    expect(await dismissShareImport(E1)).toBe(false);
    expect(await first).toBe(true);
    expect(rpcCallsFor('dismiss_share_import')).toHaveLength(1);
    await reconcileShares(USER);
    expect(getShareQueueStatus().failed).toEqual([]);
  });
});

describe('startShareReconcile', () => {
  test('reconciles at once, refreshes the card after a pull and on demand, and clears it on stop', async () => {
    enqueue(E1);
    const stop = startShareReconcile(USER);
    await runShareReconcile(USER);
    expect(submittedIds()).toEqual([E1]);
    expect(getShareQueueStatus().queued.map((s) => s.id)).toEqual([E1]);
    const reads = () => queriesFor('my_share_imports').length;
    const before = reads();

    // The import finished on the server: a pull (Realtime's) ends, and the card reads it again.
    server.get(E1)!.status = 'done';
    reportSyncActivity({ pulling: true });
    expect(reads()).toBe(before);
    reportSyncActivity({ pulling: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads()).toBe(before + 1);
    expect(getShareQueueStatus().queued).toEqual([]);

    // A recipe-import push arriving refreshes it the same way; another kind of push doesn't.
    server.set(E2, serverOp(E2, USER, 'failed', { error_code: 'not_a_member' }));
    push({ kind: 'items_added', url: '/list/x' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads()).toBe(before + 1);
    push({ kind: 'recipe_import', status: 'failed', shareImportId: E2, url: '/recipes' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads()).toBe(before + 2);
    expect(getShareQueueStatus().failed.map((f) => [f.id, f.errorCode])).toEqual([[E2, 'not_a_member']]);
    // Submits nothing.
    expect(submittedIds()).toEqual([E1]);

    stop();
    expect(mockPushListeners.size).toBe(0);
    expect(getShareQueueStatus()).toEqual(EMPTY_SHARE_QUEUE_STATUS);
    // Stopped (signed out): a refresh does nothing.
    await refreshShareImports();
    expect(getShareQueueStatus()).toEqual(EMPTY_SHARE_QUEUE_STATUS);
  });

  test('a reconcile asked for while one runs runs once more after, not at the same time', async () => {
    enqueue(E1);
    let release!: () => void;
    invoke.mockImplementationOnce(
      (async (_fn: string, options?: { body?: unknown; headers?: Record<string, string> }) => {
        await new Promise<void>((resolve) => (release = resolve));
        return ingest(options!.body as string, options!.headers!['Idempotency-Key']);
      }) as never,
    );
    const first = runShareReconcile(USER);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = runShareReconcile(USER);
    expect(second).toBe(first);
    release();
    await first;
    // Twice in all: the second run found E1 on the server and submitted nothing.
    expect(rpcCallsFor('share_import_status')).toHaveLength(1);
    expect(submittedIds()).toEqual([E1]);
    expect(queriesFor('my_share_imports')).toHaveLength(2);
  });
});

describe('photo shares', () => {
  /** When E1 was made: the clock the thumbnail tests run against is an hour after. */
  const T0 = uuidv7Time(E1)!;
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const now = () => T0 + HOUR;
  /** A UUIDv7 made at `ms`, told apart by `n`. */
  const idAt = (ms: number, n: number) => {
    const hex = ms.toString(16).padStart(12, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${n.toString(16).padStart(12, '0')}`;
  };
  const goOffline = () => onRpc(() => ({ data: null, error: { message: 'TypeError: Network request failed' }, status: 0 }));

  function writeThumbs(id: string, pages = 2) {
    const dir = path.join(root, SHARE_THUMBS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    for (let n = 1; n <= pages; n++) fs.writeFileSync(path.join(dir, `${n}.jpg`), 'jpeg');
  }
  const thumbIds = () => (fs.existsSync(path.join(root, SHARE_THUMBS_DIR)) ? filesIn(SHARE_THUMBS_DIR) : []);

  /** Writes a queued photo share (v 3) as the extension does: its thumbnails, then the envelope. */
  function enqueuePhoto(
    id: string,
    options: { pages?: number; pageData?: string; listId?: string | null; householdId?: string; addToList?: boolean } = {},
    uploaded = false,
  ): string {
    const { pages = 2, pageData = '/9j/4AAQSkZJRg==', ...extra } = options;
    writeThumbs(id, pages);
    const envelope = {
      v: 3,
      id,
      userId: USER,
      images: Array.from({ length: pages }, () => ({ mediaType: 'image/jpeg', data: pageData })),
      listId: costco,
      createdAt: '2026-10-23T07:42:05.123-05:00',
      appVersion: '1.3.0',
      source: 'share',
      ...extra,
    };
    const body = JSON.stringify(envelope);
    fs.writeFileSync(path.join(root, SHARE_PENDING_DIR, `${id}.json`), body);
    if (uploaded) {
      fs.writeFileSync(path.join(root, SHARE_UPLOAD_DIR, `${id}.json`), body);
      fs.writeFileSync(path.join(root, SHARE_UPLOAD_STATE_DIR, `${id}.json`), JSON.stringify({ startedAt: 'x', attempts: 1 }));
    }
    return body;
  }
  const photoOp = (id: string, status: ShareImportStatus, extra: Partial<ServerOp> = {}) =>
    serverOp(id, USER, status, { kind: 'photo', url: null, page_count: 2, pages_kept: true, ...extra });

  test('a photo envelope of about 3 MB is submitted as written and cleared; its thumbnails stay for the card', async () => {
    // Three pages of ~750 KB each: a body over link shares' 2.5 MB cap.
    const body = enqueuePhoto(E1, { pages: 3, pageData: 'A'.repeat(1_000_000) }, true);
    expect(body.length).toBeGreaterThan(3_000_000);

    const result = await reconcileShares(USER, { now });

    expect(result).toEqual({ onServer: [], submitted: [E1], refused: [], otherUsers: [], offline: false });
    expect(invoke).toHaveBeenCalledWith('share-ingest', {
      body,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': E1 },
    });
    expect(pendingFiles()).toEqual([]);
    expect(filesIn(SHARE_UPLOAD_DIR)).toEqual([]);
    expect(filesIn(SHARE_UPLOAD_STATE_DIR)).toEqual([]);
    expect(thumbIds()).toEqual([E1]);
    expect(filesIn(`${SHARE_THUMBS_DIR}/${E1}`)).toEqual(['1.jpg', '2.jpg', '3.jpg']);
    const [share] = getShareQueueStatus().queued;
    expect(share).toEqual({ id: E1, kind: 'photo', pageCount: 3, title: null, listName: 'Costco', householdName: null, onServer: true });
    expect(shareName(share)).toBe('From a photo');
    expect(queuedShareDetail(share)).toBe('3 pages · to Costco');
  });

  test('waiting rows describe a photo share: "From a photo", its pages and where it goes', async () => {
    enqueuePhoto(E1, { pages: 1, listId: null, addToList: false, householdId: personal });
    enqueuePhoto(E2, { pages: 2 });
    goOffline();
    const household = db.select().from(households).where(eq(households.id, personal)).get()!;

    await reconcileShares(USER, { now });

    const { queued } = getShareQueueStatus();
    expect(queued.map((s) => [shareName(s), queuedShareDetail(s), s.onServer])).toEqual([
      ['From a photo', `1 page · to ${household.name}`, false],
      ['From a photo', '2 pages · to Costco', false],
    ]);
    // Offline: nothing pruned.
    expect(thumbIds()).toEqual([E1, E2]);
  });

  test('a failed photo row comes with its page count, whether the server kept the pages, and where it was going', async () => {
    server.set(E1, photoOp(E1, 'failed', { error_code: 'not_a_recipe', title: 'ignored' }));
    server.set(E2, photoOp(E2, 'failed', { error_code: 'fetch_failed', page_count: 3, pages_kept: false }));
    server.set(E3, photoOp(E3, 'failed', { page_count: 1, add_to_list: false, list_id: null }));
    const home = db.select().from(households).where(eq(households.id, personal)).get()!.name;

    await reconcileShares(USER, { now });

    const { failed } = getShareQueueStatus();
    expect(failed).toEqual([
      { kind: 'photo', pageCount: 1, pagesKept: true, id: E3, title: null, errorCode: null, resetsAt: null, listName: null, householdName: home },
      { kind: 'photo', pageCount: 3, pagesKept: false, id: E2, title: null, errorCode: 'fetch_failed', resetsAt: null, listName: 'Costco', householdName: null },
      { kind: 'photo', pageCount: 2, pagesKept: true, id: E1, title: null, errorCode: 'not_a_recipe', resetsAt: null, listName: 'Costco', householdName: null },
    ]);
    expect(failed.map(shareName)).toEqual(['From a photo', 'From a photo', 'From a photo']);
    expect(failed.map((f) => (f.kind === 'photo' ? photoShareDetail(f) : null))).toEqual([
      `1 page · to ${home}`,
      '3 pages · to Costco',
      '2 pages · to Costco',
    ]);
  });

  test('thumbnails: pruned when done, dismissed, gone from the server, pages not kept or over 7 days; kept while waiting or failed with pages', async () => {
    const waiting = idAt(T0, 1); // its envelope waits (the server is busy)
    const running = idAt(T0, 2);
    const failedKept = idAt(T0, 3);
    const failedGone = idAt(T0, 4);
    const done = idAt(T0, 5);
    const dismissed = idAt(T0, 6);
    const absent = idAt(T0, 7);
    const justWritten = idAt(now() - SHARE_THUMBS_GRACE_MS + 60_000, 8); // its envelope is on its way
    const old = idAt(now() - SHARE_THUMBS_MAX_AGE_MS - 1, 9);
    enqueuePhoto(waiting);
    invoke.mockResolvedValueOnce(httpError(503, 'unavailable'));
    for (const id of [running, failedKept, failedGone, done, dismissed, absent, justWritten, old]) writeThumbs(id);
    server.set(running, photoOp(running, 'extracting'));
    server.set(failedKept, photoOp(failedKept, 'failed'));
    server.set(failedGone, photoOp(failedGone, 'failed', { pages_kept: false }));
    server.set(done, photoOp(done, 'done', { pages_kept: false }));
    server.set(dismissed, photoOp(dismissed, 'failed', { dismissed: true }));
    server.set(old, photoOp(old, 'failed'));

    await reconcileShares(USER, { now });

    expect(thumbIds()).toEqual([waiting, running, failedKept, justWritten].sort());
    // The waiting envelope is untouched.
    expect(pendingFiles()).toEqual([`${waiting}.json`]);

    // Once the grace has passed, thumbnails with neither an envelope nor a row go too.
    invoke.mockResolvedValueOnce(httpError(503, 'unavailable'));
    await reconcileShares(USER, { now: () => now() + SHARE_THUMBS_GRACE_MS });
    expect(thumbIds()).toEqual([waiting, running, failedKept].sort());
  });

  test('offline, thumbnails are only pruned for age, even with the envelope still waiting', async () => {
    const old = idAt(T0 - 8 * DAY, 1);
    enqueuePhoto(old);
    enqueuePhoto(E1);
    writeThumbs(E2); // no envelope, and the server's rows are unknown
    goOffline();

    await reconcileShares(USER, { now });

    expect(thumbIds()).toEqual([E1, E2]);
    expect(pendingFiles()).toEqual([`${old}.json`, `${E1}.json`]);
  });

  test('a photo share the server refuses loses its thumbnails at once; Remove deletes them with the envelope', async () => {
    enqueuePhoto(E1);
    enqueuePhoto(E2);
    enqueuePhoto(E3, {}, true);
    invoke.mockResolvedValueOnce(httpError(413, 'too_large')).mockResolvedValueOnce(httpError(503, 'unavailable'));

    // With the clock right at the shares, the refused one's thumbnails don't wait for the age rules.
    const result = await reconcileShares(USER, { now: () => T0 });

    expect(result.refused).toEqual([E1]);
    expect(thumbIds()).toEqual([E2, E3]);
    expect(removeQueuedShare(E3)).toBe(true);
    expect(pendingFiles()).toEqual([`${E2}.json`]);
    expect(filesIn(SHARE_UPLOAD_DIR)).toEqual([]);
    expect(thumbIds()).toEqual([E2]);
  });

  test('envelopes are read and parsed in full once, not at every reconcile', async () => {
    enqueuePhoto(E1, { pages: 3, pageData: 'A'.repeat(1_000_000) });
    goOffline();
    const parse = jest.spyOn(JSON, 'parse');
    const bigParses = () => parse.mock.calls.filter(([text]) => typeof text === 'string' && text.length > 1_000_000).length;

    await reconcileShares(USER, { now });
    await reconcileShares(USER, { now });
    await reconcileShares(USER, { now });

    expect(bigParses()).toBe(1);
    expect(getShareQueueStatus().queued).toMatchObject([{ id: E1, kind: 'photo', pageCount: 3 }]);
  });

  test('a link envelope next to a photo one is unchanged: no kind, its url, title and host', async () => {
    enqueue(E1, { title: 'Pho' });
    enqueuePhoto(E2);
    goOffline();

    await reconcileShares(USER, { now });

    const [link] = getShareQueueStatus().queued;
    expect(link).toEqual({ id: E1, url: TIKKA_URL, title: 'Pho', listName: 'Costco', householdName: null, onServer: false });
    expect([shareName(link), queuedShareDetail(link)]).toEqual(['Pho', 'example.com · to Costco']);
  });
});
