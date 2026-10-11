// Imports the share queue (spec 4.10): recipes shared to the extension while the app was closed,
// on launch, foreground, reconnect and sign-in, next to the Siri queue. Signed out, shares wait.
import { startCatchUpTriggers } from '@/features/categories/catch-up';
import { clearDeviceSetting, getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { getAppGroupContainer, readPendingShares, type PendingShare } from '@/features/siri/app-group';
import { siriTargetListId } from '@/features/siri/drain';
import type { ShareEnvelope } from '@/shared';

import { importRecipe, type ImportRecipeError, type ImportRecipeSuccess } from './import';

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
};

export type ShareDrainOptions = {
  /** The queue, oldest first. */
  pending?: () => PendingShare[];
  /** Records a share that won't import. */
  recordFailed?: (failed: FailedShare) => void;
};

export type ShareDrainResult = {
  /** Shares imported by this drain, oldest first. */
  imported: ImportRecipeSuccess[];
  /** Shares recorded as failed imports and deleted. */
  failed: number;
};

function logFailed(failed: FailedShare): void {
  console.warn('[share] import failed', failed.url, failed.reason);
}

function remove(item: PendingShare): void {
  try {
    item.file.delete();
  } catch (err) {
    // Left behind, it's imported again next time, which the import id keeps to one recipe.
    console.warn('[share] deleting a queued share failed', item.file.name, err);
  }
}

function failedShare(envelope: ShareEnvelope, reason: FailedShare['reason']): FailedShare {
  return { url: envelope.url, title: envelope.page?.title?.trim() || null, reason };
}

let draining = false;

/**
 * Imports `pending` (oldest first) as `userId`, one at a time, deleting each file once imported.
 * Bad files are logged and deleted. "Not a recipe" is recorded as failed at once; other failures
 * keep the file and count a try, and the fifth is recorded as failed. Offline or rate-limited, the
 * rest wait for the next drain, as they would fail the same way. One drain at a time: a drain
 * started during another does nothing.
 */
export async function drainShareQueue(userId: string, options: ShareDrainOptions = {}): Promise<ShareDrainResult> {
  const { pending = readPendingShares, recordFailed = logFailed } = options;
  const result: ShareDrainResult = { imported: [], failed: 0 };
  if (draining) return result;
  draining = true;
  try {
    for (const item of pending()) {
      if (!item.ok) {
        console.warn('[share] dropping a bad queued share', item.fileName, item.error);
        remove(item);
        continue;
      }
      const { envelope } = item;
      const listId = siriTargetListId(envelope, userId);
      if (!listId) break;
      const imported = await importRecipe({ url: envelope.url, listId, page: envelope.page, importId: envelope.id });
      const key = shareAttemptsKey(envelope.id);
      if (imported.ok) {
        result.imported.push(imported);
        clearDeviceSetting(key);
        remove(item);
        continue;
      }
      const attempts = imported.error === 'not_a_recipe' ? MAX_SHARE_ATTEMPTS : getDeviceSetting(key, 0) + 1;
      if (attempts >= MAX_SHARE_ATTEMPTS) {
        recordFailed(failedShare(envelope, imported.error));
        result.failed += 1;
        clearDeviceSetting(key);
        remove(item);
        continue;
      }
      setDeviceSetting(key, attempts);
      if (imported.error === 'offline' || imported.error === 'rate_limited') break;
    }
  } catch (err) {
    console.warn('[share] draining the queue failed', err);
  } finally {
    draining = false;
  }
  return result;
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
  return startCatchUpTriggers(() => void runShareDrain(userId, options));
}
