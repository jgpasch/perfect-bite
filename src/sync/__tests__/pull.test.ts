import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { asc, eq } from 'drizzle-orm';

import {
  categories,
  db,
  deviceSettings,
  householdCategoryOverrides,
  householdMemberNames,
  households,
  householdStaples,
  ingredients,
  ingredientUnitUsage,
  ingredientUsage,
  listItemContributions,
  listItems,
  lists,
  mealPlanEntries,
  recipes,
  userCategoryOrder,
  userSettings,
} from '@/db';
import { setCategoryOverride } from '@/features/categories/categories';
import { categorizePending, catchUpNames } from '@/features/categories/categorization';
import { listItemsQuery } from '@/features/lists/items';
import { ensureStarterData } from '@/features/lists/lists';
import {
  makeSession,
  onQuery,
  onRpc,
  queries,
  queriesFor,
  resetSupabase,
  rpcCallsFor,
  supabase,
  type RecordedQuery,
} from '@/test/fake-supabase';
import { resetDb } from '@/test/db';
import { clearOutbox, outboxRows } from '@/test/outbox';

import { getDeviceId, nextHlc } from '../clock';
import { compareHlc } from '../hlc';
import { deleteRows, insertRow, updateRows, upsertRow } from '../mutate';
import {
  applyRemoteDelete,
  getPullState,
  householdCursorKey,
  mergeScopes,
  onMemberships,
  PULL_OVERLAP_MS,
  PULL_PAGE_SIZE,
  pullNow,
  remoteFieldWins,
  type ServerRow,
} from '../pull';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));

const mockAuth: { account: { userId: string } | null } = { account: { userId: 'u1' } };
jest.mock('@/features/auth/account', () => ({ getAccount: () => mockAuth.account }));

jest.mock('expo-network', () => ({ addNetworkStateListener: () => ({ remove: () => {} }) }));

const mockClearPhotoCache = jest.fn(async () => {});
jest.mock('@/lib/photo-cache', () => ({ clearPhotoCache: () => mockClearPhotoCache() }));

const H1 = 'household-1';
const H2 = 'household-2';
const L = 'list-1';
const OLD = '1000000000000-0000-remote';
const NEW = '9000000000000-0000-remote';

/** A server timestamp `s` seconds (and `us` microseconds) after noon, as PostgREST writes it. */
const ts = (s: number, us = 0) =>
  `2026-10-10T12:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(us).padStart(6, '0')}+00:00`;

// --- A tiny server: tables of rows, filtered the way PostgREST would. ---------------------

let server: Record<string, ServerRow[]>;
let memberships: string[];
let failTable: string | null;

function serve(query: RecordedQuery) {
  if (query.table === failTable) return { data: null, error: { message: 'Network request failed' }, status: 0 };
  if (query.table === 'household_members') {
    return { data: memberships.map((household_id) => ({ household_id })), status: 200 };
  }
  let rows = [...(server[query.table] ?? [])];
  let limit: number | null = null;
  for (const [op, column, value] of query.ops) {
    if (op === 'eq') rows = rows.filter((r) => String(r[column as string]) === value);
    if (op === 'is' && value === null) rows = rows.filter((r) => r[column as string] == null);
    if (op === 'gt') rows = rows.filter((r) => Date.parse(r[column as string] as string) > Date.parse(value as string));
    if (op === 'order') rows.sort((a, b) => ((a[column as string] as string) < (b[column as string] as string) ? -1 : 1));
    if (op === 'limit') limit = column as number;
  }
  return { data: limit === null ? rows : rows.slice(0, limit), status: 200 };
}

const put = (table: string, ...rows: ServerRow[]) => {
  server[table] = [...(server[table] ?? []), ...rows];
};

const remoteHousehold = (id: string, updated: string, name = 'Home', combineLanguages = false): ServerRow => ({
  id,
  name,
  combine_languages: combineLanguages,
  created_by: 'u2',
  created_at: ts(0),
  updated_at: updated,
});

const remoteList = (id: string, updated: string, extra: Partial<ServerRow> = {}): ServerRow => ({
  id,
  household_id: H1,
  name: id,
  emoji: null,
  position: 1,
  archived_at: null,
  deleted_at: null,
  field_clock: { household_id: OLD, name: OLD, emoji: OLD, position: OLD, archived_at: OLD, deleted_at: OLD, created_at: OLD },
  created_at: ts(0),
  updated_at: updated,
  ...extra,
});

/** A remote item's clocks when every field was set by one old insert. */
const ITEM_CLOCK: Record<string, string> = {
  list_id: OLD,
  household_id: OLD,
  ingredient_name: OLD,
  display_name: OLD,
  note: OLD,
  checked_at: OLD,
  deleted_at: OLD,
};

const remoteItem = (id: string, updated: string, extra: Partial<ServerRow> = {}): ServerRow => ({
  id,
  list_id: L,
  household_id: H1,
  ingredient_name: 'milk',
  display_name: 'milk',
  note: null,
  checked_at: null,
  checked_by: null,
  added_by: 'u2',
  deleted_at: null,
  merged_into: null,
  field_clock: ITEM_CLOCK,
  created_at: ts(0),
  updated_at: updated,
  ...extra,
});

const remoteContribution = (id: string, itemId: string, updated: string, quantity: number | null = null): ServerRow => ({
  id,
  list_item_id: itemId,
  household_id: H1,
  source: 'manual',
  recipe_id: null,
  quantity,
  unit: null,
  added_by: 'u2',
  deleted_at: null,
  field_clock: { list_item_id: OLD, quantity: OLD },
  created_at: ts(0),
  updated_at: updated,
});

/** The household and list exist on both sides and have been pulled once. */
function seedPulledList() {
  put('households', remoteHousehold(H1, ts(1)));
  put('lists', remoteList(L, ts(1)));
}

const itemRow = (id: string) => db.select().from(listItems).where(eq(listItems.id, id)).get();
const contributionsOf = (itemId: string) =>
  db
    .select({ id: listItemContributions.id })
    .from(listItemContributions)
    .where(eq(listItemContributions.listItemId, itemId))
    .orderBy(asc(listItemContributions.id))
    .all()
    .map((c) => c.id);
/** Queries for one table's rows, without the membership lookup. */
const tableQueries = (table: string) => queriesFor(table).map((q) => q.ops);

beforeEach(() => {
  resetDb();
  resetSupabase();
  mockAuth.account = { userId: 'u1' };
  server = {};
  memberships = [H1];
  failTable = null;
  onQuery(serve);
});

describe('remoteFieldWins (LWW, 7.3)', () => {
  test('a newer or equal remote HLC wins; an older one loses to the local edit', () => {
    expect(remoteFieldWins(NEW, OLD, true)).toBe(true);
    expect(remoteFieldWins(OLD, OLD, false)).toBe(true);
    expect(remoteFieldWins(OLD, NEW, false)).toBe(false);
    expect(remoteFieldWins(OLD, undefined, true)).toBe(true);
  });

  test('without a remote clock, only an unpushed local edit keeps the local value', () => {
    expect(remoteFieldWins(undefined, NEW, false)).toBe(true);
    expect(remoteFieldWins(undefined, NEW, true)).toBe(false);
    expect(remoteFieldWins(undefined, undefined, false)).toBe(true);
  });
});

describe('first pull of a household', () => {
  test('pulls every table in full, parents first, and saves a cursor per table', async () => {
    seedPulledList();
    put('list_items', remoteItem('i1', ts(2)));
    put('list_item_contributions', remoteContribution('c1', 'i1', ts(3, 250), 2));

    await expect(pullNow()).resolves.toEqual({ pulled: 4, households: [H1], error: null });

    expect(queries.map((q) => q.table)).toEqual([
      'household_members',
      'households',
      'categories',
      'household_category_overrides',
      'household_staples',
      'lists',
      'recipes',
      'list_items',
      'recipe_ingredients',
      'list_item_contributions',
      'meal_plan_entries',
      'ingredient_usage',
      'ingredient_unit_usage',
      'user_category_order',
      'user_settings',
      'categories',
      'ingredients',
    ]);
    expect(queriesFor('household_members')[0].ops).toEqual([
      ['select', 'household_id'],
      ['eq', 'user_id', 'u1'],
    ]);
    // No cursor yet: everything, oldest first.
    expect(tableQueries('lists')).toEqual([
      [
        ['select', '*'],
        ['eq', 'household_id', H1],
        ['order', 'updated_at', { ascending: true }],
        ['limit', PULL_PAGE_SIZE],
      ],
    ]);
    expect(tableQueries('households')[0][1]).toEqual(['eq', 'id', H1]);
    expect(tableQueries('user_settings')[0][1]).toEqual(['eq', 'user_id', 'u1']);
    // Custom categories with their household; system ones with the catalog.
    expect(tableQueries('categories').map((ops) => ops[1])).toEqual([
      ['eq', 'household_id', H1],
      ['is', 'household_id', null],
    ]);
    expect(tableQueries('household_category_overrides')[0][1]).toEqual(['eq', 'household_id', H1]);

    expect(db.select().from(households).all()).toEqual([
      { id: H1, name: 'Home', combineLanguages: false, createdAt: new Date(ts(0)), updatedAt: new Date(ts(1)), fieldClock: {} },
    ]);
    expect(itemRow('i1')).toMatchObject({
      listId: L,
      householdId: H1,
      displayName: 'milk',
      checkedAt: null,
      addedBy: 'u2',
      createdAt: new Date(ts(0)),
      updatedAt: new Date(ts(2)),
      fieldClock: remoteItem('i1', ts(2)).field_clock,
    });
    expect(db.select().from(listItemContributions).get()).toMatchObject({ id: 'c1', listItemId: 'i1', quantity: 2 });

    // Pull never writes the outbox: the rows are already on the server.
    expect(outboxRows()).toEqual([]);
    expect(getPullState().cursors).toEqual({
      [householdCursorKey(H1, 'households')]: ts(1),
      [householdCursorKey(H1, 'lists')]: ts(1),
      [householdCursorKey(H1, 'list_items')]: ts(2),
      [householdCursorKey(H1, 'list_item_contributions')]: ts(3, 250),
    });
    expect(getPullState()).toMatchObject({ userId: 'u1', lastError: null });
  });

  test("the pulled item's ingredient is cached as pending until the catalog knows it", async () => {
    seedPulledList();
    put('list_items', remoteItem('i1', ts(2), { ingredient_name: 'yuzu kosho', display_name: 'Yuzu kosho' }));

    await pullNow();

    expect(db.select().from(ingredients).where(eq(ingredients.normalizedName, 'yuzu kosho')).get()).toMatchObject({
      displayName: 'Yuzu kosho',
      status: 'pending',
    });
  });

  test("a household-mate's unknown name, pulled by a realtime (scoped) pull, goes out with the next catch-up", async () => {
    seedPulledList();
    await pullNow();
    put('list_items', remoteItem('i1', ts(2), { ingredient_name: 'yuzu kosho', display_name: 'Yuzu kosho' }));

    await pullNow({ scope: { households: [H1] } });

    expect(catchUpNames()).toEqual(['yuzu kosho']);
    supabase.auth.getSession.mockResolvedValue({ data: { session: makeSession('u1') }, error: null });
    await categorizePending();
    expect(supabase.functions.invoke).toHaveBeenCalledWith('categorize-ingredients', { body: { names: ['yuzu kosho'] } });
  });
});

describe('cursors', () => {
  test('the next pull asks only for rows changed since the cursor (less the overlap)', async () => {
    seedPulledList();
    await pullNow();
    queries.length = 0;
    put('lists', remoteList('list-2', ts(30)));

    await expect(pullNow()).resolves.toMatchObject({ error: null });

    const since = new Date(Date.parse(ts(1)) - PULL_OVERLAP_MS).toISOString();
    expect(tableQueries('lists')).toEqual([
      [
        ['select', '*'],
        ['eq', 'household_id', H1],
        ['gt', 'updated_at', since],
        ['order', 'updated_at', { ascending: true }],
        ['limit', PULL_PAGE_SIZE],
      ],
    ]);
    // Tables never pulled before still start from zero.
    expect(tableQueries('recipes')[0]).not.toContainEqual(expect.arrayContaining(['gt']));
    expect(db.select({ id: lists.id }).from(lists).orderBy(asc(lists.id)).all()).toEqual([{ id: L }, { id: 'list-2' }]);
    expect(getPullState().cursors[householdCursorKey(H1, 'lists')]).toBe(ts(30));
  });

  test('a cursor never moves back when overlap brings older rows again', async () => {
    seedPulledList();
    put('lists', remoteList('list-2', ts(4)));
    await pullNow();
    expect(getPullState().cursors[householdCursorKey(H1, 'lists')]).toBe(ts(4));

    await pullNow();

    expect(getPullState().cursors[householdCursorKey(H1, 'lists')]).toBe(ts(4));
    expect(outboxRows()).toEqual([]);
  });

  test('each household has its own cursors', async () => {
    memberships = [H1, H2];
    seedPulledList();
    put('households', remoteHousehold(H2, ts(50), 'Cabin'));
    put('lists', remoteList('cabin-list', ts(51), { household_id: H2 }));

    await pullNow();

    expect(getPullState().cursors).toMatchObject({
      [householdCursorKey(H1, 'lists')]: ts(1),
      [householdCursorKey(H2, 'lists')]: ts(51),
      [householdCursorKey(H2, 'households')]: ts(50),
    });
    queries.length = 0;
    await pullNow();
    const gts = queriesFor('lists').map((q) => [q.ops[1][2], q.ops[2]]);
    expect(gts).toEqual([
      [H1, ['gt', 'updated_at', new Date(Date.parse(ts(1)) - PULL_OVERLAP_MS).toISOString()]],
      [H2, ['gt', 'updated_at', new Date(Date.parse(ts(51)) - PULL_OVERLAP_MS).toISOString()]],
    ]);
  });

  test('joining a household pulls that household in full and leaves the others alone', async () => {
    seedPulledList();
    await pullNow();
    const before = getPullState().cursors;
    // H2's rows are older than any cursor H1 has.
    put('households', remoteHousehold(H2, ts(0, 5), 'Cabin'));
    put('lists', remoteList('cabin-list', ts(0, 6), { household_id: H2 }));
    memberships = [H1, H2];
    queries.length = 0;

    await expect(pullNow()).resolves.toMatchObject({ households: [H1, H2], error: null });

    const h2Lists = queriesFor('lists').find((q) => q.ops[1][2] === H2)!;
    expect(h2Lists.ops.some(([op]) => op === 'gt')).toBe(false);
    const h1Lists = queriesFor('lists').find((q) => q.ops[1][2] === H1)!;
    expect(h1Lists.ops.some(([op]) => op === 'gt')).toBe(true);
    expect(db.select({ id: lists.id, householdId: lists.householdId }).from(lists).orderBy(asc(lists.id)).all()).toEqual([
      { id: 'cabin-list', householdId: H2 },
      { id: L, householdId: H1 },
    ]);
    // H1's cursors are untouched; H2 has its own.
    expect(getPullState().cursors).toEqual({
      ...before,
      [householdCursorKey(H2, 'households')]: ts(0, 5),
      [householdCursorKey(H2, 'lists')]: ts(0, 6),
    });
  });

  test("households the user doesn't belong to on the server aren't pulled", async () => {
    memberships = [];
    put('households', remoteHousehold(H1, ts(1)));

    await expect(pullNow()).resolves.toEqual({ pulled: 0, households: [], error: null });

    expect(queriesFor('households')).toEqual([]);
    expect(db.select().from(households).all()).toEqual([]);
  });

  test('another user starts over from zero', async () => {
    seedPulledList();
    await pullNow();
    mockAuth.account = { userId: 'u2' };
    queries.length = 0;

    await pullNow();

    expect(queriesFor('lists')[0].ops.some(([op]) => op === 'gt')).toBe(false);
    expect(getPullState().userId).toBe('u2');
  });
});

describe('paging', () => {
  test('reads past a page, finishing the rows that share its last timestamp', async () => {
    put('households', remoteHousehold(H1, ts(1)));
    const rows: ServerRow[] = [];
    // 498 rows a second apart, then 20 written in one batch (one timestamp across the page end), then 2 more.
    for (let i = 0; i < 498; i++) rows.push(remoteList(`l${String(i).padStart(3, '0')}`, ts(2 + i)));
    for (let i = 0; i < 20; i++) rows.push(remoteList(`m${String(i).padStart(2, '0')}`, ts(600)));
    rows.push(remoteList('n1', ts(700)), remoteList('n2', ts(701)));
    put('lists', ...rows);

    await pullNow();

    expect(db.select().from(lists).all()).toHaveLength(520);
    const page = [['order', 'updated_at', { ascending: true }], ['limit', PULL_PAGE_SIZE]];
    expect(tableQueries('lists')).toEqual([
      [['select', '*'], ['eq', 'household_id', H1], ...page],
      [['select', '*'], ['eq', 'household_id', H1], ['eq', 'updated_at', ts(600)]],
      [['select', '*'], ['eq', 'household_id', H1], ['gt', 'updated_at', ts(600)], ...page],
    ]);
    expect(getPullState().cursors[householdCursorKey(H1, 'lists')]).toBe(ts(701));
  });
});

describe('LWW on pull', () => {
  beforeEach(async () => {
    seedPulledList();
    put('list_items', remoteItem('i1', ts(2)));
    await pullNow();
  });

  test('a newer remote field replaces the local value and its clock', async () => {
    server.list_items = [
      remoteItem('i1', ts(10), {
        checked_at: ts(9),
        checked_by: 'u2',
        field_clock: { ...ITEM_CLOCK, checked_at: NEW, checked_by: NEW },
      }),
    ];

    await pullNow();

    expect(itemRow('i1')).toMatchObject({
      checkedAt: new Date(ts(9)),
      checkedBy: 'u2',
      updatedAt: new Date(ts(10)),
    });
    expect(itemRow('i1')!.fieldClock).toMatchObject({ checked_at: NEW, checked_by: NEW, note: OLD });
  });

  test('a local unpushed edit beats an older remote one, while newer remote fields still apply', async () => {
    updateRows(db, listItems, eq(listItems.id, 'i1'), { note: 'the oat one' });
    const localClock = itemRow('i1')!.fieldClock.note;
    // Another device checked it (newer than anything local) and edited the note before this device did.
    server.list_items = [
      remoteItem('i1', ts(10), {
        note: 'semi-skimmed',
        checked_at: ts(9),
        field_clock: { ...ITEM_CLOCK, note: '1500000000000-0000-remote', checked_at: NEW },
      }),
    ];

    await pullNow();

    expect(itemRow('i1')).toMatchObject({ note: 'the oat one', checkedAt: new Date(ts(9)) });
    expect(itemRow('i1')!.fieldClock).toMatchObject({ note: localClock, checked_at: NEW });
    // The edit is still waiting to go up.
    expect(outboxRows().map((r) => r.mutation.fields)).toEqual([{ note: 'the oat one' }]);
  });

  test('a remote field older than the local clock is ignored even once pushed', async () => {
    updateRows(db, listItems, eq(listItems.id, 'i1'), { displayName: 'oat milk' });
    clearOutbox();
    server.list_items = [remoteItem('i1', ts(10), { display_name: 'whole milk' })];

    await pullNow();

    expect(itemRow('i1')!.displayName).toBe('oat milk');
  });

  test('a remote delete wins over the local row', async () => {
    server.list_items = [
      remoteItem('i1', ts(10), {
        deleted_at: ts(9),
        field_clock: { ...ITEM_CLOCK, deleted_at: NEW },
      }),
    ];

    await pullNow();

    expect(itemRow('i1')!.deletedAt).toEqual(new Date(ts(9)));
  });

  test('a row the server merged (7.3) is dropped locally and its contributions follow', async () => {
    // This device checked i1, then added milk again (i2). Meanwhile another device unchecked i1,
    // so the server merged i2 into it when i2 was pushed.
    updateRows(db, listItems, eq(listItems.id, 'i1'), { checkedAt: new Date(ts(5)) });
    insertRow(db, listItems, { id: 'i2', listId: L, householdId: H1, ingredientName: 'milk', displayName: 'milk' });
    const hlc = itemRow('i2')!.fieldClock.deleted_at;
    insertRow(db, listItemContributions, { id: 'c2', listItemId: 'i2', householdId: H1 });
    const contributionClock = db.select().from(listItemContributions).get()!.fieldClock.list_item_id;
    clearOutbox();
    server.list_items = [
      remoteItem('i1', ts(10), { field_clock: { ...ITEM_CLOCK, checked_at: NEW } }),
      remoteItem('i2', ts(10), { deleted_at: ts(10), merged_into: 'i1', field_clock: { deleted_at: hlc } }),
    ];
    server.list_item_contributions = [
      { ...remoteContribution('c2', 'i1', ts(10)), field_clock: { list_item_id: contributionClock } },
    ];

    await pullNow();

    expect(itemRow('i2')!.deletedAt).toEqual(new Date(ts(10)));
    expect(itemRow('i1')!.checkedAt).toBeNull();
    expect(contributionsOf('i1')).toEqual(['c2']);
  });

  test('later local writes get a newer HLC than anything pulled', async () => {
    server.list_items = [remoteItem('i1', ts(10), { note: 'x', field_clock: { note: NEW } })];

    await pullNow();

    expect(nextHlc(db) > NEW).toBe(true);
    expect(nextHlc(db).endsWith(getDeviceId())).toBe(true);
  });
});

describe("a household's Combine English and Spanish names (4.15)", () => {
  const combineOf = (id: string) => db.select({ on: households.combineLanguages }).from(households).where(eq(households.id, id)).get()?.on;

  test('comes down with the household, and follows later changes both ways', async () => {
    memberships = [H1, H2];
    put('households', remoteHousehold(H1, ts(1), 'Home', true), remoteHousehold(H2, ts(1), 'Cabin', false));
    await pullNow();
    expect(combineOf(H1)).toBe(true);
    expect(combineOf(H2)).toBe(false);

    server.households = [remoteHousehold(H1, ts(10), 'Home', false), remoteHousehold(H2, ts(10), 'Cabin', true)];
    await pullNow();
    expect(combineOf(H1)).toBe(false);
    expect(combineOf(H2)).toBe(true);
  });
});

describe('Combine on clash (4.4)', () => {
  beforeEach(async () => {
    seedPulledList();
    await pullNow();
  });

  test("a remote open item takes in this device's unpushed open item for the same ingredient", async () => {
    // Both devices added milk while apart.
    insertRow(db, listItems, { id: 'mine', listId: L, householdId: H1, ingredientName: 'milk', displayName: 'milk' });
    insertRow(db, listItemContributions, { id: 'c-mine', listItemId: 'mine', householdId: H1, quantity: 1, unit: 'gal' });
    const queued = outboxRows();
    put('list_items', remoteItem('theirs', ts(20)));
    put('list_item_contributions', remoteContribution('c-theirs', 'theirs', ts(20), 1));

    await pullNow();

    expect(itemRow('theirs')).toMatchObject({ deletedAt: null, checkedAt: null });
    expect(itemRow('mine')!.deletedAt).toBeInstanceOf(Date);
    expect(contributionsOf('theirs')).toEqual(['c-mine', 'c-theirs']);
    expect(contributionsOf('mine')).toEqual([]);
    // Silent: nothing new goes up. The queued add is merged the same way on the server when pushed.
    expect(outboxRows()).toEqual(queued);
  });

  test('a remote reopen merges the local open item into the reopened one', async () => {
    put('list_items', remoteItem('old', ts(20), { checked_at: ts(19) }));
    await pullNow();
    insertRow(db, listItems, { id: 'mine', listId: L, householdId: H1, ingredientName: 'milk', displayName: 'milk' });
    server.list_items = [remoteItem('old', ts(30), { checked_at: null, field_clock: { checked_at: NEW } })];

    await pullNow();

    expect(itemRow('old')!.checkedAt).toBeNull();
    expect(itemRow('mine')!.deletedAt).toBeInstanceOf(Date);
  });

  test("items for other ingredients or lists, and checked ones, aren't touched", async () => {
    insertRow(db, listItems, { id: 'eggs', listId: L, householdId: H1, ingredientName: 'eggs', displayName: 'eggs' });
    insertRow(db, listItems, {
      id: 'done',
      listId: L,
      householdId: H1,
      ingredientName: 'milk',
      displayName: 'milk',
      checkedAt: new Date(ts(3)),
    });
    put('list_items', remoteItem('theirs', ts(20)));

    await pullNow();

    expect(itemRow('eggs')!.deletedAt).toBeNull();
    expect(itemRow('done')!.deletedAt).toBeNull();
    expect(itemRow('theirs')!.deletedAt).toBeNull();
  });

  describe('across a family (4.15)', () => {
    // `leche` is linked to `milk`; `tomate` and `tomato` are not. The household combines languages.
    beforeEach(async () => {
      server.households = [remoteHousehold(H1, ts(2), 'Home', true)];
      await pullNow();
      db.insert(ingredients)
        .values([
          { normalizedName: 'milk', displayName: 'milk', status: 'categorized' },
          { normalizedName: 'leche', displayName: 'leche', status: 'categorized', sameAs: 'milk', linkedBy: 'seed' },
          { normalizedName: 'tomato', displayName: 'tomato', status: 'categorized' },
          { normalizedName: 'tomate', displayName: 'tomate', status: 'categorized' },
        ])
        .run();
    });
    const mine = (ingredientName: string) =>
      insertRow(db, listItems, { id: 'mine', listId: L, householdId: H1, ingredientName, displayName: ingredientName });

    test("a remote open milk takes in this device's unpushed leche", async () => {
      mine('leche');
      insertRow(db, listItemContributions, { id: 'c-mine', listItemId: 'mine', householdId: H1, quantity: 2 });
      const queued = outboxRows();
      put('list_items', remoteItem('theirs', ts(20)));

      await pullNow();

      expect(itemRow('theirs')).toMatchObject({ deletedAt: null, displayName: 'milk' });
      expect(itemRow('mine')!.deletedAt).toBeInstanceOf(Date);
      expect(contributionsOf('theirs')).toEqual(['c-mine']);
      expect(outboxRows()).toEqual(queued);
    });

    test("a remote open leche takes in this device's unpushed milk", async () => {
      mine('milk');
      put('list_items', remoteItem('theirs', ts(20), { ingredient_name: 'leche', display_name: 'leche' }));

      await pullNow();

      expect(itemRow('theirs')!.deletedAt).toBeNull();
      expect(itemRow('mine')!.deletedAt).toBeInstanceOf(Date);
    });

    test('a leche already pushed stays, as the server keeps both', async () => {
      mine('leche');
      clearOutbox();
      put('list_items', remoteItem('theirs', ts(20)));

      await pullNow();

      expect(itemRow('mine')!.deletedAt).toBeNull();
      expect(itemRow('theirs')!.deletedAt).toBeNull();
    });

    test('an unlinked pair stays two items', async () => {
      mine('tomate');
      put('list_items', remoteItem('theirs', ts(20), { ingredient_name: 'tomato', display_name: 'tomato' }));

      await pullNow();

      expect(itemRow('mine')!.deletedAt).toBeNull();
      expect(itemRow('theirs')!.deletedAt).toBeNull();
    });

    test('a cleared link stops the merge', async () => {
      db.update(ingredients).set({ sameAs: null, linkedBy: null }).where(eq(ingredients.normalizedName, 'leche')).run();
      mine('leche');
      put('list_items', remoteItem('theirs', ts(20)));

      await pullNow();

      expect(itemRow('mine')!.deletedAt).toBeNull();
    });

    describe('with Combine English and Spanish names off', () => {
      beforeEach(async () => {
        server.households = [remoteHousehold(H1, ts(3), 'Home', false)];
        await pullNow();
      });

      test("a remote open milk keeps this device's unpushed leche", async () => {
        mine('leche');
        insertRow(db, listItemContributions, { id: 'c-mine', listItemId: 'mine', householdId: H1, quantity: 2 });
        const queued = outboxRows();
        put('list_items', remoteItem('theirs', ts(20)));

        await pullNow();

        expect(itemRow('theirs')!.deletedAt).toBeNull();
        expect(itemRow('mine')!.deletedAt).toBeNull();
        expect(contributionsOf('mine')).toEqual(['c-mine']);
        expect(outboxRows()).toEqual(queued);
      });

      test("a remote open leche keeps this device's unpushed milk", async () => {
        mine('milk');
        put('list_items', remoteItem('theirs', ts(20), { ingredient_name: 'leche', display_name: 'leche' }));

        await pullNow();

        expect(itemRow('theirs')!.deletedAt).toBeNull();
        expect(itemRow('mine')!.deletedAt).toBeNull();
      });

      test('the same ingredient still merges', async () => {
        mine('leche');
        put('list_items', remoteItem('theirs', ts(20), { ingredient_name: 'leche', display_name: 'leche' }));

        await pullNow();

        expect(itemRow('mine')!.deletedAt).toBeInstanceOf(Date);
      });
    });
  });
});

describe('counters and usage', () => {
  const usage = (count: number, updated: string, lastUsed = ts(5)): ServerRow => ({
    household_id: H1,
    ingredient_name: 'milk',
    display_name: 'milk',
    use_count: count,
    last_used_at: lastUsed,
    hidden_at: null,
    field_clock: { display_name: OLD, last_used_at: OLD, hidden_at: OLD },
    created_at: ts(0),
    updated_at: updated,
  });
  const usageRow = () => db.select().from(ingredientUsage).get();

  beforeEach(async () => {
    seedPulledList();
    await pullNow();
  });

  test("use_count is the server's total plus this device's unpushed deltas", async () => {
    upsertRow(
      db,
      ingredientUsage,
      { householdId: H1, ingredientName: 'milk', displayName: 'milk', lastUsedAt: new Date(ts(6)) },
      { lastUsedAt: new Date(ts(6)) },
      { useCount: 1 },
    );
    put('ingredient_usage', usage(5, ts(20)));

    await pullNow();

    expect(usageRow()!.useCount).toBe(6);
    // Once pushed, the server's total includes it.
    clearOutbox();
    server.ingredient_usage = [usage(6, ts(30))];
    await pullNow();
    expect(usageRow()!.useCount).toBe(6);
  });

  test('a row at 0 reads as absent and is removed locally', async () => {
    put('ingredient_usage', usage(2, ts(20)));
    await pullNow();
    server.ingredient_usage = [usage(0, ts(30))];

    await pullNow();

    expect(usageRow()).toBeUndefined();
  });

  test('unit last_used_at merges as the later of both sides', async () => {
    const unit = (lastUsed: string, updated: string): ServerRow => ({
      household_id: H1,
      ingredient_name: 'milk',
      unit_key: 'gal',
      use_count: 3,
      last_used_at: lastUsed,
      field_clock: {},
      created_at: ts(0),
      updated_at: updated,
    });
    put('ingredient_unit_usage', unit(ts(5), ts(20)));
    await pullNow();
    expect(db.select().from(ingredientUnitUsage).get()).toMatchObject({ useCount: 3, lastUsedAt: new Date(ts(5)) });

    updateRows(db, ingredientUnitUsage, undefined, { lastUsedAt: new Date(ts(40)) });
    server.ingredient_unit_usage = [unit(ts(30), ts(50))];
    await pullNow();

    expect(db.select().from(ingredientUnitUsage).get()!.lastUsedAt).toEqual(new Date(ts(40)));
  });
});

describe('recipe tags (spec 4.14)', () => {
  const TAGS = { meal: ['dinner'], cuisine: ['mexican'], protein: ['beef'], diet: [], method: ['one-pot'] };
  const RECIPE_CLOCK = {
    household_id: OLD,
    name: OLD,
    notes: OLD,
    source_url: OLD,
    tags: OLD,
    tags_edited: OLD,
    total_minutes: OLD,
    deleted_at: OLD,
  };
  const remoteRecipe = (updated: string, extra: Partial<ServerRow> = {}): ServerRow => ({
    id: 'r1',
    household_id: H1,
    name: 'Tacos',
    notes: null,
    source_url: 'https://example.com/tacos',
    tags: TAGS,
    tags_edited: false,
    total_minutes: 45,
    added_by: 'u2',
    deleted_at: null,
    field_clock: RECIPE_CLOCK,
    created_at: ts(0),
    updated_at: updated,
    ...extra,
  });
  const recipeRow = () => db.select().from(recipes).where(eq(recipes.id, 'r1')).get()!;

  beforeEach(async () => {
    seedPulledList();
    put('recipes', remoteRecipe(ts(2)));
    await pullNow();
  });

  test('a pull applies tags, tags_edited, total_minutes and added_by', () => {
    expect(recipeRow()).toMatchObject({
      tags: TAGS,
      tagsEdited: false,
      totalMinutes: 45,
      addedBy: 'u2',
      updatedAt: new Date(ts(2)),
    });
  });

  test('an untagged recipe pulls as null tags, unedited, no time and no added_by', async () => {
    put('recipes', {
      ...remoteRecipe(ts(3), { tags: null, total_minutes: null, added_by: null }),
      id: 'r2',
    });

    await pullNow();

    expect(db.select().from(recipes).where(eq(recipes.id, 'r2')).get()).toMatchObject({
      tags: null,
      tagsEdited: false,
      totalMinutes: null,
      addedBy: null,
    });
  });

  test('a newer remote tags edit replaces the whole value and its clock', async () => {
    const edited = { meal: ['lunch'], cuisine: [], protein: [], diet: ['vegetarian'], method: [] };
    server.recipes = [
      remoteRecipe(ts(10), {
        tags: edited,
        tags_edited: true,
        total_minutes: 20,
        field_clock: { ...RECIPE_CLOCK, tags: NEW, tags_edited: NEW, total_minutes: NEW },
      }),
    ];

    await pullNow();

    expect(recipeRow()).toMatchObject({ tags: edited, tagsEdited: true, totalMinutes: 20, updatedAt: new Date(ts(10)) });
    expect(recipeRow().fieldClock).toMatchObject({ tags: NEW, tags_edited: NEW, total_minutes: NEW, name: OLD });
  });

  test('a local unpushed tags edit beats an older remote one', async () => {
    const mine = { saved: ['want-to-try'], meal: ['snack'], cuisine: [], protein: [], diet: [], method: [] };
    updateRows(db, recipes, eq(recipes.id, 'r1'), { tags: mine, tagsEdited: true });
    server.recipes = [
      remoteRecipe(ts(10), {
        tags: { ...TAGS, meal: ['lunch'] },
        field_clock: { ...RECIPE_CLOCK, tags: '1500000000000-0000-remote' },
      }),
    ];

    await pullNow();

    expect(recipeRow()).toMatchObject({ tags: mine, tagsEdited: true });
    expect(outboxRows().map((r) => r.mutation.fields)).toEqual([{ tags: mine, tags_edited: true }]);
  });

  test('the same tags with their keys in another order (as jsonb returns them) are no change', async () => {
    // Postgres orders jsonb keys by length, then bytes.
    const reordered = { diet: [], meal: ['dinner'], method: ['one-pot'], cuisine: ['mexican'], protein: ['beef'] };
    server.recipes = [remoteRecipe(ts(10), { tags: reordered })];

    await pullNow();

    // Nothing was written, so the row keeps its first pull's updated_at.
    expect(recipeRow().updatedAt).toEqual(new Date(ts(2)));
    expect(recipeRow().tags).toEqual(TAGS);
  });

  test('a different tags value with the same keys is a change', async () => {
    server.recipes = [
      remoteRecipe(ts(10), { tags: { ...TAGS, protein: ['pork'] }, field_clock: { ...RECIPE_CLOCK, tags: NEW } }),
    ];

    await pullNow();

    expect(recipeRow().tags).toEqual({ ...TAGS, protein: ['pork'] });
    expect(recipeRow().updatedAt).toEqual(new Date(ts(10)));
  });

  test('a changed added_by from the server applies (it has no clock)', async () => {
    server.recipes = [remoteRecipe(ts(10), { added_by: null })];

    await pullNow();

    expect(recipeRow().addedBy).toBeNull();
  });
});

describe('recipe steps, servings and photo (spec 5)', () => {
  const STEPS = ['Toast the tortillas.', 'Fill and fold.'];
  const PHOTO = 'https://example.com/tacos.jpg';
  const RECIPE_CLOCK = {
    household_id: OLD,
    name: OLD,
    notes: OLD,
    source_url: OLD,
    tags: OLD,
    tags_edited: OLD,
    total_minutes: OLD,
    steps: OLD,
    servings: OLD,
    image_url: OLD,
    deleted_at: OLD,
  };
  const remoteRecipe = (updated: string, extra: Partial<ServerRow> = {}): ServerRow => ({
    id: 'r1',
    household_id: H1,
    name: 'Tacos',
    notes: null,
    source_url: 'https://example.com/tacos',
    tags: null,
    tags_edited: false,
    total_minutes: null,
    steps: STEPS,
    servings: 4,
    image_url: PHOTO,
    added_by: 'u2',
    deleted_at: null,
    field_clock: RECIPE_CLOCK,
    created_at: ts(0),
    updated_at: updated,
    ...extra,
  });
  const recipeRow = () => db.select().from(recipes).where(eq(recipes.id, 'r1')).get()!;

  beforeEach(async () => {
    seedPulledList();
    put('recipes', remoteRecipe(ts(2)));
    await pullNow();
  });

  test('a pull applies steps, servings and image_url', () => {
    expect(recipeRow()).toMatchObject({ steps: STEPS, servings: 4, imageUrl: PHOTO, updatedAt: new Date(ts(2)) });
  });

  test('a recipe with none of them pulls as nulls', async () => {
    put('recipes', { ...remoteRecipe(ts(3), { steps: null, servings: null, image_url: null }), id: 'r2' });

    await pullNow();

    expect(db.select().from(recipes).where(eq(recipes.id, 'r2')).get()).toMatchObject({
      steps: null,
      servings: null,
      imageUrl: null,
    });
  });

  test('a newer remote edit to each replaces the value and its clock', async () => {
    const steps = ['Warm the tortillas.', 'Fill.', 'Fold.'];
    server.recipes = [
      remoteRecipe(ts(10), {
        steps,
        servings: 8,
        image_url: 'https://example.com/tacos-2.jpg',
        field_clock: { ...RECIPE_CLOCK, steps: NEW, servings: NEW, image_url: NEW },
      }),
    ];

    await pullNow();

    expect(recipeRow()).toMatchObject({ steps, servings: 8, imageUrl: 'https://example.com/tacos-2.jpg' });
    expect(recipeRow().fieldClock).toMatchObject({ steps: NEW, servings: NEW, image_url: NEW, name: OLD });
  });

  test('a remote clear of steps applies', async () => {
    server.recipes = [remoteRecipe(ts(10), { steps: null, field_clock: { ...RECIPE_CLOCK, steps: NEW } })];

    await pullNow();

    expect(recipeRow()).toMatchObject({ steps: null, servings: 4, imageUrl: PHOTO });
  });

  // The remote row also carries the old value of the locally edited field (its clock unchanged).
  const crossEdits = [
    {
      field: 'steps',
      local: { steps: ['Mine.'] },
      pushed: { steps: ['Mine.'] },
      other: 'servings',
      remote: { servings: 2 },
      pulled: { servings: 2 },
    },
    {
      field: 'servings',
      local: { servings: 10 },
      pushed: { servings: 10 },
      other: 'image_url',
      remote: { image_url: null },
      pulled: { imageUrl: null },
    },
    {
      field: 'image_url',
      local: { imageUrl: 'https://example.com/mine.jpg' },
      pushed: { image_url: 'https://example.com/mine.jpg' },
      other: 'steps',
      remote: { steps: ['Theirs.'] },
      pulled: { steps: ['Theirs.'] },
    },
  ];
  test.each(crossEdits)(
    "a newer remote $other edit doesn't overwrite an unpushed local $field edit",
    async ({ field, local, pushed, other, remote, pulled }) => {
      updateRows(db, recipes, eq(recipes.id, 'r1'), local);
      server.recipes = [remoteRecipe(ts(10), { ...remote, field_clock: { ...RECIPE_CLOCK, [other]: NEW } })];

      await pullNow();

      expect(recipeRow()).toMatchObject({ ...local, ...pulled });
      expect(outboxRows().map((r) => r.mutation.fields)).toEqual([pushed]);
      expect(recipeRow().fieldClock[other]).toBe(NEW);
      expect(recipeRow().fieldClock[field]).not.toBe(OLD);
    },
  );

  test('a local unpushed steps edit beats an older remote one', async () => {
    updateRows(db, recipes, eq(recipes.id, 'r1'), { steps: ['Mine.'] });
    server.recipes = [
      remoteRecipe(ts(10), { steps: ['Theirs.'], field_clock: { ...RECIPE_CLOCK, steps: '1500000000000-0000-remote' } }),
    ];

    await pullNow();

    expect(recipeRow().steps).toEqual(['Mine.']);
  });

  test('the same steps again are no change', async () => {
    server.recipes = [remoteRecipe(ts(10), { steps: [...STEPS] })];

    await pullNow();

    expect(recipeRow().updatedAt).toEqual(new Date(ts(2)));
  });

  test('a server without the columns yet leaves them alone', async () => {
    const { steps: _s, servings: _n, image_url: _i, ...older } = remoteRecipe(ts(10), { name: 'Tacos!' });
    server.recipes = [{ ...older, field_clock: { ...RECIPE_CLOCK, name: NEW } }];

    await pullNow();

    expect(recipeRow()).toMatchObject({ name: 'Tacos!', steps: STEPS, servings: 4, imageUrl: PHOTO });
  });
});

describe('recipe step ingredients (spec 4.5, 5)', () => {
  const MATCH = { v: 1, basis: '00abcdef012345', steps: [[{ id: 'i1', quantity: null }], [{ id: 'i2', quantity: 1 }]] };
  const RECIPE_CLOCK = { household_id: OLD, name: OLD, steps: OLD, step_ingredients: OLD, deleted_at: OLD };
  const remoteRecipe = (updated: string, extra: Partial<ServerRow> = {}): ServerRow => ({
    id: 'r1',
    household_id: H1,
    name: 'Tacos',
    notes: null,
    source_url: null,
    tags: null,
    tags_edited: false,
    total_minutes: null,
    steps: ['Toast the tortillas.', 'Fill and fold.'],
    step_ingredients: MATCH,
    servings: null,
    image_url: null,
    added_by: 'u2',
    deleted_at: null,
    field_clock: RECIPE_CLOCK,
    created_at: ts(0),
    updated_at: updated,
    ...extra,
  });
  const recipeRow = () => db.select().from(recipes).where(eq(recipes.id, 'r1')).get()!;

  beforeEach(async () => {
    seedPulledList();
    put('recipes', remoteRecipe(ts(2)));
    await pullNow();
  });

  test('a pull applies the match', () => {
    expect(recipeRow().stepIngredients).toEqual(MATCH);
  });

  test('an unmatched recipe pulls as null', async () => {
    put('recipes', { ...remoteRecipe(ts(3), { step_ingredients: null }), id: 'r2' });

    await pullNow();

    expect(db.select().from(recipes).where(eq(recipes.id, 'r2')).get()!.stepIngredients).toBeNull();
  });

  test('a match this device pushed comes back as the same value, keys reordered by jsonb', async () => {
    const mine = { v: 1 as const, basis: 'mine', steps: [[], [{ id: 'i1', quantity: 0.5 }]] };
    updateRows(db, recipes, eq(recipes.id, 'r1'), { stepIngredients: mine });
    const sent = outboxRows().at(-1)!.mutation;
    expect(sent.fields).toEqual({ step_ingredients: mine });
    clearOutbox();
    const before = recipeRow().updatedAt;
    // Postgres orders jsonb keys by length, then bytes.
    const echoed = { v: 1, steps: [[], [{ id: 'i1', quantity: 0.5 }]], basis: 'mine' };
    server.recipes = [
      remoteRecipe(before.toISOString(), {
        step_ingredients: echoed,
        field_clock: { ...RECIPE_CLOCK, step_ingredients: recipeRow().fieldClock.step_ingredients },
      }),
    ];

    await pullNow();

    expect(recipeRow().stepIngredients).toEqual(mine);
    expect(recipeRow().updatedAt).toEqual(before);
  });

  test('a newer remote match replaces the whole value and its clock', async () => {
    const theirs = { v: 1, basis: 'theirs', steps: [[{ id: 'i2', quantity: null }], []] };
    server.recipes = [remoteRecipe(ts(10), { step_ingredients: theirs, field_clock: { ...RECIPE_CLOCK, step_ingredients: NEW } })];

    await pullNow();

    expect(recipeRow().stepIngredients).toEqual(theirs);
    expect(recipeRow().fieldClock).toMatchObject({ step_ingredients: NEW, steps: OLD });
  });

  test('a local unpushed match beats an older remote one', async () => {
    const mine = { v: 1 as const, basis: 'mine', steps: [[], []] };
    updateRows(db, recipes, eq(recipes.id, 'r1'), { stepIngredients: mine });
    server.recipes = [
      remoteRecipe(ts(10), {
        step_ingredients: { ...MATCH, basis: 'theirs' },
        field_clock: { ...RECIPE_CLOCK, step_ingredients: '1500000000000-0000-remote' },
      }),
    ];

    await pullNow();

    expect(recipeRow().stepIngredients).toEqual(mine);
    expect(outboxRows().map((r) => r.mutation.fields)).toEqual([{ step_ingredients: mine }]);
  });

  test('a server without the column yet leaves the match alone', async () => {
    const { step_ingredients: _m, ...older } = remoteRecipe(ts(10), { name: 'Tacos!' });
    server.recipes = [{ ...older, field_clock: { ...RECIPE_CLOCK, name: NEW } }];

    await pullNow();

    expect(recipeRow()).toMatchObject({ name: 'Tacos!', stepIngredients: MATCH });
  });
});

describe("a recipe's own photo (spec 4.5, 5)", () => {
  const PATH = `${H1}/r1/0190a000-0000-7000-8000-000000000001.jpg`;
  const SITE = 'https://example.com/tacos.jpg';
  const RECIPE_CLOCK = { household_id: OLD, name: OLD, image_url: OLD, photo_path: OLD, deleted_at: OLD };
  const remoteRecipe = (updated: string, extra: Partial<ServerRow> = {}): ServerRow => ({
    id: 'r1',
    household_id: H1,
    name: 'Tacos',
    notes: null,
    source_url: null,
    tags: null,
    tags_edited: false,
    total_minutes: null,
    steps: null,
    step_ingredients: null,
    servings: null,
    image_url: SITE,
    photo_path: PATH,
    added_by: 'u2',
    deleted_at: null,
    field_clock: RECIPE_CLOCK,
    created_at: ts(0),
    updated_at: updated,
    ...extra,
  });
  const recipeRow = () => db.select().from(recipes).where(eq(recipes.id, 'r1')).get()!;

  beforeEach(async () => {
    seedPulledList();
    put('recipes', remoteRecipe(ts(2)));
    await pullNow();
  });

  test('a pull applies the path, next to the site photo', () => {
    expect(recipeRow()).toMatchObject({ photoPath: PATH, imageUrl: SITE });
  });

  test('a newer remote clear wins and leaves image_url alone', async () => {
    server.recipes = [remoteRecipe(ts(10), { photo_path: null, field_clock: { ...RECIPE_CLOCK, photo_path: NEW } })];

    await pullNow();

    expect(recipeRow()).toMatchObject({ photoPath: null, imageUrl: SITE });
    expect(recipeRow().fieldClock).toMatchObject({ photo_path: NEW, image_url: OLD });
  });

  test('a local unpushed photo beats an older remote one, field by field', async () => {
    const mine = `${H1}/r1/0190a000-0000-7000-8000-000000000002.jpg`;
    updateRows(db, recipes, eq(recipes.id, 'r1'), { photoPath: mine });
    server.recipes = [
      remoteRecipe(ts(10), {
        photo_path: null,
        image_url: 'https://example.com/other.jpg',
        field_clock: { ...RECIPE_CLOCK, photo_path: '1500000000000-0000-remote', image_url: NEW },
      }),
    ];

    await pullNow();

    expect(recipeRow()).toMatchObject({ photoPath: mine, imageUrl: 'https://example.com/other.jpg' });
    expect(outboxRows().map((r) => r.mutation.fields)).toEqual([{ photo_path: mine }]);
  });

  test('a server without the column yet leaves the photo alone', async () => {
    const { photo_path: _p, ...older } = remoteRecipe(ts(10), { name: 'Tacos!' });
    server.recipes = [{ ...older, field_clock: { ...RECIPE_CLOCK, name: NEW } }];

    await pullNow();

    expect(recipeRow()).toMatchObject({ name: 'Tacos!', photoPath: PATH });
  });

  describe("a stock photo's credit", () => {
    const CREDIT = {
      provider: 'pexels' as const,
      author: 'Jane Doe',
      authorUrl: 'https://www.pexels.com/@jane',
      pageUrl: 'https://www.pexels.com/photo/tacos-123/',
    };
    const CLOCK = { ...RECIPE_CLOCK, photo_credit: OLD };

    test('a pull applies the credit with its photo, as an object', async () => {
      server.recipes = [remoteRecipe(ts(10), { photo_credit: CREDIT, field_clock: { ...CLOCK, photo_path: NEW, photo_credit: NEW } })];

      await pullNow();

      expect(recipeRow()).toMatchObject({ photoPath: PATH, photoCredit: CREDIT });
      expect(recipeRow().fieldClock).toMatchObject({ photo_path: NEW, photo_credit: NEW });
    });

    test('round trip: a local credit goes out as an object and comes back unchanged', async () => {
      const mine = `${H1}/r1/0190a000-0000-7000-8000-000000000003.jpg`;
      updateRows(db, recipes, eq(recipes.id, 'r1'), { photoPath: mine, photoCredit: CREDIT });
      const [sent] = outboxRows().map((r) => r.mutation);
      expect(sent.fields).toEqual({ photo_path: mine, photo_credit: CREDIT });

      // The server applies it and echoes it back with the mutation's clock.
      clearOutbox();
      const clock = recipeRow().fieldClock;
      server.recipes = [
        remoteRecipe(ts(10), {
          photo_path: mine,
          photo_credit: JSON.parse(JSON.stringify(sent.fields.photo_credit)),
          field_clock: { ...CLOCK, photo_path: clock.photo_path, photo_credit: clock.photo_credit },
        }),
      ];

      await pullNow();

      expect(recipeRow()).toMatchObject({ photoPath: mine, photoCredit: CREDIT });
      expect(outboxRows()).toEqual([]);
    });

    test('a newer remote clear of the photo and its credit wins over an older local credit', async () => {
      server.recipes = [remoteRecipe(ts(10), { photo_credit: CREDIT, field_clock: { ...CLOCK, photo_credit: OLD } })];
      await pullNow();
      server.recipes = [
        remoteRecipe(ts(20), { photo_path: null, photo_credit: null, field_clock: { ...CLOCK, photo_path: NEW, photo_credit: NEW } }),
      ];

      await pullNow();

      expect(recipeRow()).toMatchObject({ photoPath: null, photoCredit: null, imageUrl: SITE });
    });

    test('a server without the column yet leaves the credit alone', async () => {
      updateRows(db, recipes, eq(recipes.id, 'r1'), { photoCredit: CREDIT });
      clearOutbox();
      server.recipes = [remoteRecipe(ts(10), { name: 'Tacos!', field_clock: { ...RECIPE_CLOCK, name: NEW } })];

      await pullNow();

      expect(recipeRow()).toMatchObject({ name: 'Tacos!', photoCredit: CREDIT });
    });
  });
});

describe("the household's aisles (spec 4.3.2)", () => {
  const customCategory = (id: string, name: string, updated: string, householdId = H1): ServerRow => ({
    id,
    slug: null,
    name,
    household_id: householdId,
    default_rank: null,
    field_clock: { household_id: OLD, name: OLD },
    created_at: ts(0),
    updated_at: updated,
  });
  /** An override another member (or device) wrote, its category set at `hlc`. */
  const override = (categoryId: string | null, updated: string, hlc = OLD, householdId = H1): ServerRow => ({
    household_id: householdId,
    ingredient_name: 'chips',
    category_id: categoryId,
    field_clock: { category_id: hlc },
    created_at: ts(0),
    updated_at: updated,
  });
  const overrideRow = (householdId = H1) =>
    db.select().from(householdCategoryOverrides).where(eq(householdCategoryOverrides.householdId, householdId)).get();

  beforeEach(() => {
    seedPulledList();
    put('categories', customCategory('cat-snacks', 'Snacks', ts(3)), customCategory('cat-bulk', 'Bulk', ts(4)));
  });

  test("another member's custom aisles and overrides come down with the household, with a cursor each", async () => {
    put('household_category_overrides', override('cat-snacks', ts(5)));
    put('list_items', remoteItem('i1', ts(2), { ingredient_name: 'chips', display_name: 'chips' }));

    await pullNow();

    expect(db.select().from(categories).where(eq(categories.id, 'cat-snacks')).get()).toMatchObject({
      name: 'Snacks',
      householdId: H1,
      slug: null,
      fieldClock: { household_id: OLD, name: OLD },
    });
    expect(overrideRow()).toMatchObject({ householdId: H1, ingredientName: 'chips', categoryId: 'cat-snacks' });
    // So the item shows in that aisle on this user's list.
    expect(listItemsQuery(L).all()[0]).toMatchObject({ ingredientName: 'chips', overrideCategoryId: 'cat-snacks' });
    expect(getPullState().cursors).toMatchObject({
      [householdCursorKey(H1, 'categories')]: ts(4),
      [householdCursorKey(H1, 'household_category_overrides')]: ts(5),
    });
    expect(outboxRows()).toEqual([]);
  });

  test("a user in two households gets each one's own override", async () => {
    memberships = [H1, H2];
    put('households', remoteHousehold(H2, ts(1), 'Cabin'));
    put('categories', customCategory('cat-cabin', 'Farm stand', ts(3), H2));
    put('household_category_overrides', override('cat-snacks', ts(5)), override('cat-cabin', ts(5), OLD, H2));

    await pullNow();

    expect(overrideRow(H1)!.categoryId).toBe('cat-snacks');
    expect(overrideRow(H2)!.categoryId).toBe('cat-cabin');
    expect(db.select().from(categories).where(eq(categories.id, 'cat-cabin')).get()!.householdId).toBe(H2);
  });

  test('a reset comes down as a null category, and the default applies again', async () => {
    put('household_category_overrides', override('cat-snacks', ts(5)));
    await pullNow();
    server.household_category_overrides = [override(null, ts(20), NEW)];

    await pullNow();

    expect(overrideRow()).toMatchObject({ categoryId: null, fieldClock: { category_id: NEW } });
  });

  test('the later of two conflicting overrides wins, whichever arrives last', async () => {
    put('household_category_overrides', override('cat-snacks', ts(5)));
    await pullNow();
    // This device moves chips to Bulk (now) and pushes it.
    setCategoryOverride(H1, 'chips', 'cat-bulk');
    const mine = overrideRow()!.fieldClock.category_id;
    clearOutbox();

    // Another member's earlier change arrives after: it loses.
    server.household_category_overrides = [override('cat-snacks', ts(20), OLD)];
    await pullNow();
    expect(overrideRow()!.categoryId).toBe('cat-bulk');
    expect(overrideRow()!.fieldClock.category_id).toBe(mine);

    // A later one wins.
    server.household_category_overrides = [override('cat-snacks', ts(30), NEW)];
    await pullNow();
    expect(overrideRow()!.categoryId).toBe('cat-snacks');
  });

  test('a renamed custom aisle comes down by field clock too', async () => {
    await pullNow();
    server.categories = [{ ...customCategory('cat-bulk', 'Bulk bins', ts(30)), field_clock: { household_id: OLD, name: NEW } }];

    await pullNow();

    expect(db.select().from(categories).where(eq(categories.id, 'cat-bulk')).get()!.name).toBe('Bulk bins');
  });

  test('system categories come with the catalog', async () => {
    put('categories', {
      id: 'cat-new-system',
      slug: 'frozen-treats',
      name: 'Frozen Treats',
      household_id: null,
      default_rank: 30,
      field_clock: {},
      created_at: ts(0),
      updated_at: ts(8),
    });

    await pullNow();

    expect(db.select().from(categories).where(eq(categories.id, 'cat-new-system')).get()).toMatchObject({
      slug: 'frozen-treats',
      householdId: null,
      defaultRank: 30,
    });
    expect(getPullState().cursors['catalog:categories']).toBe(ts(8));
  });
});

describe("the household's staples (Always have)", () => {
  /** A staple another member (or device) wrote, its deleted_at set at `hlc`. */
  const staple = (deletedAt: string | null, updated: string, hlc = OLD, householdId = H1): ServerRow => ({
    household_id: householdId,
    ingredient_name: 'salt',
    created_by: 'u2',
    deleted_at: deletedAt,
    field_clock: { deleted_at: hlc },
    created_at: ts(0),
    updated_at: updated,
  });
  const stapleRow = (householdId = H1) =>
    db.select().from(householdStaples).where(eq(householdStaples.householdId, householdId)).get();
  /** This device marks (or unmarks) salt, as the staples helpers will. */
  const markHere = (deletedAt: Date | null) =>
    upsertRow(db, householdStaples, { householdId: H1, ingredientName: 'salt', createdBy: 'u1', deletedAt }, { deletedAt });

  beforeEach(() => {
    seedPulledList();
  });

  test("another member's staples come down with the household, after overrides, with their own cursor", async () => {
    memberships = [H1, H2];
    put('households', remoteHousehold(H2, ts(1), 'Cabin'));
    put('household_staples', staple(null, ts(6)), staple(ts(4), ts(7), OLD, H2));

    await pullNow();

    const tables = queries.map((q) => q.table);
    expect(tables.indexOf('household_staples')).toBe(tables.indexOf('household_category_overrides') + 1);
    expect(tableQueries('household_staples').map((ops) => ops[1])).toEqual([
      ['eq', 'household_id', H1],
      ['eq', 'household_id', H2],
    ]);
    expect(stapleRow(H1)).toMatchObject({
      ingredientName: 'salt',
      createdBy: 'u2',
      deletedAt: null,
      createdAt: new Date(ts(0)),
      updatedAt: new Date(ts(6)),
      fieldClock: { deleted_at: OLD },
    });
    expect(stapleRow(H2)!.deletedAt).toEqual(new Date(ts(4)));
    expect(getPullState().cursors).toMatchObject({
      [householdCursorKey(H1, 'household_staples')]: ts(6),
      [householdCursorKey(H2, 'household_staples')]: ts(7),
    });
    expect(outboxRows()).toEqual([]);
  });

  test('a remote unmark beats an older local mark', async () => {
    await pullNow();
    markHere(null);
    clearOutbox(); // pushed
    expect(compareHlc(NEW, stapleRow()!.fieldClock.deleted_at)).toBeGreaterThan(0);
    put('household_staples', staple(ts(10), ts(10), NEW));

    await pullNow();

    expect(stapleRow()).toMatchObject({ deletedAt: new Date(ts(10)), fieldClock: { deleted_at: NEW } });
  });

  test("an unpushed local mark isn't overwritten by an older remote unmark", async () => {
    put('household_staples', staple(null, ts(5)));
    await pullNow();
    markHere(new Date(ts(8)));
    markHere(null); // marked again here, not pushed yet
    const mine = stapleRow()!.fieldClock.deleted_at;
    server.household_staples = [staple(ts(9), ts(20), OLD)];

    await pullNow();

    expect(stapleRow()).toMatchObject({ deletedAt: null, fieldClock: { deleted_at: mine } });
    expect(outboxRows()).toHaveLength(2);
  });

  test('a mark, unmark and mark again from the server ends marked', async () => {
    put('household_staples', staple(null, ts(5), OLD));
    await pullNow();
    server.household_staples = [staple(ts(6), ts(6), '5000000000000-0000-remote')];
    await pullNow();
    expect(stapleRow()!.deletedAt).toEqual(new Date(ts(6)));

    server.household_staples = [staple(null, ts(7), NEW)];
    await pullNow();

    expect(stapleRow()).toMatchObject({ deletedAt: null, fieldClock: { deleted_at: NEW } });
  });
});

describe("the household's meal plan", () => {
  const ENTRY_CLOCK = {
    household_id: OLD,
    plan_date: OLD,
    meal: OLD,
    position: OLD,
    kind: OLD,
    recipe_id: OLD,
    note: OLD,
    deleted_at: OLD,
    created_at: OLD,
  };
  const remoteEntry = (id: string, updated: string, extra: Partial<ServerRow> = {}): ServerRow => ({
    id,
    household_id: H1,
    plan_date: '2026-10-15',
    meal: 'dinner',
    position: 0,
    kind: 'recipe',
    recipe_id: 'r1',
    note: null,
    added_by: 'u2',
    deleted_at: null,
    field_clock: ENTRY_CLOCK,
    created_at: ts(0),
    updated_at: updated,
    ...extra,
  });
  const entryRow = (id: string) => db.select().from(mealPlanEntries).where(eq(mealPlanEntries.id, id)).get();

  beforeEach(() => {
    seedPulledList();
    put('recipes', {
      id: 'r1',
      household_id: H1,
      name: 'Tacos',
      deleted_at: null,
      field_clock: {},
      created_at: ts(0),
      updated_at: ts(1),
    });
  });

  test("another member's entries come down after their recipes, with their own cursor", async () => {
    put('meal_plan_entries', remoteEntry('e1', ts(4)), remoteEntry('e2', ts(5), { kind: 'note', recipe_id: null, note: 'Pizza night', meal: 'lunch' }));

    await pullNow();

    const tables = queries.map((q) => q.table);
    expect(tables.indexOf('meal_plan_entries')).toBeGreaterThan(tables.indexOf('recipes'));
    expect(tableQueries('meal_plan_entries')[0][1]).toEqual(['eq', 'household_id', H1]);
    expect(entryRow('e1')).toMatchObject({
      householdId: H1,
      planDate: '2026-10-15',
      meal: 'dinner',
      position: 0,
      kind: 'recipe',
      recipeId: 'r1',
      note: null,
      addedBy: 'u2',
      deletedAt: null,
      createdAt: new Date(ts(0)),
      updatedAt: new Date(ts(4)),
      fieldClock: ENTRY_CLOCK,
    });
    expect(entryRow('e2')).toMatchObject({ kind: 'note', recipeId: null, note: 'Pizza night', meal: 'lunch' });
    expect(getPullState().cursors[householdCursorKey(H1, 'meal_plan_entries')]).toBe(ts(5));
    expect(outboxRows()).toEqual([]);
  });

  test('a remote clear (deleted_at) comes down; an unpushed local edit keeps its field', async () => {
    put('meal_plan_entries', remoteEntry('e1', ts(4)));
    await pullNow();
    updateRows(db, mealPlanEntries, eq(mealPlanEntries.id, 'e1'), { position: 2 });
    server.meal_plan_entries = [
      remoteEntry('e1', ts(10), { position: 1, deleted_at: ts(9), field_clock: { ...ENTRY_CLOCK, position: OLD, deleted_at: NEW } }),
    ];

    await pullNow();

    expect(entryRow('e1')).toMatchObject({ position: 2, deletedAt: new Date(ts(9)) });
  });
});

describe("the user's own preferences", () => {
  beforeEach(() => {
    seedPulledList();
    db.insert(categories).values({ id: 'cat-dairy', slug: 'dairy', name: 'Dairy', defaultRank: 1 }).run();
  });

  test('aisle order and settings come down, with a cursor each', async () => {
    put('user_category_order', { user_id: 'u1', category_id: 'cat-dairy', position: 3, created_at: ts(0), updated_at: ts(5) });
    put('user_settings', { user_id: 'u1', default_list_id: L, created_at: ts(0), updated_at: ts(6) });

    await pullNow();

    expect(db.select().from(userCategoryOrder).get()).toMatchObject({ userId: 'u1', categoryId: 'cat-dairy', position: 3 });
    expect(db.select().from(userSettings).get()).toMatchObject({ userId: 'u1', defaultListId: L });
    expect(getPullState().cursors).toMatchObject({
      'user:user_category_order': ts(5),
      'user:user_settings': ts(6),
    });
    expect(outboxRows()).toEqual([]);
  });

  test("an unpushed local change wins over the server's row; a pushed one doesn't", async () => {
    const order = (position: number, updated: string): ServerRow => ({
      user_id: 'u1',
      category_id: 'cat-dairy',
      position,
      created_at: ts(0),
      updated_at: updated,
    });
    put('user_category_order', order(3, ts(5)));
    await pullNow();
    upsertRow(db, userCategoryOrder, { userId: 'u1', categoryId: 'cat-dairy', position: 7 }, { position: 7 });
    server.user_category_order = [order(4, ts(20))];

    await pullNow();
    expect(db.select().from(userCategoryOrder).get()!.position).toBe(7);

    clearOutbox();
    server.user_category_order = [order(4, ts(30))];
    await pullNow();
    expect(db.select().from(userCategoryOrder).get()!.position).toBe(4);
  });

  test("a row removed here but not yet pushed isn't brought back", async () => {
    const order: ServerRow = { user_id: 'u1', category_id: 'cat-dairy', position: 3, created_at: ts(0), updated_at: ts(5) };
    put('user_category_order', order);
    await pullNow();
    deleteRows(db, userCategoryOrder, undefined);
    server.user_category_order = [{ ...order, updated_at: ts(20) }];

    await pullNow();

    expect(db.select().from(userCategoryOrder).get()).toBeUndefined();
  });

  test("a default list this device doesn't have is left out", async () => {
    put('user_settings', { user_id: 'u1', default_list_id: 'elsewhere', created_at: ts(0), updated_at: ts(6) });

    await pullNow();

    expect(db.select().from(userSettings).get()).toMatchObject({ userId: 'u1', defaultListId: null });
  });
});

describe('ingredient catalog', () => {
  const ingredient = (name: string, updated: string, extra: Partial<ServerRow> = {}): ServerRow => ({
    normalized_name: name,
    display_name: name,
    default_category_id: 'cat-dairy',
    status: 'categorized',
    is_grocery_item: true,
    categorized_by: 'model',
    default_unit: 'qt',
    attempts: 1,
    household_count: 2,
    created_at: ts(0),
    updated_at: updated,
    ...extra,
  });

  beforeEach(() => {
    db.insert(categories).values({ id: 'cat-dairy', slug: 'dairy', name: 'Dairy', defaultRank: 1 }).run();
    db.insert(ingredients).values({ normalizedName: 'kefir', displayName: 'kefir', status: 'pending' }).run();
    db.insert(ingredients)
      .values({ normalizedName: 'milk', displayName: 'milk', status: 'categorized', defaultCategoryId: 'cat-dairy', categorizedBy: 'seed' })
      .run();
  });

  test('updates names this device has, ignores the rest, and keeps its own cursor', async () => {
    put('ingredients', ingredient('kefir', ts(7)), ingredient('natto', ts(8)));

    await pullNow();

    expect(db.select().from(ingredients).where(eq(ingredients.normalizedName, 'kefir')).get()).toEqual({
      normalizedName: 'kefir',
      displayName: 'kefir',
      defaultCategoryId: 'cat-dairy',
      status: 'categorized',
      isGroceryItem: true,
      categorizedBy: 'model',
      defaultUnit: 'qt',
      lang: null,
      sameAs: null,
      linkedBy: null,
    });
    expect(db.select().from(ingredients).where(eq(ingredients.normalizedName, 'natto')).get()).toBeUndefined();
    expect(getPullState().cursors['catalog:ingredients']).toBe(ts(8));
  });

  const linkOf = (name: string) =>
    db
      .select({ lang: ingredients.lang, sameAs: ingredients.sameAs, linkedBy: ingredients.linkedBy })
      .from(ingredients)
      .where(eq(ingredients.normalizedName, name))
      .get();

  test('copies the language and link (spec 4.15)', async () => {
    db.insert(ingredients).values({ normalizedName: 'leche', displayName: 'leche', status: 'pending' }).run();
    put(
      'ingredients',
      ingredient('leche', ts(7), { lang: 'es', same_as: 'milk', linked_by: 'gemini-test' }),
      ingredient('milk', ts(8), { lang: 'en', same_as: null, linked_by: null, categorized_by: 'seed' }),
    );

    await pullNow();

    expect(linkOf('leche')).toEqual({ lang: 'es', sameAs: 'milk', linkedBy: 'gemini-test' });
    expect(linkOf('milk')).toEqual({ lang: 'en', sameAs: null, linkedBy: null });
  });

  test('a cleared link clears it here too', async () => {
    db.insert(ingredients)
      .values({ normalizedName: 'leche', displayName: 'leche', status: 'categorized', lang: 'es', sameAs: 'milk', linkedBy: 'gemini-test' })
      .run();
    put('ingredients', ingredient('leche', ts(7), { lang: 'es', same_as: null, linked_by: null }));

    await pullNow();

    expect(linkOf('leche')).toEqual({ lang: 'es', sameAs: null, linkedBy: null });
  });

  test("a server without the link columns yet leaves the device's alone", async () => {
    db.insert(ingredients)
      .values({ normalizedName: 'leche', displayName: 'leche', status: 'categorized', lang: 'es', sameAs: 'milk', linkedBy: 'seed' })
      .run();
    put('ingredients', ingredient('leche', ts(7), { default_unit: 'gal' }));

    await pullNow();

    expect(linkOf('leche')).toEqual({ lang: 'es', sameAs: 'milk', linkedBy: 'seed' });
    expect(db.select().from(ingredients).where(eq(ingredients.normalizedName, 'leche')).get()?.defaultUnit).toBe('gal');
  });

  test("a pending server row doesn't undo a categorized one", async () => {
    put('ingredients', ingredient('milk', ts(7), { status: 'pending', default_category_id: null, categorized_by: null }));

    await pullNow();

    expect(db.select().from(ingredients).where(eq(ingredients.normalizedName, 'milk')).get()).toMatchObject({
      status: 'categorized',
      categorizedBy: 'seed',
    });
  });
});

describe('failures', () => {
  test("a row whose parent isn't here yet stops its table and is retried next time", async () => {
    seedPulledList();
    put('list_item_contributions', remoteContribution('c0', 'i0', ts(2)));
    put('list_items', remoteItem('i0', ts(2)));
    // The item arrived after the item table was read (the server has it at a later time).
    server.list_items = [];
    put('list_item_contributions', remoteContribution('c1', 'missing', ts(3)), remoteContribution('c2', 'i0', ts(4)));
    server.list_item_contributions = server.list_item_contributions.filter((c) => c.id !== 'c0');

    await expect(pullNow()).resolves.toMatchObject({ error: null });

    expect(db.select().from(listItemContributions).all()).toEqual([]);
    expect(getPullState().cursors[householdCursorKey(H1, 'list_item_contributions')]).toBeUndefined();

    put('list_items', remoteItem('missing', ts(10)), remoteItem('i0', ts(10), { ingredient_name: 'eggs' }));
    await pullNow();

    expect(db.select({ id: listItemContributions.id }).from(listItemContributions).orderBy(asc(listItemContributions.id)).all()).toEqual([
      { id: 'c1' },
      { id: 'c2' },
    ]);
    expect(getPullState().cursors[householdCursorKey(H1, 'list_item_contributions')]).toBe(ts(4));
  });

  test('a stop keeps the cursor before the failing row, and after rows already in', async () => {
    seedPulledList();
    put('list_items', remoteItem('i0', ts(2)));
    put('list_item_contributions', remoteContribution('c1', 'i0', ts(3)), remoteContribution('c2', 'missing', ts(4)));

    await pullNow();

    expect(contributionsOf('i0')).toEqual(['c1']);
    expect(getPullState().cursors[householdCursorKey(H1, 'list_item_contributions')]).toBe(ts(3));
  });

  test('a network failure stops the run, records the error and keeps the cursors already saved', async () => {
    seedPulledList();
    failTable = 'list_items';

    await expect(pullNow()).resolves.toEqual({
      pulled: 2,
      households: [H1],
      error: 'list_items: Network request failed',
    });

    expect(getPullState().lastError).toBe('list_items: Network request failed');
    expect(getPullState().cursors).toEqual({
      [householdCursorKey(H1, 'households')]: ts(1),
      [householdCursorKey(H1, 'lists')]: ts(1),
    });

    failTable = null;
    await pullNow({ now: () => new Date(ts(99)) });
    expect(getPullState()).toMatchObject({ lastError: null, lastSuccessAt: new Date(ts(99)).toISOString() });
  });

  test('signed out, nothing is asked of the server', async () => {
    mockAuth.account = null;

    await expect(pullNow()).resolves.toEqual({ skipped: 'no-session' });

    expect(queries).toEqual([]);
    expect(db.select().from(deviceSettings).all()).toEqual([]);
  });

  test('a pull requested during a run runs once more', async () => {
    seedPulledList();
    const first = pullNow();
    const second = pullNow();
    put('lists', remoteList('list-2', ts(30)));

    await Promise.all([first, second]);

    expect(queriesFor('household_members')).toHaveLength(2);
    expect(db.select().from(lists).all()).toHaveLength(2);
  });
});

describe('lost memberships (4.7)', () => {
  const CABIN_LIST = 'cabin-list';

  /** H1 and H2 pulled once, with an item in each and an unpushed rename of H2's list. */
  async function seedTwoHouseholds() {
    memberships = [H1, H2];
    seedPulledList();
    put('list_items', remoteItem('i1', ts(2)));
    put('households', remoteHousehold(H2, ts(3), 'Cabin'));
    put('lists', remoteList(CABIN_LIST, ts(3), { household_id: H2 }));
    put('list_items', remoteItem('cabin-item', ts(4), { list_id: CABIN_LIST, household_id: H2 }));
    await pullNow();
    updateRows(db, lists, eq(lists.id, CABIN_LIST), { name: 'Cabin, renamed' });
    updateRows(db, lists, eq(lists.id, L), { name: 'Home, renamed' });
  }

  /** H2 is gone from the server, as after leaving, removal or deletion. */
  const loseCabin = () => {
    memberships = [H1];
    for (const table of Object.keys(server)) server[table] = server[table].filter((r) => r.household_id !== H2 && r.id !== H2);
  };

  const localHouseholds = () =>
    db
      .select({ id: households.id })
      .from(households)
      .orderBy(asc(households.id))
      .all()
      .map((h) => h.id);

  test('a household the server no longer lists is purged with its queued mutations and cursors', async () => {
    await seedTwoHouseholds();
    expect(getPullState().memberships).toEqual([H1, H2]);
    expect(outboxRows().map((r) => r.householdId)).toEqual([H2, H1]);
    const h1Cursors = Object.fromEntries(
      Object.entries(getPullState().cursors).filter(([key]) => key.startsWith(`household:${H1}:`)),
    );
    loseCabin();

    await expect(pullNow()).resolves.toMatchObject({ households: [H1], error: null });

    expect(localHouseholds()).toEqual([H1]);
    expect(db.select({ id: lists.id, name: lists.name }).from(lists).all()).toEqual([{ id: L, name: 'Home, renamed' }]);
    expect(db.select({ id: listItems.id }).from(listItems).all()).toEqual([{ id: 'i1' }]);
    // H1's unpushed rename stays queued; H2's is dropped.
    expect(outboxRows().map((r) => [r.householdId, r.mutation.fields])).toEqual([[H1, { name: 'Home, renamed' }]]);
    expect(getPullState().cursors).toEqual({ ...h1Cursors, ...pick(getPullState().cursors, 'user:', 'catalog:') });
    expect(Object.keys(getPullState().cursors).some((key) => key.startsWith(`household:${H2}:`))).toBe(false);
    expect(getPullState().memberships).toEqual([H1]);
  });

  test("losing a household clears expo-image's photo cache; a pull that loses none doesn't (spec 4.5)", async () => {
    await seedTwoHouseholds();
    mockClearPhotoCache.mockClear();
    await pullNow();
    expect(mockClearPhotoCache).not.toHaveBeenCalled();

    loseCabin();
    await pullNow();
    expect(mockClearPhotoCache).toHaveBeenCalledTimes(1);

    await pullNow();
    expect(mockClearPhotoCache).toHaveBeenCalledTimes(1);
  });

  test('joining it again pulls it in full', async () => {
    await seedTwoHouseholds();
    const before = structuredClone(server);
    loseCabin();
    await pullNow();
    expect(localHouseholds()).toEqual([H1]);
    server = before;
    memberships = [H1, H2];
    queries.length = 0;

    await pullNow();

    const h2Lists = queriesFor('lists').find((q) => q.ops[1][2] === H2)!;
    expect(h2Lists.ops.some(([op]) => op === 'gt')).toBe(false);
    expect(localHouseholds()).toEqual([H1, H2]);
    expect(db.select({ id: lists.id }).from(lists).orderBy(asc(lists.id)).all()).toEqual([{ id: CABIN_LIST }, { id: L }]);
    expect(itemRow('cabin-item')).toMatchObject({ listId: CABIN_LIST, householdId: H2 });
    expect(getPullState().memberships).toEqual([H1, H2]);
  });

  test("a household the server has never listed (created here, not pushed yet) isn't purged", async () => {
    seedPulledList();
    await pullNow();
    db.transaction((tx) => {
      insertRow(tx, households, { id: 'local-only', name: 'New' });
      insertRow(tx, lists, { id: 'local-list', householdId: 'local-only', name: 'New list', position: 2 });
    });
    const queued = outboxRows();

    await pullNow();
    await pullNow();

    expect(localHouseholds()).toEqual([H1, 'local-only']);
    expect(outboxRows()).toEqual(queued);
    expect(getPullState().memberships).toEqual([H1]);
  });

  test('an empty membership list purges nothing and keeps the last list', async () => {
    await seedTwoHouseholds();
    const queued = outboxRows();
    memberships = [];

    await expect(pullNow()).resolves.toMatchObject({ households: [], error: null });

    expect(localHouseholds()).toEqual([H1, H2]);
    expect(outboxRows()).toEqual(queued);
    expect(getPullState().memberships).toEqual([H1, H2]);
  });

  test("a run that fails before the households are in doesn't purge; the next one does", async () => {
    await seedTwoHouseholds();
    loseCabin();
    failTable = 'lists';

    await expect(pullNow()).resolves.toMatchObject({ error: 'lists: Network request failed' });

    expect(localHouseholds()).toEqual([H1, H2]);
    expect(getPullState().memberships).toEqual([H1, H2]);

    failTable = null;
    await pullNow();

    expect(localHouseholds()).toEqual([H1]);
    expect(outboxRows().filter((r) => r.householdId === H2)).toEqual([]);
  });

  test("a scoped pull doesn't read memberships, so it never purges", async () => {
    await seedTwoHouseholds();
    loseCabin();

    await pullNow({ scope: { households: [H1], user: true } });

    expect(localHouseholds()).toEqual([H1, H2]);
    expect(getPullState().memberships).toEqual([H1, H2]);
  });

  test('state saved before memberships were kept only records them; nothing is purged', async () => {
    await seedTwoHouseholds();
    const { memberships: _dropped, ...older } = getPullState();
    db.update(deviceSettings).set({ value: older }).where(eq(deviceSettings.key, 'sync.pull')).run();
    expect(getPullState().memberships).toBeNull();
    loseCabin();

    await pullNow();

    expect(localHouseholds()).toEqual([H1, H2]);
    expect(getPullState().memberships).toEqual([H1]);
  });

  test("another user starts with no memberships, so the last user's households aren't purged", async () => {
    await seedTwoHouseholds();
    mockAuth.account = { userId: 'u2' };
    loseCabin();

    await pullNow();

    expect(localHouseholds()).toEqual([H1, H2]);
    expect(getPullState()).toMatchObject({ userId: 'u2', memberships: [H1] });
  });

  test('a default list in the lost household is cleared', async () => {
    await seedTwoHouseholds();
    db.insert(userSettings).values({ userId: 'u1', defaultListId: CABIN_LIST }).run();
    loseCabin();

    await pullNow();

    expect(db.select().from(userSettings).get()).toMatchObject({ userId: 'u1', defaultListId: null });
  });

  describe('leaving your only household (the server makes a new one)', () => {
    const NEW_H = 'household-new';
    const NEW_L = 'groceries-new';

    /** H1 pulled with a default list; then `leave_household` on the server: H1 gone, a new Personal with Groceries. */
    async function leaveOnlyHousehold() {
      seedPulledList();
      put('user_settings', { user_id: 'u1', default_list_id: L, created_at: ts(0), updated_at: ts(1) });
      await pullNow();
      expect(localHouseholds()).toEqual([H1]);
      memberships = [NEW_H];
      server.households = [remoteHousehold(NEW_H, ts(20), 'Personal')];
      server.lists = [remoteList(NEW_L, ts(20), { household_id: NEW_H, name: 'Groceries' })];
      server.user_settings = [{ user_id: 'u1', default_list_id: NEW_L, created_at: ts(0), updated_at: ts(20) }];
    }

    test('one pull swaps them: the device ends with exactly one household, the new one, and its default list', async () => {
      await leaveOnlyHousehold();

      await expect(pullNow()).resolves.toMatchObject({ households: [NEW_H], error: null });

      expect(localHouseholds()).toEqual([NEW_H]);
      expect(db.select({ id: lists.id, name: lists.name }).from(lists).all()).toEqual([{ id: NEW_L, name: 'Groceries' }]);
      expect(db.select().from(userSettings).get()).toMatchObject({ userId: 'u1', defaultListId: NEW_L });
      // The launch-time starter step then has nothing to do.
      ensureStarterData('u1');
      expect(localHouseholds()).toEqual([NEW_H]);
      expect(outboxRows()).toEqual([]);
    });

    test("a pull that fails after the new household lands keeps the old one too, so there's never none", async () => {
      await leaveOnlyHousehold();
      failTable = 'recipes';

      await expect(pullNow()).resolves.toMatchObject({ error: 'recipes: Network request failed' });

      expect(localHouseholds()).toEqual([NEW_H, H1].sort());
      // An offline launch now makes no second household.
      ensureStarterData('u1');
      expect(localHouseholds()).toEqual([NEW_H, H1].sort());
      expect(outboxRows()).toEqual([]);

      failTable = null;
      await pullNow();
      expect(localHouseholds()).toEqual([NEW_H]);
    });

    test('a pull that fails before the new household lands keeps the old one, so the device still has one', async () => {
      await leaveOnlyHousehold();
      failTable = 'households';

      await pullNow();

      expect(localHouseholds()).toEqual([H1]);
      ensureStarterData('u1');
      expect(localHouseholds()).toEqual([H1]);

      failTable = null;
      await pullNow();
      expect(localHouseholds()).toEqual([NEW_H]);
    });
  });
});

/** The cursors whose keys start with any of `prefixes`. */
function pick(cursors: Record<string, string>, ...prefixes: string[]) {
  return Object.fromEntries(Object.entries(cursors).filter(([key]) => prefixes.some((p) => key.startsWith(p))));
}

describe('scoped pulls (for Realtime)', () => {
  const HOUSEHOLD_TABLES = [
    'households',
    'categories',
    'household_category_overrides',
    'household_staples',
    'lists',
    'recipes',
    'list_items',
    'recipe_ingredients',
    'list_item_contributions',
    'meal_plan_entries',
    'ingredient_usage',
    'ingredient_unit_usage',
  ];

  test('mergeScopes unions households and flags; a full pull covers everything', () => {
    expect(mergeScopes(null, { households: [H1] })).toEqual({ households: [H1] });
    expect(mergeScopes({ households: [H1] }, { households: [H2, H1], catalog: true })).toEqual({
      households: [H1, H2],
      user: false,
      catalog: true,
    });
    expect(mergeScopes({ user: true }, { catalog: true })).toEqual({ households: [], user: true, catalog: true });
    expect(mergeScopes({ households: [H1] }, 'all')).toBe('all');
    expect(mergeScopes('all', { catalog: true })).toBe('all');
    expect(mergeScopes(null, 'all')).toBe('all');
  });

  test("one household's tables only: no membership lookup, no other household, no preferences or catalog", async () => {
    memberships = [H1, H2];
    put('households', remoteHousehold(H2, ts(1)));
    put('lists', remoteList('list-h2', ts(2), { household_id: H2 }));

    await expect(pullNow({ scope: { households: [H2] } })).resolves.toEqual({ pulled: 2, households: [H2], error: null });

    expect(queries.map((q) => q.table)).toEqual(HOUSEHOLD_TABLES);
    expect(queries.every((q) => q.ops.some(([op, , value]) => op === 'eq' && value === H2))).toBe(true);
    expect(db.select({ id: lists.id }).from(lists).all()).toEqual([{ id: 'list-h2' }]);
    expect(Object.keys(getPullState().cursors).sort()).toEqual([
      householdCursorKey(H2, 'households'),
      householdCursorKey(H2, 'lists'),
    ]);
  });

  test("the user's tables only", async () => {
    await pullNow({ scope: { user: true } });
    expect(queries.map((q) => q.table)).toEqual(['user_category_order', 'user_settings']);
  });

  test('the catalog only', async () => {
    db.insert(ingredients).values({ normalizedName: 'kefir', displayName: 'kefir', status: 'pending' }).run();
    put('ingredients', {
      normalized_name: 'kefir',
      default_category_id: null,
      status: 'categorized',
      is_grocery_item: true,
      categorized_by: 'model',
      updated_at: ts(5),
    });

    await expect(pullNow({ scope: { catalog: true } })).resolves.toEqual({ pulled: 1, households: [], error: null });

    expect(queries.map((q) => q.table)).toEqual(['categories', 'ingredients']);
    expect(db.select().from(ingredients).where(eq(ingredients.normalizedName, 'kefir')).get()).toMatchObject({
      status: 'categorized',
      categorizedBy: 'model',
    });
  });

  test('an empty scope asks the server for nothing but still counts as a sync', async () => {
    await expect(pullNow({ scope: {}, now: () => new Date(ts(9)) })).resolves.toEqual({ pulled: 0, households: [], error: null });
    expect(queries).toEqual([]);
    expect(getPullState().lastSuccessAt).toBe(new Date(ts(9)).toISOString());
  });

  test('scoped calls during a run share one more run that covers all of them', async () => {
    memberships = [H1, H2];
    const first = pullNow({ scope: { households: [H1] } });
    const second = pullNow({ scope: { households: [H2] } });
    const third = pullNow({ scope: { catalog: true } });

    await Promise.all([first, second, third]);

    expect(queries.map((q) => q.table)).toEqual([...HOUSEHOLD_TABLES, ...HOUSEHOLD_TABLES, 'categories', 'ingredients']);
    expect(tableQueries('lists').map((ops) => ops[1])).toEqual([
      ['eq', 'household_id', H1],
      ['eq', 'household_id', H2],
    ]);
  });

  test('a full pull asked for during a scoped run makes the next run full', async () => {
    const first = pullNow({ scope: { catalog: true } });
    const second = pullNow();

    await Promise.all([first, second]);

    expect(queries.slice(0, 2).map((q) => q.table)).toEqual(['categories', 'ingredients']);
    expect(queriesFor('household_members')).toHaveLength(1);
    expect(queriesFor('ingredients')).toHaveLength(2);
  });
});

describe('onMemberships', () => {
  test('hears the households each full pull reads, and replays the last for the same user', async () => {
    // A user no earlier test has pulled for, so there's nothing to replay yet.
    mockAuth.account = { userId: 'u5' };
    const heard: string[][] = [];
    const stop = onMemberships('u5', (h) => heard.push(h));
    expect(heard).toEqual([]);

    memberships = [H1, H2];
    await pullNow();
    memberships = [H2];
    await pullNow();
    // Scoped pulls don't read memberships.
    await pullNow({ scope: { households: [H1] } });
    expect(heard).toEqual([[H1, H2], [H2]]);

    const late: string[][] = [];
    const stopLate = onMemberships('u5', (h) => late.push(h));
    expect(late).toEqual([[H2]]);
    const other: string[][] = [];
    const stopOther = onMemberships('u6', (h) => other.push(h));
    expect(other).toEqual([]);

    stop();
    stopLate();
    stopOther();
    memberships = [H1];
    await pullNow();
    expect(heard).toHaveLength(2);
    expect(late).toHaveLength(1);
  });

  test('a failed membership lookup reports nothing', async () => {
    const heard: string[][] = [];
    const stop = onMemberships('u3', (h) => heard.push(h));
    mockAuth.account = { userId: 'u3' };
    failTable = 'household_members';

    await expect(pullNow()).resolves.toMatchObject({ error: 'household_members: Network request failed' });

    expect(heard).toEqual([]);
    stop();
  });
});

describe("members' names (spec 4.7)", () => {
  const member = (user_id: string, display_name: string) => ({ user_id, display_name, avatar_url: null, role: 'member', joined_at: ts(0) });
  const cachedNames = () =>
    db
      .select({ householdId: householdMemberNames.householdId, userId: householdMemberNames.userId, name: householdMemberNames.displayName })
      .from(householdMemberNames)
      .orderBy(asc(householdMemberNames.householdId), asc(householdMemberNames.userId))
      .all();
  let serverMembers: Record<string, ReturnType<typeof member>[]>;
  beforeEach(() => {
    serverMembers = { [H1]: [member('u1', 'Jo Doe'), member('u2', 'Alex Rivera')], [H2]: [member('u1', 'Jo Doe'), member('u3', 'Sam Lee')] };
    onRpc((call) =>
      call.fn === 'get_household_members' ? { data: serverMembers[call.args!.p_household_id as string] ?? null } : undefined,
    );
  });

  test('a full pull fills the cache for each household from get_household_members', async () => {
    memberships = [H1, H2];
    put('households', remoteHousehold(H2, ts(1)));
    await pullNow();

    expect(rpcCallsFor('get_household_members').map((c) => c.args)).toEqual([{ p_household_id: H1 }, { p_household_id: H2 }]);
    expect(cachedNames()).toEqual([
      { householdId: H1, userId: 'u1', name: 'Jo Doe' },
      { householdId: H1, userId: 'u2', name: 'Alex Rivera' },
      { householdId: H2, userId: 'u1', name: 'Jo Doe' },
      { householdId: H2, userId: 'u3', name: 'Sam Lee' },
    ]);
  });

  test("the next full pull replaces a household's names", async () => {
    await pullNow();
    serverMembers[H1] = [member('u1', 'Jo Doe'), member('u4', 'Kim Park')];
    await pullNow();
    expect(cachedNames().map((r) => r.userId)).toEqual(['u1', 'u4']);
  });

  test("a scoped pull doesn't load names", async () => {
    await pullNow({ scope: { households: [H1] } });
    expect(rpcCallsFor('get_household_members')).toEqual([]);
    expect(cachedNames()).toEqual([]);
  });

  test("a failed names call keeps the names and doesn't fail the pull", async () => {
    await pullNow();
    onRpc(() => ({ error: { message: 'Failed to fetch' } }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(pullNow()).resolves.toMatchObject({ error: null });

    expect(cachedNames().map((r) => r.userId)).toEqual(['u1', 'u2']);
    warn.mockRestore();
  });

  test('a lost household is purged with its names', async () => {
    memberships = [H1, H2];
    put('households', remoteHousehold(H2, ts(1)));
    await pullNow();
    memberships = [H1];
    server.households = server.households.filter((h) => h.id !== H2);

    await pullNow();

    expect(cachedNames().map((r) => r.householdId)).toEqual([H1, H1]);
  });
});

describe('applyRemoteDelete (per-user rows deleted on another device)', () => {
  const C = 'cat-snacks';

  function seedOrder() {
    db.insert(categories).values({ id: C, slug: 'snacks', name: 'Snacks', defaultRank: 1 }).run();
    db.insert(userCategoryOrder).values({ userId: 'u1', categoryId: C, position: 1 }).run();
  }
  const orderRows = () => db.select().from(userCategoryOrder).all();

  test("deletes the user's order row named by the event's key, without writing to the outbox", () => {
    seedOrder();

    expect(applyRemoteDelete('user_category_order', { user_id: 'u1', category_id: C }, 'u1')).toBe(true);

    expect(orderRows()).toEqual([]);
    expect(outboxRows()).toEqual([]);
  });

  test('keeps a row with an unpushed local change', () => {
    seedOrder();
    upsertRow(db, userCategoryOrder, { userId: 'u1', categoryId: C, position: 2 }, { position: 2 });

    expect(applyRemoteDelete('user_category_order', { user_id: 'u1', category_id: C }, 'u1')).toBe(false);
    expect(orderRows()).toHaveLength(1);

    clearOutbox();
    expect(applyRemoteDelete('user_category_order', { user_id: 'u1', category_id: C }, 'u1')).toBe(true);
    expect(orderRows()).toEqual([]);
  });

  test("ignores another user's row, a missing row, an incomplete key and other tables", () => {
    seedOrder();
    db.insert(households).values({ id: H1, name: 'Home' }).run();
    db.insert(householdCategoryOverrides).values({ householdId: H1, ingredientName: 'chips', categoryId: C }).run();

    expect(applyRemoteDelete('user_category_order', { user_id: 'u2', category_id: C }, 'u1')).toBe(false);
    expect(applyRemoteDelete('user_category_order', { user_id: 'u1', category_id: 'other' }, 'u1')).toBe(false);
    expect(applyRemoteDelete('user_category_order', { user_id: 'u1' }, 'u1')).toBe(false);
    expect(applyRemoteDelete('user_settings', { user_id: 'u1' }, 'u1')).toBe(false);
    expect(applyRemoteDelete('lists', { id: L, user_id: 'u1' }, 'u1')).toBe(false);
    // Overrides are household data: a reset is a null category, never a delete event to apply.
    expect(applyRemoteDelete('household_category_overrides', { household_id: H1, ingredient_name: 'chips', user_id: 'u1' }, 'u1')).toBe(
      false,
    );
    expect(orderRows()).toHaveLength(1);
    expect(db.select().from(householdCategoryOverrides).all()).toHaveLength(1);
  });
});
