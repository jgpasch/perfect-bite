import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import type { NetworkState } from 'expo-network';
import { AppState, type AppStateStatus } from 'react-native';

import { categories, db, householdCategoryOverrides, households, householdStaples, lists, recipes, userCategoryOrder, userSettings } from '@/db';
import { setSlot } from '@/features/meal-plan/write';
import { onQuery, onRpc, queries, resetSupabase, respondTo, respondToRpc, rpcCalls, setSupabaseConfigured, supabase } from '@/test/fake-supabase';
import { resetDb } from '@/test/db';
import { clearOutbox, outboxMutations, outboxRows } from '@/test/outbox';

import { deleteRows, insertRow, updateRows, upsertRow } from '../mutate';
import type { Mutation } from '../mutation';
import { BACKOFF_SCHEDULE_MS, backoffDelayMs, getPushState, PUSH_BATCH_SIZE, PUSH_DEBOUNCE_MS, pushNow, startPush } from '../push';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
const mockReportError = jest.fn();
jest.mock('@/lib/sentry', () => ({ reportError: (...args: unknown[]) => mockReportError(...args) }));

// jest.mock is hoisted above the imports; the factories read these lazily.
const mockAuth: { account: { userId: string } | null } = { account: { userId: 'u1' } };
jest.mock('@/features/auth/account', () => ({ getAccount: () => mockAuth.account }));

const mockNetwork: { listener: ((s: NetworkState) => void) | null } = { listener: null };
jest.mock('expo-network', () => ({
  addNetworkStateListener: (listener: (s: NetworkState) => void) => {
    mockNetwork.listener = listener;
    return { remove: () => {} };
  },
}));

const mockApp: { listener: ((s: AppStateStatus) => void) | null } = { listener: null };
Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true, writable: true });
jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
  mockApp.listener = listener as (s: AppStateStatus) => void;
  return { remove: () => {} };
});

const H = 'household-1';
const T0 = new Date('2026-10-10T12:00:00.000Z');
const at = (ms: number) => () => new Date(T0.getTime() + ms);

let stop: (() => void) | null = null;

beforeEach(() => {
  resetDb();
  resetSupabase();
  mockReportError.mockClear();
  mockAuth.account = { userId: 'u1' };
  insertRow(db, households, { id: H, name: 'Home' });
  clearOutbox();
});

afterEach(() => {
  stop?.();
  stop = null;
  jest.useRealTimers();
});

const addList = (id: string, name = id) => insertRow(db, lists, { id, householdId: H, name, position: 1 });
const applyCalls = () => rpcCalls.filter((c) => c.fn === 'apply_mutations');
const sent = (i: number) => (applyCalls()[i].args as { mutations: Mutation[] }).mutations;
/** Answers every apply_mutations call with `applied` for each mutation. */
const applyAll = () =>
  onRpc((call) =>
    call.fn === 'apply_mutations'
      ? { data: (call.args as { mutations: Mutation[] }).mutations.map(() => ({ status: 'applied' })), status: 200 }
      : undefined,
  );

describe('backoff schedule (stash)', () => {
  test('5 s, 30 s, 2 min, 10 min, then hourly', () => {
    expect(BACKOFF_SCHEDULE_MS).toEqual([5_000, 30_000, 120_000, 600_000, 3_600_000]);
    expect([0, 1, 2, 3, 4, 5, 6, 50].map(backoffDelayMs)).toEqual([
      5_000, 5_000, 30_000, 120_000, 600_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
  });
});

describe('order', () => {
  test('sends the outbox to apply_mutations in order and empties it', async () => {
    addList('l1', 'Groceries');
    addList('l2', 'Costco');
    updateRows(db, lists, eq(lists.id, 'l1'), { name: 'Food' });
    const queued = outboxMutations();
    applyAll();

    await expect(pushNow({ now: at(0) })).resolves.toEqual({ pushed: 3, rejected: 0, failed: false });

    expect(applyCalls()).toHaveLength(1);
    expect(sent(0)).toEqual(queued);
    expect(sent(0).map((m) => [m.id, m.fields.name])).toEqual([
      ['l1', 'Groceries'],
      ['l2', 'Costco'],
      ['l1', 'Food'],
    ]);
    expect(outboxRows()).toEqual([]);
    expect(getPushState()).toEqual({ attempts: 0, nextAttemptAt: null, lastError: null, lastSuccessAt: T0.toISOString() });
  });

  test(`splits a long queue into batches of ${PUSH_BATCH_SIZE}, in order`, async () => {
    for (let i = 0; i < 150; i++) addList(`l${String(i).padStart(3, '0')}`);
    const ids = outboxMutations().map((m) => m.id);
    applyAll();

    await pushNow();

    expect(applyCalls().map((c, i) => sent(i).length)).toEqual([100, 50]);
    expect([...sent(0), ...sent(1)].map((m) => m.id)).toEqual(ids);
    expect(outboxRows()).toEqual([]);
  });

  test('per-user and household mutations go in their place in the queue', async () => {
    resetDb();
    const log: string[] = [];
    onRpc((call) => {
      log.push(call.fn);
      if (call.fn !== 'apply_mutations') return undefined;
      return { data: (call.args as { mutations: Mutation[] }).mutations.map(() => ({ status: 'applied' })) };
    });
    onQuery((q) => {
      log.push(`${q.table}.${q.ops[0][0]}`);
      return undefined;
    });
    insertRow(db, households, { id: H, name: 'Home' });
    addList('l1');
    addList('l2');
    upsertRow(db, userSettings, { userId: 'u1', defaultListId: 'l1' }, { defaultListId: 'l1' });
    updateRows(db, lists, eq(lists.id, 'l2'), { name: 'Two' });

    await pushNow();

    expect(log).toEqual(['create_household', 'apply_mutations', 'user_settings.upsert', 'apply_mutations']);
    expect(rpcCalls[0].args).toEqual({ p_id: H, p_name: 'Home' });
    expect(sent(0).map((m) => m.id)).toEqual(['l1', 'l2']);
    expect(sent(1).map((m) => m.fields)).toEqual([{ name: 'Two' }]);
    expect(queries[0].ops).toEqual([['upsert', { user_id: 'u1', default_list_id: 'l1' }, { onConflict: 'user_id' }]]);
    expect(outboxRows()).toEqual([]);
  });

  test('merged and unchanged results count as sent', async () => {
    addList('l1');
    addList('l2');
    respondToRpc('apply_mutations', { data: [{ status: 'merged', merged_into: 'x' }, { status: 'unchanged' }] });

    await expect(pushNow()).resolves.toEqual({ pushed: 2, rejected: 0, failed: false });
    expect(outboxRows()).toEqual([]);
  });

  test('custom categories and overrides go through apply_mutations; the order stays a per-user write', async () => {
    applyAll();
    insertRow(db, categories, { id: 'c1', name: 'Bakery', householdId: H });
    upsertRow(db, userCategoryOrder, { userId: 'u1', categoryId: 'c1', position: 2 }, { position: 2 });
    upsertRow(db, householdCategoryOverrides, { householdId: H, ingredientName: 'milk', categoryId: 'c1' }, { categoryId: 'c1' });
    upsertRow(db, householdCategoryOverrides, { householdId: H, ingredientName: 'milk', categoryId: null }, { categoryId: null });
    updateRows(db, categories, eq(categories.id, 'c1'), { name: 'Bread' });
    deleteRows(db, userCategoryOrder, eq(userCategoryOrder.categoryId, 'c1'));

    await expect(pushNow()).resolves.toEqual({ pushed: 6, rejected: 0, failed: false });

    // Two batches around the order upsert; no direct category or override writes.
    expect(applyCalls()).toHaveLength(2);
    expect(sent(0).map((m) => [m.table, m.id ?? m.key, m.fields])).toEqual([
      ['categories', 'c1', { name: 'Bakery', household_id: H }],
    ]);
    expect(sent(1).map((m) => [m.table, m.id ?? m.key, m.fields])).toEqual([
      ['household_category_overrides', { household_id: H, ingredient_name: 'milk' }, { category_id: 'c1' }],
      ['household_category_overrides', { household_id: H, ingredient_name: 'milk' }, { category_id: null }],
      ['categories', 'c1', { name: 'Bread' }],
    ]);
    expect(queries.map((q) => [q.table, ...q.ops])).toEqual([
      ['user_category_order', ['upsert', { user_id: 'u1', category_id: 'c1', position: 2 }, { onConflict: 'user_id,category_id' }]],
      ['user_category_order', ['delete'], ['match', { user_id: 'u1', category_id: 'c1' }]],
    ]);
    expect(outboxRows()).toEqual([]);
  });

  test('staples go through apply_mutations by key, with deleted_at and never created_by', async () => {
    applyAll();
    const mark = (deletedAt: Date | null) =>
      upsertRow(db, householdStaples, { householdId: H, ingredientName: 'salt', createdBy: 'u1', deletedAt }, { deletedAt });
    mark(null);
    mark(new Date('2026-10-01T12:00:00.000Z'));
    mark(null);

    await expect(pushNow()).resolves.toEqual({ pushed: 3, rejected: 0, failed: false });

    expect(applyCalls()).toHaveLength(1);
    const key = { household_id: H, ingredient_name: 'salt' };
    expect(sent(0).map((m) => [m.table, m.key, m.fields])).toEqual([
      ['household_staples', key, { deleted_at: null }],
      ['household_staples', key, { deleted_at: '2026-10-01T12:00:00.000Z' }],
      ['household_staples', key, { deleted_at: null }],
    ]);
    expect(queries).toEqual([]);
    expect(outboxRows()).toEqual([]);
  });

  test('meal plan entries go through apply_mutations by id, with every field on insert and never added_by', async () => {
    applyAll();
    insertRow(db, recipes, { id: 'r1', householdId: H, name: 'Tacos' });
    clearOutbox();
    const first = setSlot(H, '2026-10-15', 'dinner', { kind: 'recipe', recipeId: 'r1' });
    const second = setSlot(H, '2026-10-15', 'dinner', { kind: 'note', note: 'Pizza night' });

    await expect(pushNow()).resolves.toEqual({ pushed: 3, rejected: 0, failed: false });

    expect(applyCalls()).toHaveLength(1);
    expect(sent(0).map((m) => [m.table, m.id, m.fields])).toEqual([
      [
        'meal_plan_entries',
        first.id,
        {
          household_id: H,
          plan_date: '2026-10-15',
          meal: 'dinner',
          position: 0,
          kind: 'recipe',
          recipe_id: 'r1',
          note: null,
          deleted_at: null,
          created_at: first.createdAt.toISOString(),
        },
      ],
      ['meal_plan_entries', first.id, { deleted_at: expect.any(String) }],
      ['meal_plan_entries', second.id, expect.objectContaining({ kind: 'note', recipe_id: null, note: 'Pizza night' })],
    ]);
    expect(sent(0).every((m) => !('added_by' in m.fields))).toBe(true);
    expect(queries).toEqual([]);
    expect(outboxRows()).toEqual([]);
  });

  test('a rejected override is recorded and skipped like any household mutation', async () => {
    upsertRow(db, householdCategoryOverrides, { householdId: H, ingredientName: 'milk', categoryId: null }, { categoryId: null });
    respondToRpc('apply_mutations', { data: [{ status: 'rejected', code: '22023', message: "category isn't available" }] });

    await expect(pushNow({ now: at(0) })).resolves.toEqual({ pushed: 0, rejected: 1, failed: false });
    expect(outboxRows().map((r) => [r.mutation.table, r.error])).toEqual([
      ['household_category_overrides', { code: '22023', message: "category isn't available" }],
    ]);
    expect(queries).toEqual([]);
  });
});

describe('a rejected mutation does not block the rest', () => {
  test('apply_mutations rejection is recorded and skipped', async () => {
    addList('l1');
    addList('l2');
    addList('l3');
    respondToRpc('apply_mutations', {
      data: [{ status: 'applied' }, { status: 'rejected', code: '42501', message: 'not a member of household x' }, { status: 'applied' }],
    });

    await expect(pushNow({ now: at(0) })).resolves.toEqual({ pushed: 2, rejected: 1, failed: false });

    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].mutation.id).toBe('l2');
    expect(rows[0].rejectedAt).toEqual(T0);
    expect(rows[0].error).toEqual({ code: '42501', message: 'not a member of household x' });
    expect(getPushState().attempts).toBe(0);
    // The edit is lost, so Sentry hears about it.
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError).toHaveBeenCalledWith(new Error('Sync change to lists rejected: 42501: not a member of household x'), {
      area: 'sync',
      event: 'push_rejected',
      table: 'lists',
      code: '42501',
    });

    // Never sent again; later writes go without it.
    addList('l4');
    applyAll();
    await pushNow();
    expect(applyCalls()).toHaveLength(2);
    expect(sent(1).map((m) => m.id)).toEqual(['l4']);
    expect(outboxRows().map((r) => r.mutation.id)).toEqual(['l2']);
  });

  test('a 4xx on a per-user write is recorded and the queue moves on', async () => {
    // Only on this device (no mutation), so the server doesn't have it.
    db.insert(categories).values({ id: 'c9', name: 'Local', householdId: H }).run();
    insertRow(db, userCategoryOrder, { userId: 'u1', categoryId: 'c9', position: 1 });
    addList('l1');
    respondTo('user_category_order', { error: { code: '23503', message: 'violates foreign key' }, status: 409 });
    applyAll();

    await expect(pushNow({ now: at(0) })).resolves.toEqual({ pushed: 1, rejected: 1, failed: false });

    expect(sent(0).map((m) => m.id)).toEqual(['l1']);
    const rows = outboxRows();
    expect(rows.map((r) => [r.mutation.table, r.error, r.rejectedAt])).toEqual([
      ['user_category_order', { code: '23503', message: 'violates foreign key' }, T0],
    ]);
  });

  test("create_household refused with 'already in a household' (400 P0001) is recorded and the queue moves on", async () => {
    resetDb();
    insertRow(db, households, { id: H, name: 'Home' });
    addList('l1');
    respondToRpc('create_household', { data: null, error: { code: 'P0001', message: 'already in a household' }, status: 400 });
    applyAll();

    await expect(pushNow({ now: at(0) })).resolves.toEqual({ pushed: 1, rejected: 1, failed: false });

    expect(rpcCalls.map((c) => c.fn)).toEqual(['create_household', 'apply_mutations']);
    expect(sent(0).map((m) => m.id)).toEqual(['l1']);
    expect(outboxRows().map((r) => [r.mutation.table, r.mutation.id, r.error, r.rejectedAt])).toEqual([
      ['households', H, { code: 'P0001', message: 'already in a household' }, T0],
    ]);
    expect(getPushState().attempts).toBe(0);
  });

  test('a household change other than creation is recorded as unsupported', async () => {
    updateRows(db, households, eq(households.id, H), { name: 'Renamed' });
    addList('l1');
    applyAll();

    await expect(pushNow()).resolves.toEqual({ pushed: 1, rejected: 1, failed: false });
    expect(outboxRows()[0].error).toEqual({ code: 'unsupported', message: 'Household changes other than creation are not synced yet' });
    expect(rpcCalls.map((c) => c.fn)).toEqual(['apply_mutations']);
  });
});

describe('retry with backoff', () => {
  test('a failed call keeps the queue and backs off on the schedule', async () => {
    addList('l1');
    addList('l2');
    const queued = outboxRows();
    respondToRpc('apply_mutations', { error: { message: 'TypeError: Network request failed', code: '' }, status: 0 });

    await expect(pushNow({ now: at(0) })).resolves.toEqual({ pushed: 0, rejected: 0, failed: true });
    expect(outboxRows()).toEqual(queued);
    expect(getPushState()).toEqual({
      attempts: 1,
      nextAttemptAt: new Date(T0.getTime() + 5_000).toISOString(),
      lastError: 'TypeError: Network request failed',
      lastSuccessAt: null,
    });

    // Waits out the delay.
    await expect(pushNow({ now: at(4_999) })).resolves.toEqual({ skipped: 'backoff' });
    expect(applyCalls()).toHaveLength(1);

    // Second failure: 30 s.
    respondToRpc('apply_mutations', { error: { message: 'upstream', code: '' }, status: 503 });
    await pushNow({ now: at(5_000) });
    expect(getPushState()).toMatchObject({ attempts: 2, nextAttemptAt: new Date(T0.getTime() + 35_000).toISOString() });

    // Then it gets through, in the original order.
    applyAll();
    await expect(pushNow({ now: at(35_000) })).resolves.toEqual({ pushed: 2, rejected: 0, failed: false });
    expect(sent(2).map((m) => m.id)).toEqual(['l1', 'l2']);
    expect(outboxRows()).toEqual([]);
    expect(getPushState()).toEqual({
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      lastSuccessAt: new Date(T0.getTime() + 35_000).toISOString(),
    });
  });

  test('a forced push (foreground, reconnect, Sync now) ignores the backoff', async () => {
    addList('l1');
    respondToRpc('apply_mutations', { error: { message: 'down' }, status: 500 });
    await pushNow({ now: at(0) });
    applyAll();
    await expect(pushNow({ now: at(1), force: true })).resolves.toEqual({ pushed: 1, rejected: 0, failed: false });
  });

  test('a thrown request, a 401 and a malformed response retry rather than drop', async () => {
    addList('l1');
    jest.mocked(supabase.rpc).mockRejectedValueOnce(new Error('socket hang up'));
    await expect(pushNow({ force: true })).resolves.toMatchObject({ failed: true });
    expect(getPushState().lastError).toBe('socket hang up');

    respondToRpc('apply_mutations', { error: { message: 'JWT expired', code: 'PGRST303' }, status: 401 });
    await expect(pushNow({ force: true })).resolves.toMatchObject({ failed: true });

    respondToRpc('apply_mutations', { data: [] });
    await expect(pushNow({ force: true })).resolves.toMatchObject({ failed: true });
    expect(getPushState()).toMatchObject({ attempts: 3, lastError: 'apply_mutations returned an unexpected response' });

    expect(outboxRows().map((r) => [r.mutation.id, r.rejectedAt])).toEqual([['l1', null]]);
  });

  test('a 5xx or 401 on a per-user write holds the queue behind it', async () => {
    upsertRow(db, userSettings, { userId: 'u1', defaultListId: null }, { defaultListId: null });
    addList('l1');
    respondTo('user_settings', { error: { message: 'JWT expired' }, status: 401 }, { error: { message: 'boom' }, status: 500 });

    await expect(pushNow({ force: true })).resolves.toMatchObject({ failed: true });
    await expect(pushNow({ force: true })).resolves.toMatchObject({ failed: true });
    expect(applyCalls()).toEqual([]);
    expect(outboxRows().map((r) => [r.mutation.table, r.rejectedAt])).toEqual([
      ['user_settings', null],
      ['lists', null],
    ]);
  });

  test('the retry timer pushes again when the delay is up', async () => {
    jest.useFakeTimers({ now: T0 });
    respondToRpc('apply_mutations', { error: { message: 'down' }, status: 0 });
    addList('l1');
    stop = startPush();
    await jest.advanceTimersByTimeAsync(0);
    expect(applyCalls()).toHaveLength(1);

    applyAll();
    await jest.advanceTimersByTimeAsync(4_999);
    expect(applyCalls()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(applyCalls()).toHaveLength(2);
    expect(outboxRows()).toEqual([]);
  });
});

describe('offline holds', () => {
  test('nothing is sent while offline, and the queue goes on reconnect', async () => {
    jest.useFakeTimers({ now: T0 });
    applyAll();
    stop = startPush();
    await jest.advanceTimersByTimeAsync(0);
    mockNetwork.listener!({ isConnected: false, isInternetReachable: false });

    addList('l1');
    addList('l2');
    await jest.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);
    await expect(pushNow({ force: true })).resolves.toEqual({ skipped: 'offline' });
    expect(applyCalls()).toEqual([]);
    expect(outboxRows()).toHaveLength(2);

    mockNetwork.listener!({ isConnected: true, isInternetReachable: true });
    await jest.advanceTimersByTimeAsync(0);
    expect(applyCalls()).toHaveLength(1);
    expect(sent(0).map((m) => m.id)).toEqual(['l1', 'l2']);
    expect(outboxRows()).toEqual([]);
  });

  test('signed out or unconfigured: nothing is sent', async () => {
    addList('l1');
    mockAuth.account = null;
    await expect(pushNow({ force: true })).resolves.toEqual({ skipped: 'no-session' });
    mockAuth.account = { userId: 'u1' };
    setSupabaseConfigured(false);
    await expect(pushNow({ force: true })).resolves.toEqual({ skipped: 'no-session' });
    expect(rpcCalls).toEqual([]);
    expect(outboxRows()).toHaveLength(1);
  });
});

describe('triggers', () => {
  test('writes push once they have been quiet for the debounce', async () => {
    jest.useFakeTimers({ now: T0 });
    applyAll();
    stop = startPush();
    await jest.advanceTimersByTimeAsync(0);
    expect(applyCalls()).toEqual([]); // empty outbox: nothing to send

    addList('l1');
    await jest.advanceTimersByTimeAsync(500);
    addList('l2');
    addList('l3');
    await jest.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS - 1);
    expect(applyCalls()).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(applyCalls()).toHaveLength(1);
    expect(sent(0).map((m) => m.id)).toEqual(['l1', 'l2', 'l3']);
  });

  test('returning to the foreground pushes', async () => {
    jest.useFakeTimers({ now: T0 });
    applyAll();
    mockAuth.account = null; // so the launch and debounced pushes skip
    stop = startPush();
    addList('l1');
    await jest.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);
    expect(applyCalls()).toEqual([]);

    mockAuth.account = { userId: 'u1' };
    mockApp.listener!('background');
    await jest.advanceTimersByTimeAsync(0);
    expect(applyCalls()).toEqual([]);
    mockApp.listener!('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(applyCalls()).toHaveLength(1);
    expect(sent(0).map((m) => m.id)).toEqual(['l1']);
    expect(outboxRows()).toEqual([]);
  });

  test('a push asked for during a run runs once more and sends the new writes', async () => {
    addList('l1');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    jest.mocked(supabase.rpc).mockImplementationOnce(async (_fn, args) => {
      await gate;
      return { data: (args as { mutations: Mutation[] }).mutations.map(() => ({ status: 'applied' })), error: null };
    });
    applyAll();

    const first = pushNow();
    await Promise.resolve();
    addList('l2');
    const second = pushNow();
    const third = pushNow();
    expect(second).toBe(first);
    expect(third).toBe(first);
    release();
    await first;

    // The gated call bypasses the fake's recorder, so read the mock's own calls.
    const batches = jest.mocked(supabase.rpc).mock.calls.map(([, args]) => (args as { mutations: Mutation[] }).mutations);
    expect(batches.map((b) => b.map((m) => m.id))).toEqual([['l1'], ['l2']]);
    expect(outboxRows()).toEqual([]);
  });
});
