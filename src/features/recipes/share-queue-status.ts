// What the share queue is doing (spec 4.10), for the Recipes tab's imports card and the tab's badge.
// The share drain publishes it; screens read it with `useShareQueueStatus`.
import { useSyncExternalStore } from 'react';

import type { ImportRecipeError } from './import';

/** A share waiting in the App Group queue. */
export type QueuedShare = {
  /** The envelope id. */
  id: string;
  url: string;
  /** The page title Safari captured; other apps give none. */
  title: string | null;
  /** The list it will import into, or null when there's none to import into. */
  listName: string | null;
  /** Failed tries so far (spec 4.10: the fifth makes it a failed import). */
  attempts: number;
};

export type ShareQueueStatus = {
  /** Every readable share still in the queue, oldest first, including the one importing. */
  queued: QueuedShare[];
  /** The share importing now, as "position of total" for this drain; null between drains. */
  importing: { id: string; position: number; total: number } | null;
  /** Why the queue is waiting: the error the last kept share failed with, or null. */
  waitReason: ImportRecipeError['error'] | null;
};

export const EMPTY_SHARE_QUEUE_STATUS: ShareQueueStatus = { queued: [], importing: null, waitReason: null };

let status = EMPTY_SHARE_QUEUE_STATUS;
const listeners = new Set<() => void>();

export function getShareQueueStatus(): ShareQueueStatus {
  return status;
}

export function setShareQueueStatus(next: ShareQueueStatus): void {
  status = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useShareQueueStatus(): ShareQueueStatus {
  return useSyncExternalStore(subscribe, getShareQueueStatus);
}

/** The Recipes tab's badge: shares waiting between drains plus failed imports; none while importing. */
export function importsBadgeCount(queue: ShareQueueStatus, failed: number): number {
  return (queue.importing ? 0 : queue.queued.length) + failed;
}

/** A link's host without `www.`, or null when it isn't a link we can read. */
export function importHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** What to call a shared link: the page title, else the link's host without `www.`, else the link. */
export function importName(share: { url: string; title: string | null }): string {
  return share.title?.trim() || importHost(share.url) || share.url;
}

function recipes(count: number): string {
  return `${count} ${count === 1 ? 'recipe' : 'recipes'}`;
}

/** Why the queue is waiting, in plain words, for the card's heading. */
export function waitReasonText(reason: ShareQueueStatus['waitReason']): string {
  switch (reason) {
    case 'offline':
      return "You're offline. They'll import when you're back.";
    case 'rate_limited':
      return "The import service is busy. They'll import next time you open the app.";
    case null:
      return 'Waiting to import';
    default:
      return "Something went wrong. They'll import next time you open the app.";
  }
}

/** A waiting row's second line: "bonappetit.com · to Groceries · tried twice". */
export function queuedShareDetail(share: QueuedShare): string {
  const parts = [importHost(share.url) ?? share.url];
  if (share.listName) parts.push(`to ${share.listName}`);
  if (share.attempts === 1) parts.push('tried once');
  else if (share.attempts === 2) parts.push('tried twice');
  else if (share.attempts > 2) parts.push(`tried ${share.attempts} times`);
  return parts.join(' · ');
}

export type ImportsCardHeading = {
  /** The icon well: failed imports first, then an import running, then shares waiting. */
  tone: 'failed' | 'importing' | 'waiting';
  title: string;
  subtitle: string | null;
};

/** The imports card's heading row, or null when there's nothing to show (spec 4.10). */
export function importsCardHeading(failed: number, queue: ShareQueueStatus): ImportsCardHeading | null {
  const { importing, queued } = queue;
  const progress = importing ? `Importing ${importing.position} of ${importing.total}…` : null;
  if (failed > 0) {
    const waiting = queued.length > 0 ? `${queued.length} more waiting` : null;
    return {
      tone: 'failed',
      title: `Couldn't import ${recipes(failed)}`,
      subtitle: progress ?? (waiting && queue.waitReason ? `${waiting} · ${waitReasonText(queue.waitReason)}` : waiting),
    };
  }
  if (importing) {
    const current = queued.find((s) => s.id === importing.id);
    const subtitle = current ? [importName(current), current.listName && `to ${current.listName}`].filter(Boolean).join(' · ') : null;
    return { tone: 'importing', title: progress!, subtitle };
  }
  if (queued.length > 0) {
    return { tone: 'waiting', title: `${recipes(queued.length)} waiting`, subtitle: waitReasonText(queue.waitReason) };
  }
  return null;
}
