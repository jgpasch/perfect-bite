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

const ok = () => Promise.resolve({ data: null, error: null });
type Result = { data: unknown; error: unknown };
type AsyncFn = (...args: any[]) => Promise<Result>;

const storageUpload = jest.fn<AsyncFn>();

export const supabase = {
  from: jest.fn((table: string) => queryBuilder(table)),
  rpc: jest.fn(rpc),
  functions: {
    invoke: jest.fn<AsyncFn>(),
  },
  storage: {
    from: jest.fn((bucket: string) => ({
      upload: (...args: unknown[]) => storageUpload(bucket, ...args),
    })),
  },
  auth: {
    getSession: jest.fn<AsyncFn>(),
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
  supabase.storage.from.mockClear();
  storageUpload.mockReset().mockImplementation(ok);
  supabase.functions.invoke.mockReset().mockImplementation(ok);
  supabase.auth.getSession.mockReset().mockResolvedValue({ data: { session: null }, error: null });
  supabase.auth.onAuthStateChange.mockClear();
  for (const fn of [supabase.auth.signInWithOtp, supabase.auth.verifyOtp, supabase.auth.signOut]) {
    fn.mockReset().mockImplementation(ok);
  }
  supabase.auth.startAutoRefresh.mockClear();
  supabase.auth.stopAutoRefresh.mockClear();
}
resetSupabase();
