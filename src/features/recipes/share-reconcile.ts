// Reconciles the share queue with the server (spec 4.10 step 5): recipes shared to the extension
// are imported on the server, so the app only makes sure each of the user's envelopes reaches
// `share-ingest`, deletes the ones the server has, and shows the user's share imports
// (`my_share_imports`) on the imports card. Runs on launch, foreground, reconnect and sign-in;
// signed out, envelopes wait. The app never extracts or saves a share itself.
import { eq } from 'drizzle-orm';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { db, households } from '@/db';
import { startCatchUpTriggers } from '@/features/categories/catch-up';
import { getList } from '@/features/lists/lists';
import { getAppGroupContainer, readPendingShares, removeShareFiles, type PendingShare } from '@/features/siri/app-group';
import { supabase } from '@/lib/supabase';
import { reportError } from '@/lib/sentry';
import { shareAddsToList, type ShareEnvelope } from '@/shared';
import { getSyncActivity, subscribeSyncActivity } from '@/sync/activity';

import { resolveImportTarget, type RequestedTarget } from './import-target';
import {
  EMPTY_SHARE_QUEUE_STATUS,
  getShareQueueStatus,
  setShareQueueStatus,
  type FailedShareImport,
  type QueuedShare,
} from './share-queue-status';

/** A `share_imports` status (5). */
export type ShareImportStatus = 'received' | 'extracting' | 'extracted' | 'committing' | 'done' | 'failed';

/** The `my_share_imports` columns the card needs. */
export type ShareImportRow = {
  id: string;
  household_id: string;
  list_id: string | null;
  add_to_list: boolean;
  url: string;
  title: string | null;
  status: ShareImportStatus;
  error_code: string | null;
  resets_at: string | null;
  created_at: string;
};

const ROW_COLUMNS = 'id, household_id, list_id, add_to_list, url, title, status, error_code, resets_at, created_at';

export type ShareReconcileOptions = {
  /** The queue, oldest first. Defaults to the App Group's, or none without it (Expo Go, Android). */
  pending?: () => PendingShare[];
};

export type ShareReconcileResult = {
  /** Envelopes the server already had, deleted here. */
  onServer: string[];
  /** Envelopes submitted to `share-ingest` and accepted, deleted here. */
  submitted: string[];
  /** Envelopes the server refused for good (bad request, conflict, too large), deleted here. */
  refused: string[];
  /** Another user's envelopes, left alone. */
  otherUsers: string[];
  /** The server couldn't be reached; envelopes it doesn't have wait for next time. */
  offline: boolean;
};

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** An envelope without `userId` (an older extension) counts as the signed-in user's. */
export function isUsersShare(envelope: ShareEnvelope, userId: string): boolean {
  return envelope.userId === undefined || sameId(envelope.userId, userId);
}

function defaultPending(): PendingShare[] {
  return getAppGroupContainer() ? readPendingShares() : [];
}

function isNetworkError(error: unknown): boolean {
  const { name, message, status } = (error ?? {}) as { name?: unknown; message?: unknown; status?: unknown };
  if (name === 'FunctionsFetchError' || status === 0) return true;
  return typeof message === 'string' && /network request failed|failed to fetch|fetch failed|network error/i.test(message);
}

/** The status and error code of a `functions.invoke` HTTP error. */
async function httpError(error: unknown): Promise<{ status: number | undefined; code: string | undefined }> {
  const response = (error as { context?: { status?: number; json?: () => Promise<unknown> } } | null)?.context;
  let code: string | undefined;
  try {
    const body = (await response?.json?.()) as { error?: unknown } | undefined;
    if (typeof body?.error === 'string') code = body.error;
  } catch {
    // Not a JSON body; the status says enough.
  }
  return { status: response?.status, code };
}

type Submitted = 'accepted' | 'refused' | 'wait' | 'offline' | 'skip';

/**
 * Submits one envelope to `share-ingest` with the user's session and the envelope id as the
 * idempotency key, sending the file as the extension wrote it, so a background upload of the same
 * share has the same payload and is the same operation. Accepted (202, new or already there):
 * `accepted`. Refused for good (400, 409, 413, or 403 `not_a_member`): `refused`. Another account's
 * share (403 `account_mismatch`): `skip`. Offline: `offline`. Anything else (401, 429, 5xx, the kill
 * switch's 503) waits for the next reconcile: `wait`.
 */
async function submit(item: PendingShare & { ok: true }): Promise<Submitted> {
  let body: string;
  try {
    body = item.file.textSync();
  } catch (err) {
    console.warn('[share] reading a queued share failed', item.envelope.id, err);
    return 'skip';
  }
  const { error } = await supabase.functions.invoke('share-ingest', {
    body,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': item.envelope.id },
  });
  if (!error) return 'accepted';
  if (isNetworkError(error)) return 'offline';
  const { status, code } = await httpError(error);
  if (status === 403 && code === 'account_mismatch') return 'skip';
  if (status === 400 || status === 409 || status === 413 || (status === 403 && code === 'not_a_member')) {
    reportError(new Error(`share-ingest refused a queued share: ${status} ${code ?? ''}`.trim()), {
      area: 'share',
      event: 'share_refused',
    });
    return 'refused';
  }
  return 'wait';
}

function householdName(id: string): string | null {
  return db.select({ name: households.name }).from(households).where(eq(households.id, id)).get()?.name ?? null;
}

/** Where a share goes, as a list name or (recipe-only) a household name, with the import's fallbacks. */
function destinationNames(requested: RequestedTarget, userId: string): Pick<QueuedShare, 'listName' | 'householdName'> {
  const target = resolveImportTarget(requested, userId);
  return {
    listName: target?.listId ? (getList(target.listId)?.name ?? null) : null,
    householdName: target?.householdId ? householdName(target.householdId) : null,
  };
}

function envelopeRequested(envelope: ShareEnvelope): RequestedTarget {
  return shareAddsToList(envelope)
    ? { addToList: true, listId: envelope.listId ?? null }
    : { addToList: false, householdId: envelope.householdId ?? null };
}

function rowRequested(row: ShareImportRow): RequestedTarget {
  return row.add_to_list ? { addToList: true, listId: row.list_id } : { addToList: false, householdId: row.household_id };
}

const RUNNING: ReadonlySet<ShareImportStatus> = new Set(['received', 'extracting', 'extracted', 'committing']);

/**
 * The card's state from the user's envelopes and `rows` (null: unknown, keep the last ones read):
 * envelopes the server doesn't have, then the server's running imports, both oldest first; and the
 * failed ones, newest first.
 */
function publish(userId: string, envelopes: ShareEnvelope[], rows: ShareImportRow[] | null, offline: boolean): void {
  const last = getShareQueueStatus();
  const serverQueued = rows ? rows.filter((row) => RUNNING.has(row.status)) : null;
  const known = new Set((rows ?? []).map((row) => row.id.toLowerCase()));
  // Photo shares (no url) aren't on the card yet.
  const local: QueuedShare[] = envelopes
    .filter((envelope) => !known.has(envelope.id.toLowerCase()))
    .flatMap((envelope) =>
      envelope.url === undefined
        ? []
        : [
            {
              id: envelope.id,
              url: envelope.url,
              title: envelope.page?.title?.trim() || null,
              ...destinationNames(envelopeRequested(envelope), userId),
              onServer: false,
            },
          ],
    );
  const running: QueuedShare[] = serverQueued
    ? [...serverQueued]
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((row) => ({
          id: row.id,
          url: row.url,
          title: row.title?.trim() || null,
          ...destinationNames(rowRequested(row), userId),
          onServer: true,
        }))
    : last.queued.filter((share) => share.onServer);
  const failed: FailedShareImport[] = rows
    ? rows
        .filter((row) => row.status === 'failed')
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((row) => ({ id: row.id, url: row.url, title: row.title?.trim() || null, errorCode: row.error_code, resetsAt: row.resets_at }))
    : last.failed;
  setShareQueueStatus({ queued: [...local, ...running], failed, offline });
}

/** The user's share imports that aren't done, or null when they couldn't be read. */
async function readServerRows(): Promise<ShareImportRow[] | null> {
  const { data, error } = await supabase
    .from('my_share_imports')
    .select(ROW_COLUMNS)
    .neq('status', 'done')
    .order('created_at', { ascending: true });
  if (error) {
    console.warn('[share] reading share imports failed', error);
    return null;
  }
  return (data ?? []) as ShareImportRow[];
}

/** Reads the queue, deleting files that can't be read. Returns the user's envelopes and the rest. */
function readQueue(userId: string, pending: () => PendingShare[]) {
  const mine: (PendingShare & { ok: true })[] = [];
  const others: string[] = [];
  for (const item of pending()) {
    if (!item.ok) {
      console.warn('[share] dropping a bad queued share', item.fileName, item.error);
      reportError(new Error(`Dropped a queued share that couldn't be read: ${item.error.slice(0, 200)}`), {
        area: 'share',
        event: 'bad_queued_share',
      });
      try {
        item.file.delete();
      } catch (err) {
        console.warn('[share] deleting a bad queued share failed', item.fileName, err);
      }
      continue;
    }
    if (isUsersShare(item.envelope, userId)) mine.push(item);
    else others.push(item.envelope.id);
  }
  return { mine, others };
}

/**
 * Reconciles `userId`'s envelopes with the server once: asks `share_import_status` which ids it
 * has and deletes those envelopes with their upload files; submits the rest, oldest first, deleting
 * each once the server accepts it; then reads `my_share_imports` and publishes the card's state.
 * Another user's envelopes are left alone and never submitted. Offline, or with the server busy,
 * the rest wait for the next reconcile. Never throws.
 */
export async function reconcileShares(userId: string, options: ShareReconcileOptions = {}): Promise<ShareReconcileResult> {
  const { pending = defaultPending } = options;
  const result: ShareReconcileResult = { onServer: [], submitted: [], refused: [], otherUsers: [], offline: false };
  try {
    const { mine, others } = readQueue(userId, pending);
    result.otherUsers = others;
    if (mine.length > 0) {
      const { data, error } = await supabase.rpc('share_import_status', { p_ids: mine.map((item) => item.envelope.id) });
      if (error) {
        result.offline = isNetworkError(error);
        if (!result.offline) console.warn('[share] share_import_status failed', error);
      } else {
        const known = new Set(((data ?? []) as { id: string }[]).map((row) => row.id.toLowerCase()));
        for (const item of mine) {
          const { id } = item.envelope;
          if (known.has(id.toLowerCase())) {
            removeShareFiles(id);
            result.onServer.push(id);
            continue;
          }
          const outcome = await submit(item);
          if (outcome === 'accepted' || outcome === 'refused') {
            removeShareFiles(id);
            result[outcome === 'accepted' ? 'submitted' : 'refused'].push(id);
          } else if (outcome === 'offline') {
            result.offline = true;
            break;
          } else if (outcome === 'wait') {
            break;
          }
        }
      }
    }
  } catch (err) {
    console.warn('[share] reconciling shares failed', err);
    reportError(err, { area: 'share', event: 'reconcile_failed' });
  }
  await refresh(userId, pending, result.offline);
  return result;
}

/** Reads the envelopes and `my_share_imports` again and publishes the card's state. Never throws. */
async function refresh(userId: string, pending: () => PendingShare[], offline: boolean): Promise<void> {
  try {
    const rows = offline ? null : await readServerRows();
    const envelopes = pending().flatMap((item) => (item.ok && isUsersShare(item.envelope, userId) ? [item.envelope] : []));
    publish(userId, envelopes, rows, offline);
  } catch (err) {
    console.warn('[share] reading the share imports failed', err);
  }
}

let running: Promise<ShareReconcileResult> | null = null;
let again = false;
/** The signed-in user's reconcile, while started: what a push, a pull or the card refreshes with. */
let active: { userId: string; options: ShareReconcileOptions } | null = null;

/**
 * Reconciles now. A call while one runs makes it run once more after (with what's queued by
 * then) and shares its promise.
 */
export function runShareReconcile(userId: string, options?: ShareReconcileOptions): Promise<ShareReconcileResult> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      let result = await reconcileShares(userId, options);
      while (again) {
        again = false;
        result = await reconcileShares(userId, options);
      }
      return result;
    } finally {
      running = null;
      again = false;
    }
  })();
  return running;
}

/**
 * Reads the card's state again without submitting anything: when a recipe-import push arrives,
 * after a pull (Realtime's or a foreground's), and after Try again. Does nothing when not started.
 * Never throws.
 */
export async function refreshShareImports(): Promise<void> {
  if (!active) return;
  await refresh(active.userId, active.options.pending ?? defaultPending, false);
}

/**
 * Takes a waiting share the server doesn't have yet off the card (Remove): deletes its envelope and
 * upload files. One the server has can't be removed. Returns whether it was.
 */
export function removeQueuedShare(id: string): boolean {
  const current = getShareQueueStatus();
  const share = current.queued.find((s) => sameId(s.id, id));
  if (!share || share.onServer) return false;
  removeShareFiles(share.id);
  setShareQueueStatus({ ...current, queued: current.queued.filter((s) => s !== share) });
  return true;
}

/**
 * Try again on a failed share: `retry_share_import` puts the same operation (same id) back on the
 * server, never charged again, and the card reads it again (it shows as waiting). Returns whether
 * the server took it.
 */
export async function retryShareImport(id: string): Promise<boolean> {
  const { error } = await supabase.rpc('retry_share_import', { p_id: id });
  if (error) {
    console.warn('[share] retry_share_import failed', error);
    return false;
  }
  await refreshShareImports();
  return true;
}

/** A recipe-import push (4.13): a share import finished or failed. */
export function isRecipeImportPush(notification: Notifications.Notification): boolean {
  return notification.request.content.data?.kind === 'recipe_import';
}

/**
 * Reconciles now, on every foreground and reconnect, and refreshes the card after each pull
 * (Realtime's included) and when a recipe-import push arrives while the app is open. Returns a stop
 * function, which clears the card (sign-out).
 */
export function startShareReconcile(userId: string, options: ShareReconcileOptions = {}): () => void {
  active = { userId, options };
  void runShareReconcile(userId, options);
  const stopTriggers = startCatchUpTriggers(() => void runShareReconcile(userId, options));
  let pulling = getSyncActivity().pulling;
  const stopPulls = subscribeSyncActivity(() => {
    const now = getSyncActivity().pulling;
    if (pulling && !now) void refreshShareImports();
    pulling = now;
  });
  const pushes =
    Platform.OS === 'web'
      ? null
      : Notifications.addNotificationReceivedListener((notification) => {
          if (isRecipeImportPush(notification)) void refreshShareImports();
        });
  return () => {
    stopTriggers();
    stopPulls();
    pushes?.remove();
    if (active?.userId === userId) active = null;
    setShareQueueStatus(EMPTY_SHARE_QUEUE_STATUS);
  };
}
