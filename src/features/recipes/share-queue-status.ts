// What the share queue is doing (spec 4.10), for the Recipes tab's imports card and the tab's badge.
// The share drain publishes it; screens read it with `useShareQueueStatus`.
import { useSyncExternalStore } from 'react';

import { limitResetsAt } from '@/features/plans/limits';
import { i18n } from '@/i18n';

import type { ImportRecipeError } from './import';
import { importLimitMessage } from './import-sheet';

/** A share waiting in the App Group queue. */
export type QueuedShare = {
  /** The envelope id. */
  id: string;
  url: string;
  /** The page title Safari captured; other apps give none. */
  title: string | null;
  /** The list it will import into, or null when there's none, or it's recipe-only. */
  listName: string | null;
  /** The household a recipe-only share will be saved to; absent or null when it goes on a list. */
  householdName?: string | null;
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
  /** With `limit_reached`: when the plan's monthly imports reset. */
  resetsAt?: string;
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
  return i18n.t('recipes.imports.recipes', { count });
}

/**
 * Why the queue is waiting, in plain words, for the card's heading. Past the plan's monthly imports
 * it's the import sheet's wording, with `resetsAt` (else the start of next month).
 */
export function waitReasonText(reason: ShareQueueStatus['waitReason'], resetsAt?: string): string {
  switch (reason) {
    case 'offline':
      return i18n.t('recipes.imports.waitOffline');
    case 'rate_limited':
      return i18n.t('recipes.imports.waitBusy');
    case 'limit_reached':
      return importLimitMessage(limitResetsAt(resetsAt));
    case 'daily_limit':
      return i18n.t('errors.dailyLimit');
    case null:
      return i18n.t('recipes.imports.waitIdle');
    default:
      return i18n.t('recipes.imports.waitFailed');
  }
}

function toDestination(name: string): string {
  return i18n.t('recipes.imports.to', { name });
}

/** Where a waiting share goes: its list, or its household when it's recipe-only. */
function destination(share: QueuedShare): string | null {
  return share.listName ?? share.householdName ?? null;
}

/**
 * A waiting row's second line: "bonappetit.com · to Groceries · tried twice", or "to Smith home"
 * for a recipe-only share.
 */
export function queuedShareDetail(share: QueuedShare): string {
  const parts = [importHost(share.url) ?? share.url];
  const to = destination(share);
  if (to) parts.push(toDestination(to));
  if (share.attempts === 1) parts.push(i18n.t('recipes.imports.triedOnce'));
  else if (share.attempts === 2) parts.push(i18n.t('recipes.imports.triedTwice'));
  else if (share.attempts > 2) parts.push(i18n.t('recipes.imports.triedTimes', { count: share.attempts }));
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
  const progress = importing
    ? i18n.t('recipes.imports.progress', { position: importing.position, total: importing.total })
    : null;
  if (failed > 0) {
    const waiting = queued.length > 0 ? i18n.t('recipes.imports.moreWaiting', { count: queued.length }) : null;
    return {
      tone: 'failed',
      title: i18n.t('recipes.imports.couldntImport', { recipes: recipes(failed) }),
      subtitle:
        progress ?? (waiting && queue.waitReason ? `${waiting} · ${waitReasonText(queue.waitReason, queue.resetsAt)}` : waiting),
    };
  }
  if (importing) {
    const current = queued.find((s) => s.id === importing.id);
    const to = current && destination(current);
    const subtitle = current ? [importName(current), to && toDestination(to)].filter(Boolean).join(' · ') : null;
    return { tone: 'importing', title: progress!, subtitle };
  }
  if (queued.length > 0) {
    return {
      tone: 'waiting',
      title: i18n.t('recipes.imports.waiting', { recipes: recipes(queued.length) }),
      subtitle: waitReasonText(queue.waitReason, queue.resetsAt),
    };
  }
  return null;
}
