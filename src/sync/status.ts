// Sync status (spec 7.5): what Settings > Sync status and the account card's badge show. The
// inputs are the outbox, the push and pull states (device settings) and what's running right now;
// `syncStatus` turns them into one state, so the rules live in one tested place.
import { sql } from 'drizzle-orm';

import { db, outbox } from '@/db';
import { formatDate, i18n } from '@/i18n';

import { getSyncActivity, type SyncActivity } from './activity';
import { getPullState, getQuarantinedRows, pullNow, type PullState, type PullSummary } from './pull';
import { getPushState, pushNow, type PushState, type PushSummary } from './push';

// --- The reducer ---------------------------------------------------------------------------

export type SyncInputs = {
  /** Supabase is configured and someone is signed in; otherwise nothing syncs. */
  signedIn: boolean;
  /** Outbox mutations waiting to go. */
  pending: number;
  /** Outbox mutations the server refused; they stay for the record and never go. */
  rejected: number;
  /** Server changes pull skipped because they couldn't be applied here (`sync.quarantine`). */
  quarantined?: number;
  push: Pick<PushState, 'lastSuccessAt' | 'lastError'>;
  pull: Pick<PullState, 'lastSuccessAt' | 'lastError'>;
  activity: SyncActivity;
};

/**
 * `off`: not signed in. `offline`: the OS says there's no connection. `error`: the last push or
 * pull failed (it retries on its own). `syncing`: a push or pull is running, or writes are waiting
 * for the push's debounce. `never`: nothing has gone through yet. `synced`: the outbox is empty
 * and the last push and pull both got through.
 */
export type SyncState = 'off' | 'offline' | 'error' | 'syncing' | 'never' | 'synced';

export type SyncBadgeTone = 'positive' | 'pending' | 'danger';

export type SyncStatus = {
  state: SyncState;
  /** Short, for the badge and the Status row. */
  label: string;
  tone: SyncBadgeTone;
  pending: number;
  rejected: number;
  /** Server changes that couldn't be applied on this device and were skipped. */
  quarantined: number;
  /** The later of the last successful push and pull (ISO), or null if neither ever got through. */
  lastSuccessAt: string | null;
  /** The last push or pull failure still standing, or null. */
  lastError: string | null;
  /** Sync now does something: signed in, not known to be offline, and nothing running. */
  canSyncNow: boolean;
};

const TONES: Record<SyncState, SyncBadgeTone> = {
  off: 'pending',
  offline: 'pending',
  error: 'danger',
  syncing: 'pending',
  never: 'pending',
  synced: 'positive',
};

function later(a: string | null, b: string | null): string | null {
  if (!a || !b) return a ?? b;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * Push's error first: it's the one holding the user's own changes back. The error itself is shown as
 * the app got it (a network or database message, for support), after a translated "Sending:".
 */
function standingError(inputs: SyncInputs): string | null {
  if (inputs.push.lastError) return i18n.t('sync.sending', { error: inputs.push.lastError });
  if (inputs.pull.lastError) return i18n.t('sync.receiving', { error: inputs.pull.lastError });
  return null;
}

export function syncStatus(inputs: SyncInputs): SyncStatus {
  const lastError = standingError(inputs);
  const lastSuccessAt = later(inputs.push.lastSuccessAt, inputs.pull.lastSuccessAt);
  const running = inputs.activity.pushing || inputs.activity.pulling;
  let state: SyncState;
  if (!inputs.signedIn) state = 'off';
  else if (inputs.activity.online === false) state = 'offline';
  else if (running) state = 'syncing';
  else if (lastError) state = 'error';
  else if (inputs.pending > 0) state = 'syncing';
  else if (!inputs.push.lastSuccessAt && !inputs.pull.lastSuccessAt) state = 'never';
  else state = 'synced';
  return {
    state,
    label: i18n.t(`sync.states.${state}`),
    tone: TONES[state],
    pending: Math.max(0, inputs.pending),
    rejected: Math.max(0, inputs.rejected),
    quarantined: Math.max(0, inputs.quarantined ?? 0),
    lastSuccessAt,
    lastError,
    canSyncNow: inputs.signedIn && inputs.activity.online !== false && !running,
  };
}

/** "Just now", "5 min ago", "3 h ago", then the date and time; "Never" for null. */
export function formatLastSync(iso: string | null, now: Date): string {
  if (!iso) return i18n.t('sync.never');
  const at = new Date(iso);
  const ms = now.getTime() - at.getTime();
  if (Number.isNaN(ms)) return i18n.t('sync.never');
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return i18n.t('sync.justNow');
  if (minutes < 60) return i18n.t('sync.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return i18n.t('sync.hoursAgo', { count: hours });
  return formatDate(at, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

// --- Reading and acting --------------------------------------------------------------------

/** Pending and rejected outbox counts. */
export function outboxCounts(): { pending: number; rejected: number } {
  const row = db
    .select({
      pending: sql<number>`coalesce(sum(case when ${outbox.rejectedAt} is null then 1 else 0 end), 0)`,
      rejected: sql<number>`coalesce(sum(case when ${outbox.rejectedAt} is not null then 1 else 0 end), 0)`,
    })
    .from(outbox)
    .get();
  return { pending: Number(row?.pending ?? 0), rejected: Number(row?.rejected ?? 0) };
}

/** The reducer's inputs as they are now. */
export function readSyncInputs(signedIn: boolean): SyncInputs {
  return {
    signedIn,
    ...outboxCounts(),
    quarantined: getQuarantinedRows().length,
    push: getPushState(),
    pull: getPullState(),
    activity: getSyncActivity(),
  };
}

/** Sync now: sends the outbox (ignoring the backoff), then pulls everything. Never throws. */
export async function syncNow(): Promise<{ push: PushSummary; pull: PullSummary }> {
  const push = await pushNow({ force: true });
  const pull = await pullNow();
  return { push, pull };
}
