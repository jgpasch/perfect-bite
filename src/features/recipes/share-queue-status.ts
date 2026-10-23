// What the user's shares are doing (spec 4.10), for the Recipes tab's imports card and the tab's
// badge: the App Group's envelopes the server doesn't have yet, and the user's own `my_share_imports`
// rows. The share reconcile publishes it; screens read it with `useShareQueueStatus`. Never stored.
import { useSyncExternalStore } from 'react';

import { limitResetsAt } from '@/features/plans/limits';
import { i18n } from '@/i18n';

import { importLimitMessage, NOT_ENTITLED_MESSAGE } from './import-sheet';

/** A share waiting: an envelope not on the server yet, or a server import still running. */
export type QueuedShare = {
  /** The envelope id, which is the server's operation id. */
  id: string;
  url: string;
  /** The page title Safari captured; other apps give none. */
  title: string | null;
  /** The list it will import into, or null when there's none, or it's recipe-only. */
  listName: string | null;
  /** The household a recipe-only share will be saved to; absent or null when it goes on a list. */
  householdName?: string | null;
  /** The server has it: it can't be removed any more. */
  onServer: boolean;
};

/** A share the server failed to import (`my_share_imports.status = 'failed'`). */
export type FailedShareImport = {
  id: string;
  url: string;
  title: string | null;
  /** `share_imports.error_code`, e.g. `not_a_recipe`, `daily_limit`. */
  errorCode: string | null;
  /** With `limit_reached` and `daily_limit`: when the limit resets. */
  resetsAt: string | null;
};

export type ShareQueueStatus = {
  /** Waiting shares, oldest first. */
  queued: QueuedShare[];
  /** Shares the server failed to import, newest first. */
  failed: FailedShareImport[];
  /** The last reconcile couldn't reach the server, so envelopes it doesn't have wait. */
  offline: boolean;
};

export const EMPTY_SHARE_QUEUE_STATUS: ShareQueueStatus = { queued: [], failed: [], offline: false };

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

/** The Recipes tab's badge: waiting shares, failed shares and failed in-app imports. */
export function importsBadgeCount(queue: ShareQueueStatus, failedLocal: number): number {
  return queue.queued.length + queue.failed.length + failedLocal;
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
 * Why a share failed on the server, in spec 4.10's plain words (the push's wording, 4.13), by its
 * error code. The monthly limit says when it resets (`resetsAt`, else the start of next month).
 */
export function shareFailureReason(code: string | null, resetsAt: string | null, now: number = Date.now()): string {
  switch (code) {
    case 'not_a_recipe':
      return i18n.t('recipes.import.errors.notARecipe');
    case 'invalid_url':
      return i18n.t('recipes.import.errors.invalidUrl');
    case 'not_entitled':
      return NOT_ENTITLED_MESSAGE;
    case 'not_a_member':
      return i18n.t('recipes.imports.reasons.notAMember');
    case 'daily_limit':
      return i18n.t('errors.dailyLimit');
    case 'limit_reached':
      return importLimitMessage(limitResetsAt(resetsAt, now));
    case 'fetch_failed':
      return i18n.t('recipes.import.errors.fetchFailed');
    default:
      return i18n.t('recipes.imports.reasons.somethingWrong');
  }
}

/** Offline, with envelopes the server doesn't have: they wait for the connection. */
function waitingOffline(queue: ShareQueueStatus): boolean {
  return queue.offline && queue.queued.some((share) => !share.onServer);
}

/**
 * Why shares are waiting, for the card's heading: offline with envelopes the server doesn't have,
 * else the server is preparing them.
 */
export function waitReasonText(queue: ShareQueueStatus): string {
  return i18n.t(waitingOffline(queue) ? 'recipes.imports.waitOffline' : 'recipes.imports.waitBackground');
}

function toDestination(name: string): string {
  return i18n.t('recipes.imports.to', { name });
}

/** Where a waiting share goes: its list, or its household when it's recipe-only. */
function destination(share: QueuedShare): string | null {
  return share.listName ?? share.householdName ?? null;
}

/** A waiting row's second line: "bonappetit.com · to Groceries", or "to Smith home" for a recipe-only share. */
export function queuedShareDetail(share: QueuedShare): string {
  const parts = [importHost(share.url) ?? share.url];
  const to = destination(share);
  if (to) parts.push(toDestination(to));
  return parts.join(' · ');
}

export type ImportsCardHeading = {
  /** The icon well: failed imports first, then shares waiting. */
  tone: 'failed' | 'waiting';
  title: string;
  subtitle: string | null;
};

/**
 * The imports card's heading row, or null when there's nothing to show (spec 4.10). `failedLocal`:
 * failed in-app imports (`failed_imports`); failed shares come with `queue`.
 */
export function importsCardHeading(failedLocal: number, queue: ShareQueueStatus): ImportsCardHeading | null {
  const { queued } = queue;
  const failed = failedLocal + queue.failed.length;
  if (failed > 0) {
    const waiting = queued.length > 0 ? i18n.t('recipes.imports.moreWaiting', { count: queued.length }) : null;
    return {
      tone: 'failed',
      title: i18n.t('recipes.imports.couldntImport', { recipes: recipes(failed) }),
      subtitle: waiting && waitingOffline(queue) ? `${waiting} · ${waitReasonText(queue)}` : waiting,
    };
  }
  if (queued.length > 0) {
    return {
      tone: 'waiting',
      title: i18n.t('recipes.imports.waiting', { recipes: recipes(queued.length) }),
      subtitle: waitReasonText(queue),
    };
  }
  return null;
}
