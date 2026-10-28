import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, failedImports, households, recipes } from '@/db';
import { createList, ensureStarterData, getDefaultListId, getList } from '@/features/lists/lists';
import { SHARE_PENDING_DIR, SHARE_UPLOAD_DIR, SHARE_UPLOAD_STATE_DIR } from '@/features/siri/app-group';
import { initI18n } from '@/i18n';
import { reportSyncActivity, resetSyncActivity } from '@/sync/activity';
import { resetDb } from '@/test/db';
import { setAppGroupRoot } from '@/test/fake-file-system';
import { makeSession, onQuery, onRpc, queriesFor, resetSupabase, rpcCallsFor, supabase } from '@/test/fake-supabase';

import {
  isUsersShare,
  reconcileShares,
  refreshShareImports,
  removeQueuedShare,
  retryShareImport,
  runShareReconcile,
  startShareReconcile,
  type ShareImportRow,
  type ShareImportStatus,
} from '../share-reconcile';
import { EMPTY_SHARE_QUEUE_STATUS, getShareQueueStatus, importsCardHeading, setShareQueueStatus } from '../share-queue-status';

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

type ServerOp = ShareImportRow & { user_id: string; body: string };
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
    url: TIKKA_URL,
    title: null,
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
  const envelope = JSON.parse(body) as { id: string; url: string };
  if (envelope.id !== idempotencyKey) return httpError(400, 'invalid_request');
  const existing = server.get(envelope.id);
  if (existing) {
    if (existing.body !== body) return httpError(409, 'operation_conflict');
    return { data: { id: envelope.id, status: existing.status }, error: null };
  }
  server.set(envelope.id, serverOp(envelope.id, USER, 'received', { url: envelope.url, body }));
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
    return {};
  });
  onQuery((query) => {
    if (query.table !== 'my_share_imports') return {};
    const rows = [...server.values()]
      .filter((op) => op.user_id === USER && op.status !== 'done')
      .map(({ user_id: _user, body: _body, ...row }) => row);
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
        ['select', 'id, household_id, list_id, add_to_list, url, title, status, error_code, resets_at, created_at'],
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

  test('a queued photo share (v 3, no url) parses but is not on the card yet', async () => {
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
    expect(getShareQueueStatus().queued.map((s) => s.id)).toEqual([E1]);
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
