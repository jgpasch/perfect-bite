// Push: drains the outbox to Supabase in order (spec 7.2). Built on stash's outbox upload
// (`uploadPending` + `backoff.ts`): the same backoff schedule and the same "one run at a time,
// a call during a run schedules one more" rule, extended for an ordered queue:
//
// - Household mutations go to `apply_mutations` in batches. Each mutation gets its own result; a
//   rejected one (not a member, malformed, a constraint) is recorded on its outbox row and skipped,
//   so it never blocks the rest. Applied, unchanged and merged ones leave the outbox.
// - `apply_mutations` doesn't take the per-user tables (aisle order, settings) or `households`
//   (spec 7.1), so those are sent one at a time, in their place in the queue: per-user rows as
//   direct writes (RLS limits them to the user's own rows), a new household through
//   `create_household`. A 4xx for one of them is recorded and skipped the same way.
// - Anything else that fails (offline, timeout, 5xx, an expired token) stops the run with the
//   queue untouched and retries on the backoff schedule.
//
// Triggers (`startPush`): after each outbox write (debounced), on launch, foreground and
// reconnect, and when a backoff delay is up.
import { asc, eq, inArray, isNull } from 'drizzle-orm';

import { db, outbox, type OutboxRow } from '@/db';
import { getAccount } from '@/features/auth/account';
import { startCatchUpTriggers } from '@/features/categories/catch-up';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { reportError } from '@/lib/sentry';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

import { reportSyncActivity } from './activity';
import type { Mutation } from './mutation';
import { onOutboxWrite } from './outbox-signal';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Delay after the 1st, 2nd, … failed push; the last entry repeats (hourly). Stash's schedule. */
export const BACKOFF_SCHEDULE_MS = [5 * SECOND, 30 * SECOND, 2 * MINUTE, 10 * MINUTE, HOUR] as const;

/** Delay before the next attempt, given how many attempts have failed in a row (>= 1). */
export function backoffDelayMs(failedAttempts: number): number {
  const i = Math.min(Math.max(failedAttempts, 1), BACKOFF_SCHEDULE_MS.length) - 1;
  return BACKOFF_SCHEDULE_MS[i];
}

/** Mutations per `apply_mutations` call. */
export const PUSH_BATCH_SIZE = 100;
/** Quiet time after a write before pushing, so a burst of writes goes as one batch. */
export const PUSH_DEBOUNCE_MS = 1000;

/** Tables `apply_mutations` takes (spec 7.2). */
const APPLY_TABLES = new Set([
  'lists',
  'list_items',
  'list_item_contributions',
  'recipes',
  'recipe_ingredients',
  'ingredient_usage',
  'ingredient_unit_usage',
  'categories',
  'household_category_overrides',
  'household_staples',
  'household_category_order',
  'meal_plan_entries',
]);

/** Push state, kept in a device setting so the backoff survives a relaunch (and for 7.5's status). */
export type PushState = {
  /** Failed pushes in a row; 0 after a push that got through. */
  attempts: number;
  /** ISO time before which an automatic push waits; null when not backing off. */
  nextAttemptAt: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
};

const STATE_KEY = 'sync.push';
const INITIAL_STATE: PushState = { attempts: 0, nextAttemptAt: null, lastError: null, lastSuccessAt: null };

export function getPushState(): PushState {
  return getDeviceSetting<PushState>(STATE_KEY, INITIAL_STATE);
}

function setPushState(patch: Partial<PushState>) {
  setDeviceSetting<PushState>(STATE_KEY, { ...getPushState(), ...patch });
}

export type PushSummary =
  | { skipped: 'no-session' | 'offline' | 'backoff' }
  | {
      skipped?: undefined;
      /** Mutations the server took (applied, unchanged or merged). */
      pushed: number;
      /** Mutations the server refused, now recorded and skipped. */
      rejected: number;
      /** True when a failure stopped the run; the rest waits for the backoff. */
      failed: boolean;
    };

/** Pending (not rejected) outbox rows, oldest first. */
function pendingRows(limit: number): OutboxRow[] {
  return db.select().from(outbox).where(isNull(outbox.rejectedAt)).orderBy(asc(outbox.id)).limit(limit).all();
}

/** A Supabase response: `status` is the HTTP status (0 when the request never got an answer). */
type Response = { data?: unknown; error?: { message?: string; code?: string } | null; status?: number };

/** Thrown for failures that should stop the run and retry later. */
class RetryLater extends Error {}

/** True for an HTTP status that means "this request is wrong" rather than "try again". */
function isPermanent(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
}

const describe = (res: Response) => res.error?.message || `HTTP ${res.status ?? 0}`;

/** One result from `apply_mutations`. */
type ApplyResult =
  | { status: 'applied' | 'unchanged' }
  | { status: 'merged'; merged_into: string }
  | { status: 'rejected'; code: string; message: string };

function isApplyResult(value: unknown): value is ApplyResult {
  const status = (value as { status?: unknown } | null)?.status;
  return status === 'applied' || status === 'unchanged' || status === 'merged' || status === 'rejected';
}

type Rejection = { code: string; message: string };

/** A rejected change is never sent again, so the edit is lost: logged and sent to Sentry. */
function reportRejection(table: string, rejection: Rejection) {
  console.warn(`[push] rejected ${table} ${rejection.code}: ${rejection.message}`);
  reportError(new Error(`Sync change to ${table} rejected: ${rejection.code}: ${rejection.message.slice(0, 200)}`), {
    area: 'sync',
    event: 'push_rejected',
    table,
    code: rejection.code,
  });
}

/** Removes sent rows and records rejected ones, in one transaction. */
function settle(done: number[], rejected: { id: number; error: Rejection }[], at: Date) {
  db.transaction((tx) => {
    if (done.length) tx.delete(outbox).where(inArray(outbox.id, done)).run();
    for (const r of rejected) {
      tx.update(outbox).set({ rejectedAt: at, error: r.error }).where(eq(outbox.id, r.id)).run();
    }
  });
}

async function call(request: PromiseLike<Response>): Promise<Response> {
  try {
    return await request;
  } catch (err) {
    // A rejected promise is a network failure (supabase-js normally returns it as status 0).
    throw new RetryLater(err instanceof Error ? err.message : String(err));
  }
}

/** Sends consecutive household mutations as one `apply_mutations` call. */
async function pushBatch(rows: OutboxRow[], at: Date): Promise<{ pushed: number; rejected: number }> {
  const res = await call(supabase.rpc('apply_mutations', { mutations: rows.map((r) => r.mutation) }));
  // The function handles every mutation on its own, so a failed call is never one mutation's fault.
  if (res.error) throw new RetryLater(describe(res));
  const results = res.data;
  if (!Array.isArray(results) || results.length !== rows.length || !results.every(isApplyResult)) {
    throw new RetryLater('apply_mutations returned an unexpected response');
  }
  const done: number[] = [];
  const rejected: { id: number; error: Rejection }[] = [];
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      rejected.push({ id: rows[i].id, error: { code: result.code, message: result.message } });
      reportRejection(rows[i].mutation.table, { code: result.code, message: result.message });
    } else {
      done.push(rows[i].id);
    }
  });
  settle(done, rejected, at);
  return { pushed: done.length, rejected: rejected.length };
}

/** Columns a client may write per per-user table (the server's grants). */
const USER_TABLE_COLUMNS: Record<string, readonly string[]> = {
  user_settings: ['default_list_id'],
  user_household_category_order: ['category_ids'],
};

/**
 * Tables the server dropped (spec 4.3.3: aisle orders moved to the household). A queued change to
 * one can never apply, so it's refused here for good rather than sent. (Sent anyway, as an older
 * app does, PostgREST answers 404, which `isPermanent` also treats as a rejection.)
 */
const RETIRED_TABLES: ReadonlySet<string> = new Set(['user_category_order']);

const pick = (fields: Mutation['fields'], columns: readonly string[]) =>
  Object.fromEntries(Object.entries(fields).filter(([k]) => columns.includes(k)));

/** The request for a mutation `apply_mutations` doesn't take, or a rejection if it can't be sent. */
function singleRequest(m: Mutation): PromiseLike<Response> | Rejection {
  if (m.table === 'households') {
    // Only creation exists on the server for now (4.7); it's idempotent for members. An insert
    // carries `created_at`; a later rename doesn't.
    if (m.id && typeof m.fields.name === 'string' && 'created_at' in m.fields) {
      return supabase.rpc('create_household', { p_id: m.id, p_name: m.fields.name });
    }
    return { code: 'unsupported', message: 'Household changes other than creation are not synced yet' };
  }
  if (RETIRED_TABLES.has(m.table)) return { code: 'retired', message: `${m.table} no longer exists on the server` };
  const columns = USER_TABLE_COLUMNS[m.table];
  if (!columns || !m.key) return { code: 'unsupported', message: `${m.table} isn't synced` };
  if (m.delete) return supabase.from(m.table).delete().match(m.key);
  const row: Record<string, unknown> = { ...m.key, ...pick(m.fields, columns) };
  return supabase.from(m.table).upsert(row, { onConflict: Object.keys(m.key).join(',') });
}

/** Sends one per-user or household mutation. */
async function pushSingle(row: OutboxRow, at: Date): Promise<{ pushed: number; rejected: number }> {
  const request = singleRequest(row.mutation);
  let rejection: Rejection | null = null;
  if ('then' in request) {
    const res = await call(request);
    if (res.error) {
      if (!isPermanent(res.status)) throw new RetryLater(describe(res));
      rejection = { code: res.error.code || String(res.status), message: describe(res) };
    }
  } else {
    rejection = request;
  }
  if (rejection) reportRejection(row.mutation.table, rejection);
  settle(rejection ? [] : [row.id], rejection ? [{ id: row.id, error: rejection }] : [], at);
  return rejection ? { pushed: 0, rejected: 1 } : { pushed: 1, rejected: 0 };
}

/**
 * Sends every pending outbox mutation, oldest first, until the queue is empty or something fails.
 * Waits while backing off unless `force` (Sync now, foreground, reconnect). Never throws.
 */
async function runPush(now: () => Date, force: boolean): Promise<PushSummary> {
  if (!isSupabaseConfigured || !getAccount()) return { skipped: 'no-session' };
  if (online === false) return { skipped: 'offline' };
  const state = getPushState();
  if (!force && state.nextAttemptAt && Date.parse(state.nextAttemptAt) > now().getTime()) {
    return { skipped: 'backoff' };
  }

  const summary = { pushed: 0, rejected: 0, failed: false };
  try {
    for (let rows = pendingRows(PUSH_BATCH_SIZE); rows.length > 0; rows = pendingRows(PUSH_BATCH_SIZE)) {
      // The leading run of household mutations goes as one batch; anything else goes alone.
      const run = rows.findIndex((r) => !APPLY_TABLES.has(r.mutation.table));
      const result =
        run === 0 ? await pushSingle(rows[0], now()) : await pushBatch(run === -1 ? rows : rows.slice(0, run), now());
      summary.pushed += result.pushed;
      summary.rejected += result.rejected;
    }
  } catch (err) {
    const attempts = state.attempts + 1;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[push] failed (attempt ${attempts}): ${message}`);
    setPushState({
      attempts,
      nextAttemptAt: new Date(now().getTime() + backoffDelayMs(attempts)).toISOString(),
      lastError: message,
    });
    summary.failed = true;
    scheduleRetry(backoffDelayMs(attempts));
    return summary;
  }
  setPushState({ attempts: 0, nextAttemptAt: null, lastError: null, lastSuccessAt: now().toISOString() });
  return summary;
}

let inFlight: Promise<PushSummary> | null = null;
let rerun: { force: boolean } | null = null;

/**
 * Pushes the outbox. Concurrent calls coalesce: a call made during a run schedules exactly one more
 * run (so writes made meanwhile go too) and shares its promise.
 */
export function pushNow(options: { force?: boolean; now?: () => Date } = {}): Promise<PushSummary> {
  const force = options.force ?? false;
  const now = options.now ?? (() => new Date());
  if (inFlight) {
    rerun = { force: force || (rerun?.force ?? false) };
    return inFlight;
  }
  reportSyncActivity({ pushing: true });
  inFlight = (async () => {
    try {
      let result = await runPush(now, force);
      while (rerun) {
        const next = rerun;
        rerun = null;
        // Don't hammer a server that just failed: the backoff timer takes it from here.
        if (result.skipped === undefined && result.failed) break;
        result = await runPush(now, next.force);
      }
      return result;
    } catch (err) {
      // runPush handles network failures; this is a local bug (e.g. the database). Keep the queue.
      console.error('[push] crashed', err);
      reportError(err, { area: 'sync', event: 'push_crashed' });
      return { pushed: 0, rejected: 0, failed: true };
    } finally {
      inFlight = null;
      rerun = null;
      reportSyncActivity({ pushing: false });
    }
  })();
  return inFlight;
}

// --- Triggers ------------------------------------------------------------------------------

let started = false;
/** Last known connectivity; null until the OS reports it. */
let online: boolean | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRetry(delayMs: number) {
  if (!started) return;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void pushNow();
  }, delayMs);
}

/** Pushes once outbox writes have been quiet for `PUSH_DEBOUNCE_MS`. */
function schedulePush(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void pushNow();
  }, PUSH_DEBOUNCE_MS);
}

/**
 * Starts pushing: now, after each write (debounced), on foreground and reconnect, and when a
 * backoff delay is up. While the OS says there's no connection, pushes are skipped. Returns a
 * cleanup that stops all of it.
 */
export function startPush(): () => void {
  started = true;
  const stopWrites = onOutboxWrite(schedulePush);
  const stopTriggers = startCatchUpTriggers(
    () => void pushNow({ force: true }),
    (now) => {
      online = now;
      reportSyncActivity({ online: now });
    },
  );
  void pushNow({ force: true });
  return () => {
    started = false;
    stopWrites();
    stopTriggers();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (retryTimer) clearTimeout(retryTimer);
    debounceTimer = null;
    retryTimer = null;
    online = null;
    reportSyncActivity({ online: null });
  };
}
