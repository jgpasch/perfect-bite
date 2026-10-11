// Applies the Siri queue (spec 4.9): adds the intent left in the App Group while the app was closed,
// on launch, on foreground and after sign-in. Signed out, they wait in the queue.
import { AppState } from 'react-native';
import { v5 } from 'uuid';

import { categorizePending } from '@/features/categories/categorization';
import { cameToForeground } from '@/features/categories/catch-up';
import { addSiriItem, type AddIds } from '@/features/lists/items';
import { getDefaultListId, getList } from '@/features/lists/lists';
import type { SiriEnvelope } from '@/shared';

import { getAppGroupContainer, readPendingSiriAdds, type PendingSiriAdd } from './app-group';

/** Namespace for ids derived from an envelope id. `siri-add` must use the same one. */
export const SIRI_ID_NAMESPACE = '6f1c9a52-3d4e-4b7a-9c2f-8e5d1a0b7c64';

/**
 * The item and amount ids for one envelope (UUIDv5 of its id), so applying it again, here or in
 * `siri-add`, finds the same rows instead of adding twice.
 */
export function siriAddIds(envelopeId: string): AddIds {
  return {
    itemId: v5(`${envelopeId}/item`, SIRI_ID_NAMESPACE),
    contributionId: v5(`${envelopeId}/contribution`, SIRI_ID_NAMESPACE),
  };
}

/** The envelope's list if it's still live and not archived, else the user's default list. */
export function siriTargetListId(envelope: SiriEnvelope, userId: string): string | null {
  const named = envelope.listId ? getList(envelope.listId) : undefined;
  if (named && !named.archivedAt) return named.id;
  return getDefaultListId(userId);
}

export type DrainResult = {
  /** Items added (or Combined) by this drain. */
  added: number;
  /** Names the adds recorded as pending, for one `categorizePending` call. */
  pendingNames: string[];
};

function remove(item: PendingSiriAdd): void {
  try {
    item.file.delete();
  } catch (err) {
    // Left behind, it's applied again next time, which the derived ids make a no-op.
    console.warn('[siri] deleting a queued add failed', item.file.name, err);
  }
}

let draining = false;

/**
 * Applies `pending` (oldest first) as `userId`, deleting each file once applied. Bad files and text
 * with nothing to add are logged and deleted. If there's no list to add to, or a write fails, the
 * rest stay queued for the next drain. One drain at a time: a drain started during another does
 * nothing.
 */
export function drainSiriQueue(userId: string, pending: () => PendingSiriAdd[] = readPendingSiriAdds): DrainResult {
  const result: DrainResult = { added: 0, pendingNames: [] };
  if (draining) return result;
  draining = true;
  try {
    for (const item of pending()) {
      if (!item.ok) {
        console.warn('[siri] dropping a bad queued add', item.fileName, item.error);
        remove(item);
        continue;
      }
      const { envelope } = item;
      const listId = siriTargetListId(envelope, userId);
      if (!listId) break;
      let added: ReturnType<typeof addSiriItem>;
      try {
        added = addSiriItem(listId, envelope.text, userId, siriAddIds(envelope.id), new Date(envelope.createdAt));
      } catch (err) {
        console.warn('[siri] applying a queued add failed', envelope.id, err);
        break;
      }
      if (added === null) console.warn('[siri] dropping a queued add with nothing to add', envelope.id);
      else if (added !== 'applied') {
        result.added += 1;
        result.pendingNames.push(...added.pendingNames);
      }
      remove(item);
    }
  } catch (err) {
    console.warn('[siri] reading the queue failed', err);
  } finally {
    draining = false;
  }
  return result;
}

type SiriAddsListener = (count: number) => void;
const listeners = new Set<SiriAddsListener>();

/** Calls `listener` with the count after each drain that added something. Returns an unsubscribe. */
export function onSiriAdds(listener: SiriAddsListener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * Drains the queue, categorizes the new names in one batch and tells `onSiriAdds` listeners.
 * Without the App Group (Expo Go, tests) it does nothing.
 */
export function runSiriDrain(userId: string): DrainResult | null {
  if (!getAppGroupContainer()) return null;
  const result = drainSiriQueue(userId);
  if (result.pendingNames.length > 0) void categorizePending(result.pendingNames);
  if (result.added > 0) for (const listener of [...listeners]) listener(result.added);
  return result;
}

/** Drains now and on every return to the foreground. Returns a stop function. */
export function startSiriDrain(userId: string): () => void {
  runSiriDrain(userId);
  let appState = AppState.currentState;
  const app = AppState.addEventListener('change', (next) => {
    if (cameToForeground(appState, next)) runSiriDrain(userId);
    appState = next;
  });
  return () => app.remove();
}
