// Imports the share queue (spec 4.10): recipes shared to the extension while the app was closed,
// on launch, foreground, reconnect and sign-in, next to the Siri queue. Signed out, shares wait.
import { eq } from 'drizzle-orm';

import { db, households } from '@/db';
import { startCatchUpTriggers } from '@/features/categories/catch-up';
import { getList } from '@/features/lists/lists';
import { clearDeviceSetting, getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { getAppGroupContainer, readPendingShares, type PendingShare } from '@/features/siri/app-group';
import { reportError } from '@/lib/sentry';
import { shareAddsToList, type ShareEnvelope } from '@/shared';

import { recordFailedImport } from './failed-imports';
import { importRecipe, type ImportRecipeError, type ImportRecipeSuccess, type ImportTarget } from './import';
import { recordedTarget, resolveImportTarget, type RequestedTarget } from './import-target';
import {
  EMPTY_SHARE_QUEUE_STATUS,
  getShareQueueStatus,
  setShareQueueStatus,
  type QueuedShare,
  type ShareQueueStatus,
} from './share-queue-status';

/** Tries per envelope before a share that keeps failing is recorded as a failed import. */
export const MAX_SHARE_ATTEMPTS = 5;

/** The device setting counting an envelope's failed tries. */
export function shareAttemptsKey(envelopeId: string): string {
  return `shareImportAttempts:${envelopeId}`;
}

/** A share that won't import, for the Recipes tab's failed imports (spec 4.10). */
export type FailedShare = {
  url: string;
  /** The page title Safari captured; other apps give none. */
  title: string | null;
  reason: ImportRecipeError['error'];
  /**
   * Where it was going, so Try again goes there too: a list and its household, or a household
   * alone. Absent or null: the default list.
   */
  householdId?: string | null;
  listId?: string | null;
};

export type ShareDrainOptions = {
  /** The queue, oldest first. */
  pending?: () => PendingShare[];
  /** Records a share that won't import. Defaults to the `failed_imports` table. */
  recordFailed?: (failed: FailedShare) => void;
};

export type ShareDrainResult = {
  /** Shares imported by this drain, oldest first. */
  imported: ImportRecipeSuccess[];
  /** Shares recorded as failed imports and deleted. */
  failed: number;
};

function remove(item: PendingShare): void {
  try {
    item.file.delete();
  } catch (err) {
    // Left behind, it's imported again next time, which the import id keeps to one recipe.
    console.warn('[share] deleting a queued share failed', item.file.name, err);
  }
}

function failedShare(envelope: ShareEnvelope, reason: FailedShare['reason'], target: ImportTarget): FailedShare {
  return { url: envelope.url, title: envelope.page?.title?.trim() || null, reason, ...recordedTarget(target) };
}

/** What the share asked for: a list (null: the default), or recipe-only into a household. */
function requestedTarget(envelope: ShareEnvelope): RequestedTarget {
  return shareAddsToList(envelope)
    ? { addToList: true, listId: envelope.listId }
    : { addToList: false, householdId: envelope.householdId ?? null };
}

/** Where a share imports now (spec 4.10): falls back when its list or household is gone. */
export function shareImportTarget(envelope: ShareEnvelope, userId: string): ImportTarget | null {
  return resolveImportTarget(requestedTarget(envelope), userId);
}

function householdName(id: string): string | null {
  return db.select({ name: households.name }).from(households).where(eq(households.id, id)).get()?.name ?? null;
}

/** The queue as the imports card shows it: readable shares, oldest first, with where they go and tries. */
function queuedShares(items: PendingShare[], userId: string): QueuedShare[] {
  return items.flatMap((item) => {
    if (!item.ok) return [];
    const { envelope } = item;
    const target = shareImportTarget(envelope, userId);
    return [
      {
        id: envelope.id,
        url: envelope.url,
        title: envelope.page?.title?.trim() || null,
        listName: target?.listId ? (getList(target.listId)?.name ?? null) : null,
        householdName: target?.householdId ? householdName(target.householdId) : null,
        attempts: getDeviceSetting(shareAttemptsKey(envelope.id), 0),
      },
    ];
  });
}

/** Reads the queue again and publishes it for the imports card. */
function publishStatus(
  userId: string,
  pending: () => PendingShare[],
  importing: ShareQueueStatus['importing'],
  waitReason: ShareQueueStatus['waitReason'],
  resetsAt?: string,
): void {
  try {
    const queued = queuedShares(pending(), userId);
    const reason = queued.length > 0 ? waitReason : null;
    setShareQueueStatus({ queued, importing, waitReason: reason, ...(reason === 'limit_reached' && resetsAt ? { resetsAt } : {}) });
  } catch (err) {
    console.warn('[share] reading the queue failed', err);
  }
}

let draining = false;
/** Shares removed from the card while a drain is running, which that drain then skips. */
const removed = new Set<string>();

/**
 * Imports `pending` (oldest first) as `userId`, one at a time, deleting each file once imported.
 * Bad files are logged and deleted. "Not a recipe" and "not in your plan" are recorded as failed at once; other failures
 * keep the file and count a try, and the fifth is recorded as failed. Offline or rate-limited, the
 * rest wait for the next drain, as they would fail the same way. Past the plan's monthly imports
 * (`limit_reached`) or the user's imports today (`daily_limit`), the share keeps its file without
 * counting a try, and the rest wait too. One drain at a time: a drain
 * started during another does nothing.
 */
export async function drainShareQueue(userId: string, options: ShareDrainOptions = {}): Promise<ShareDrainResult> {
  const { pending = readPendingShares, recordFailed = recordFailedImport } = options;
  const result: ShareDrainResult = { imported: [], failed: 0 };
  if (draining) return result;
  draining = true;
  let waitReason: ShareQueueStatus['waitReason'] = null;
  let resetsAt: string | undefined;
  try {
    const items = pending();
    const total = items.filter((item) => item.ok).length;
    let position = 0;
    for (const item of items) {
      if (!item.ok) {
        console.warn('[share] dropping a bad queued share', item.fileName, item.error);
        reportError(new Error(`Dropped a queued share that couldn't be read: ${item.error.slice(0, 200)}`), { area: 'share', event: 'bad_queued_share' });
        remove(item);
        continue;
      }
      const { envelope } = item;
      position += 1;
      if (removed.has(envelope.id)) continue;
      const target = shareImportTarget(envelope, userId);
      if (!target) break;
      publishStatus(userId, pending, { id: envelope.id, position, total }, waitReason);
      const imported = await importRecipe({ ...target, url: envelope.url, page: envelope.page, importId: envelope.id });
      const key = shareAttemptsKey(envelope.id);
      if (imported.ok) {
        result.imported.push(imported);
        clearDeviceSetting(key);
        remove(item);
        continue;
      }
      // The plan's monthly imports are used up: keep the file without counting a try, and stop, as
      // every share after it would be refused the same way. They import once the month resets.
      if (imported.error === 'limit_reached') {
        waitReason = imported.error;
        resetsAt = imported.resetsAt;
        break;
      }
      // The user's imports today are used up: the same, until the day resets.
      if (imported.error === 'daily_limit') {
        waitReason = imported.error;
        break;
      }
      // Trying again won't change the page or the plan: these fail at once.
      const final = imported.error === 'not_a_recipe' || imported.error === 'not_entitled';
      const attempts = final ? MAX_SHARE_ATTEMPTS : getDeviceSetting(key, 0) + 1;
      if (attempts >= MAX_SHARE_ATTEMPTS) {
        recordFailed(failedShare(envelope, imported.error, target));
        result.failed += 1;
        clearDeviceSetting(key);
        remove(item);
        continue;
      }
      setDeviceSetting(key, attempts);
      waitReason = imported.error;
      if (imported.error === 'offline' || imported.error === 'rate_limited') break;
    }
  } catch (err) {
    console.warn('[share] draining the queue failed', err);
    reportError(err, { area: 'share', event: 'drain_failed' });
  } finally {
    draining = false;
    removed.clear();
    publishStatus(userId, pending, null, waitReason, resetsAt);
  }
  return result;
}

/**
 * Takes a waiting share out of the queue (the imports card's Remove). The share importing now can't
 * be removed. Returns whether it was.
 */
export function removeQueuedShare(id: string, userId: string, options: Pick<ShareDrainOptions, 'pending'> = {}): boolean {
  const { pending = readPendingShares } = options;
  const current = getShareQueueStatus();
  if (current.importing?.id === id) return false;
  const item = pending().find((p) => p.ok && p.envelope.id === id);
  if (!item) return false;
  if (draining) removed.add(id);
  remove(item);
  clearDeviceSetting(shareAttemptsKey(id));
  publishStatus(userId, pending, current.importing, current.waitReason, current.resetsAt);
  return true;
}

type ShareImportsListener = (imported: ImportRecipeSuccess[]) => void;
const listeners = new Set<ShareImportsListener>();

/** Calls `listener` with the imports after each drain that imported something. Returns an unsubscribe. */
export function onShareImports(listener: ShareImportsListener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Drains the queue and tells `onShareImports` listeners. Without the App Group (Expo Go, tests) it does nothing. */
export async function runShareDrain(userId: string, options?: ShareDrainOptions): Promise<ShareDrainResult | null> {
  if (!getAppGroupContainer()) return null;
  const result = await drainShareQueue(userId, options);
  if (result.imported.length > 0) for (const listener of [...listeners]) listener(result.imported);
  return result;
}

/** Drains now, and on every return to the foreground and every reconnect. Returns a stop function. */
export function startShareDrain(userId: string, options?: ShareDrainOptions): () => void {
  void runShareDrain(userId, options);
  const stop = startCatchUpTriggers(() => void runShareDrain(userId, options));
  return () => {
    stop();
    setShareQueueStatus(EMPTY_SHARE_QUEUE_STATUS);
  };
}
