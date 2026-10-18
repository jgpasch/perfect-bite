// Scriptable stand-in for `@/lib/supabase`. Records every call so tests can assert on what was sent.
//
// In a test file:
//   jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
//   beforeEach(() => resetSupabase());
//
// Table queries: `supabase.from('lists').select('*').gte(...)` records a `RecordedQuery` and
// resolves with whatever `respondTo` / `onQuery` returns (default `{ data: null, error: null }`).
// RPCs: `supabase.rpc('fn', args)` records a `RecordedRpc` and resolves the same way, scripted with
// `respondToRpc` / `onRpc`.
// Realtime: `supabase.channel(name).on(...).subscribe(cb)` records a `FakeChannel`; deliver changes
// with `emitChange` and statuses with `setChannelStatus`. `removeChannel` marks it removed.
// Edge Functions, Storage and Auth are `jest.fn()`s: override them with `mockResolvedValue` etc.
import { jest } from '@jest/globals';
import type { Session } from '@supabase/supabase-js';

/** `status` is the HTTP status, as supabase-js reports it (0 when the request never got an answer). */
export type QueryResult = { data?: unknown; error?: unknown; count?: number | null; status?: number };

/** One table query: the table and each chained call, e.g. `['eq', 'user_id', 'u1']`. */
export type RecordedQuery = { table: string; ops: [string, ...unknown[]][] };

type QueryHandler = (query: RecordedQuery) => QueryResult | undefined;

const CHAIN_METHODS = [
  'select',
  'insert',
  'update',
  'upsert',
  'delete',
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'is',
  'or',
  'match',
  'order',
  'limit',
  'range',
  'single',
  'maybeSingle',
] as const;

/** Every table query made since the last reset, in order. */
export const queries: RecordedQuery[] = [];

const queued = new Map<string, QueryResult[]>();
let handler: QueryHandler | undefined;

/** Queues a result for the next query on `table` (FIFO). Takes precedence over `onQuery`. */
export function respondTo(table: string, ...results: QueryResult[]) {
  queued.set(table, [...(queued.get(table) ?? []), ...results]);
}

/** Computes results for queries that have nothing queued. */
export function onQuery(next: QueryHandler) {
  handler = next;
}

/** Queries on one table. */
export function queriesFor(table: string): RecordedQuery[] {
  return queries.filter((q) => q.table === table);
}

function resolveQuery(query: RecordedQuery): QueryResult {
  const fromQueue = queued.get(query.table)?.shift();
  return { data: null, error: null, ...(fromQueue ?? handler?.(query) ?? {}) };
}

function queryBuilder(table: string) {
  const query: RecordedQuery = { table, ops: [] };
  queries.push(query);
  const builder: Record<string, unknown> = {};
  for (const method of CHAIN_METHODS) {
    builder[method] = (...args: unknown[]) => {
      query.ops.push([method, ...args]);
      return builder;
    };
  }
  // Thenable, like supabase-js's PostgrestBuilder: the query runs when awaited.
  builder.then = (onFulfilled?: (r: QueryResult) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve()
      .then(() => resolveQuery(query))
      .then(onFulfilled, onRejected);
  return builder;
}

/** One `supabase.rpc(fn, args)` call. */
export type RecordedRpc = { fn: string; args: Record<string, unknown> | undefined };

type RpcHandler = (call: RecordedRpc) => QueryResult | undefined;

/** Every RPC call since the last reset, in order. */
export const rpcCalls: RecordedRpc[] = [];

const queuedRpc = new Map<string, QueryResult[]>();
let rpcHandler: RpcHandler | undefined;

/** Queues a result for the next call to `fn` (FIFO). Takes precedence over `onRpc`. */
export function respondToRpc(fn: string, ...results: QueryResult[]) {
  queuedRpc.set(fn, [...(queuedRpc.get(fn) ?? []), ...results]);
}

/** Computes results for RPC calls that have nothing queued. */
export function onRpc(next: RpcHandler) {
  rpcHandler = next;
}

/** Calls to one function. */
export function rpcCallsFor(fn: string): RecordedRpc[] {
  return rpcCalls.filter((c) => c.fn === fn);
}

function rpc(fn: string, args?: Record<string, unknown>): Promise<QueryResult> {
  const call: RecordedRpc = { fn, args };
  rpcCalls.push(call);
  return Promise.resolve().then(() => {
    const fromQueue = queuedRpc.get(fn)?.shift();
    return { data: null, error: null, ...(fromQueue ?? rpcHandler?.(call) ?? {}) };
  });
}

type AuthListener =(event: string, session: Session | null) => void;
const authListeners: AuthListener[] = [];

/** Calls every `onAuthStateChange` listener, as supabase-js would. */
export function emitAuthEvent(event: string, session: Session | null) {
  for (const listener of [...authListeners]) listener(event, session);
}

/** A minimal signed-in session for `userId`. */
export function makeSession(userId: string, email = 'test@example.com'): Session {
  return {
    access_token: `token-${userId}`,
    refresh_token: 'refresh',
    expires_in: 3600,
    token_type: 'bearer',
    user: { id: userId, email, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '' },
  } as Session;
}

/** One `.on('postgres_changes', filter, callback)` on a fake channel. */
export type ChannelBinding = {
  event: string;
  schema: string;
  table: string;
  filter?: string;
  callback: (payload: Record<string, unknown>) => void;
};

/** A `supabase.channel(name, opts)`: what it listens to and whether it's been removed. */
export type FakeChannel = {
  name: string;
  /** `realtime:<name>`, as Realtime names it. */
  topic: string;
  /** The options it was created with, e.g. `{ config: { private: true } }`. */
  opts: Record<string, unknown> | undefined;
  bindings: ChannelBinding[];
  /** `.on('presence', { event: 'sync' }, callback)` callbacks; `setPresence` calls them. */
  presenceListeners: (() => void)[];
  /** Every payload passed to `track`, in order. */
  tracked: Record<string, unknown>[];
  /** What `presenceState()` returns; set it with `setPresence`. */
  presence: Record<string, Record<string, unknown>[]>;
  removed: boolean;
  /** The `subscribe` callback; call it (or use `setChannelStatus`) to report a status. */
  onStatus: ((status: string, err?: Error) => void) | null;
  on: (type: string, filter: Omit<ChannelBinding, 'callback'>, callback: ChannelBinding['callback']) => FakeChannel;
  subscribe: (callback?: (status: string, err?: Error) => void) => FakeChannel;
  track: (payload: Record<string, unknown>) => Promise<string>;
  presenceState: () => Record<string, Record<string, unknown>[]>;
};

/** Every channel created since the last reset, removed ones included. */
export const realtimeChannels: FakeChannel[] = [];

function channel(name: string, opts?: Record<string, unknown>): FakeChannel {
  const ch: FakeChannel = {
    name,
    topic: `realtime:${name}`,
    opts,
    bindings: [],
    presenceListeners: [],
    tracked: [],
    presence: {},
    removed: false,
    onStatus: null,
    on: (type, filter, callback) => {
      if (type === 'presence') ch.presenceListeners.push(callback as () => void);
      else ch.bindings.push({ ...filter, callback });
      return ch;
    },
    subscribe: (callback) => {
      ch.onStatus = callback ?? null;
      return ch;
    },
    track: (payload) => {
      ch.tracked.push(payload);
      return Promise.resolve('ok');
    },
    presenceState: () => ch.presence,
  };
  realtimeChannels.push(ch);
  return ch;
}

/** Sets a channel's presence state (keyed by presence key, one entry per device) and reports a sync. */
export function setPresence(ch: FakeChannel, state: Record<string, Record<string, unknown>[]>) {
  ch.presence = state;
  if (!ch.removed) for (const listener of ch.presenceListeners) listener();
}

/** Channels not removed yet. */
export function openChannels(): FakeChannel[] {
  return realtimeChannels.filter((c) => !c.removed);
}

/** Reports `status` (e.g. 'SUBSCRIBED') to every open channel, or to `only`. */
export function setChannelStatus(status: string, only?: FakeChannel) {
  for (const ch of only ? [only] : openChannels()) ch.onStatus?.(status);
}

/**
 * Delivers a change to every open channel listening to `table`, as Realtime would: inserts and
 * updates only reach bindings whose `column=eq.value` filter matches the new row; deletes can't be
 * filtered, so they reach every binding on the table.
 */
export function emitChange(change: {
  table: string;
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new?: Record<string, unknown>;
  old?: Record<string, unknown>;
}) {
  const payload = { schema: 'public', commit_timestamp: '', errors: null, new: {}, old: {}, ...change };
  for (const ch of openChannels()) {
    for (const b of ch.bindings) {
      if (b.table !== change.table) continue;
      if (b.filter && change.eventType !== 'DELETE') {
        const [column, value] = b.filter.split('=eq.');
        if (String(change.new?.[column]) !== value) continue;
      }
      b.callback(payload);
    }
  }
}

const ok = () => Promise.resolve({ data: null, error: null });
type Result = { data: unknown; error: unknown };
type AsyncFn = (...args: any[]) => Promise<Result>;

const storageUpload = jest.fn<AsyncFn>();
const storageRemove = jest.fn<AsyncFn>();
const storageFrom = (bucket: string) => ({
  upload: (...args: unknown[]) => storageUpload(bucket, ...args),
  remove: (...args: unknown[]) => storageRemove(bucket, ...args),
});

export const supabase = {
  from: jest.fn((table: string) => queryBuilder(table)),
  rpc: jest.fn(rpc),
  channel: jest.fn(channel),
  getChannels: jest.fn(() => openChannels()),
  removeChannel: jest.fn((ch: FakeChannel) => {
    ch.removed = true;
    return Promise.resolve('ok');
  }),
  functions: {
    invoke: jest.fn<AsyncFn>(),
  },
  storage: {
    from: jest.fn(storageFrom),
  },
  auth: {
    getSession: jest.fn<AsyncFn>(),
    refreshSession: jest.fn<AsyncFn>(),
    onAuthStateChange: jest.fn((listener: AuthListener) => {
      authListeners.push(listener);
      return { data: { subscription: { unsubscribe: () => authListeners.splice(authListeners.indexOf(listener), 1) } } };
    }),
    signInWithOtp: jest.fn<AsyncFn>(),
    verifyOtp: jest.fn<AsyncFn>(),
    signOut: jest.fn<AsyncFn>(),
    startAutoRefresh: jest.fn(),
    stopAutoRefresh: jest.fn(),
  },
};

/** `storage.from(bucket).upload(path, body, options)` calls, as `[bucket, path, body, options]`. */
export function storageUploads() {
  return storageUpload.mock.calls;
}

/** The upload mock, so a test can answer one upload with an error (`mockResolvedValueOnce`). */
export const storageUploadMock = storageUpload;

/** The remove mock, so a test can fail one. */
export const storageRemoveMock = storageRemove;

/** `storage.from(bucket).remove(paths)` calls, as `[bucket, paths]`. */
export function storageRemovals() {
  return storageRemove.mock.calls;
}

export const supabaseUrl = 'https://project.supabase.test';

export let isSupabaseConfigured = true;

/** Simulates missing EXPO_PUBLIC_SUPABASE_* env vars. `resetSupabase` sets it back to true. */
export function setSupabaseConfigured(configured: boolean) {
  isSupabaseConfigured = configured;
}

/** Clears recorded calls, queued results and listeners; restores default responses. Call in `beforeEach`. */
export function resetSupabase() {
  queries.length = 0;
  queued.clear();
  handler = undefined;
  rpcCalls.length = 0;
  queuedRpc.clear();
  rpcHandler = undefined;
  isSupabaseConfigured = true;
  authListeners.length = 0;
  supabase.from.mockClear();
  supabase.rpc.mockReset().mockImplementation(rpc);
  realtimeChannels.length = 0;
  supabase.channel.mockClear();
  supabase.removeChannel.mockClear();
  supabase.storage.from.mockReset().mockImplementation(storageFrom);
  storageUpload.mockReset().mockImplementation(ok);
  storageRemove.mockReset().mockImplementation(ok);
  supabase.functions.invoke.mockReset().mockImplementation(ok);
  supabase.auth.getSession.mockReset().mockResolvedValue({ data: { session: null }, error: null });
  supabase.auth.refreshSession.mockReset().mockResolvedValue({ data: { session: null }, error: null });
  supabase.auth.onAuthStateChange.mockClear();
  for (const fn of [supabase.auth.signInWithOtp, supabase.auth.verifyOtp, supabase.auth.signOut]) {
    fn.mockReset().mockImplementation(ok);
  }
  supabase.auth.startAutoRefresh.mockClear();
  supabase.auth.stopAutoRefresh.mockClear();
}
resetSupabase();
