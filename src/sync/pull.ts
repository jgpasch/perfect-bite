// Pull: brings rows other devices changed down into SQLite (spec 7.2). Runs on launch, sign-in,
// foreground and reconnect.
//
// - Cursors are per household (spec 7.2), and within a household per table: each is the server
//   `updated_at` of the newest row applied, kept as the server's text so no precision is lost. A
//   household the user just joined has no cursors, so it is pulled in full; the others aren't
//   affected. The user's own preference tables and the ingredient catalog have their own cursors.
// - Each table is read oldest change first, in pages ordered by `updated_at` and then the row's
//   key, and each next page starts after the last row's `(updated_at, key)`. One transaction stamps
//   all its rows with the same `now()` (a catalog seed does that to thousands), so a page can end in
//   the middle of them and the next one goes on from there. The first page reaches
//   `PULL_OVERLAP_MS` behind the cursor, in case a transaction that started earlier committed
//   after the last pull; applying a row twice is a no-op. So the stored cursor is only the time:
//   the key would never be read.
// - Rows are applied with the push's LWW rule (7.3): a remote field wins unless the local
//   `field_clock` has a newer HLC for it, i.e. a local edit the server hasn't seen. Fields the
//   server keeps no clock for (per-user tables, households) win unless an unpushed outbox mutation
//   sets them. Counters are the server's total plus this device's unpushed deltas. "Unpushed" is
//   as of the fetch too: a push that settles while a page is in flight may have reached the server
//   after the page was read.
// - A remote open item that clashes with a different local open item for the same ingredient on
//   the same list Combines silently (4.4): the local one is merged into it, as `apply_mutations`
//   will do when the local one is pushed (7.3). So does an unpushed local add of another name of
//   its family (4.15).
// - A page's local rows are read up front, a chunk of keys per query. Each row of a table with
//   foreign keys is applied in its own savepoint. A row that changes nothing writes nothing.
// - A row SQLite refuses stops its table until the next pull; refused a third time, it's skipped
//   and quarantined (`sync.quarantine`, counted in Sync status) so the rest of its table goes on.
// - Pull writes go straight to SQLite, never to the outbox: they are already on the server.
// - A full pull also notices lost memberships (4.7): a household the server listed for the user
//   last time and doesn't now is purged from this device with its queued mutations (`purge.ts`),
//   once the households still listed are in. So is a household created here that the server
//   refused (its `create_household` was rejected, e.g. `already in a household`) and doesn't list.
//   Other households the server has never listed (e.g. one created here and not pushed yet) are
//   left alone.
// - After a full pull, each household's members' names are cached again (`get_household_members`,
//   `refreshMemberNames`), so the app can say who checked or added something.
import { and, eq, getTableColumns, getTableName, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core';

import {
  categories,
  db,
  deviceSettings,
  householdCategoryOrder,
  householdCategoryOverrides,
  households,
  householdStaples,
  ingredients,
  ingredientUnitUsage,
  ingredientUsage,
  listItemContributions,
  listItems,
  lists,
  mealPlanEntries,
  outbox,
  recipeCollectionRecipes,
  recipeCollections,
  recipeFavorites,
  recipeIngredients,
  recipes,
  userHouseholdCategoryOrder,
  userSettings,
  type FieldClock,
} from '@/db';
import { getAccount } from '@/features/auth/account';
import { ensureMissingIngredients, householdCombinesLanguages, localFamilyKey } from '@/features/categories/categories';
import { startCatchUpTriggers } from '@/features/categories/catch-up';
import { refreshAllMemberNames } from '@/features/households/member-names';
import { clearPhotoCache } from '@/lib/photo-cache';
import { reportError } from '@/lib/sentry';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

import { reportSyncActivity } from './activity';
import { observeHlc, type Exec } from './clock';
import { compareHlc } from './hlc';
import type { Mutation } from './mutation';
import { purgeHousehold } from './purge';

/**
 * Rows per page. PostgREST cuts any answer at `max_rows` (1000, `supabase/config.toml`), so this
 * stays at or below it: a full page means there may be more.
 */
export const PULL_PAGE_SIZE = 500;
/** PostgREST's `max_rows`: an answer this long may have been cut short. */
const POSTGREST_MAX_ROWS = 1000;
/** How far behind its cursor each table's first page reaches. */
export const PULL_OVERLAP_MS = 5000;

type Row = Record<string, unknown>;
/** A row as PostgREST returns it: snake_case columns, timestamps as ISO text. */
export type ServerRow = Row & { updated_at: string };

type PullSpec = {
  table: SQLiteTable;
  /** Key columns (property names). */
  key: readonly string[];
  /** Columns that merge as counters: the server's total plus local unpushed deltas. */
  counters?: readonly string[];
  /** Columns that merge as the later of both sides. */
  latest?: readonly string[];
};

/** Parents before children, for foreign keys: custom categories before the overrides that use them. */
const HOUSEHOLD_SPECS: PullSpec[] = [
  { table: households, key: ['id'] },
  { table: categories, key: ['id'] },
  { table: householdCategoryOverrides, key: ['householdId', 'ingredientName'] },
  { table: householdStaples, key: ['householdId', 'ingredientName'] },
  { table: householdCategoryOrder, key: ['householdId'] },
  { table: lists, key: ['id'] },
  { table: recipes, key: ['id'] },
  { table: recipeFavorites, key: ['recipeId', 'userId'] },
  { table: recipeCollections, key: ['id'] },
  { table: recipeCollectionRecipes, key: ['collectionId', 'recipeId'] },
  { table: listItems, key: ['id'] },
  { table: recipeIngredients, key: ['id'] },
  { table: listItemContributions, key: ['id'] },
  { table: mealPlanEntries, key: ['id'] },
  { table: ingredientUsage, key: ['householdId', 'ingredientName'], counters: ['useCount'] },
  {
    table: ingredientUnitUsage,
    key: ['householdId', 'ingredientName', 'unitKey'],
    counters: ['useCount'],
    latest: ['lastUsedAt'],
  },
];

/** The user's own tables. Their aisle orders belong to households, which the household jobs bring first. */
const USER_SPECS: PullSpec[] = [
  { table: userHouseholdCategoryOrder, key: ['userId', 'householdId'] },
  { table: userSettings, key: ['userId'] },
];

/** System categories: part of the catalog, before the ingredients that point at them. */
const SYSTEM_CATEGORIES_SPEC: PullSpec = { table: categories, key: ['id'] };

/** One table to pull: what to read, which rows, and how to apply them. */
type Job = {
  /** Cursor key, e.g. `household:<id>:lists`, `user:user_settings`, `catalog:ingredients`. */
  cursor: string;
  table: string;
  /** The server's key columns, which order rows that share an `updated_at`. */
  key: readonly string[];
  /** Filters, as [column, value]: equality, or `is null` for a null value. */
  filters: [string, string | null][];
  /**
   * Whether each row is applied in its own savepoint, so a row SQLite refuses leaves nothing of
   * itself behind: for tables with foreign keys, the rows it may refuse.
   */
  savepoint: boolean;
  /** Reads the local copies of a page's rows up front, a chunk of them per query. */
  readLocal: (tx: Exec, rows: ServerRow[]) => LocalRows;
  apply: (tx: Exec, row: ServerRow, pending: PendingIndex, locals: LocalRows) => void;
  /**
   * The only keys (of the job's one key column) worth fetching on a first pull, when there are
   * any; the job reads every row otherwise.
   */
  firstPullKeys?: (exec: Exec) => string[];
};

// --- State ---------------------------------------------------------------------------------

export type PullState = {
  /** The user the cursors belong to; another user starts over. */
  userId: string | null;
  /** By `Job.cursor`: the server `updated_at` of the newest row applied. */
  cursors: Record<string, string>;
  /** The user's households as the last full pull read them; null before the first. */
  memberships: string[] | null;
  lastSuccessAt: string | null;
  lastError: string | null;
};

const STATE_KEY = 'sync.pull';
const INITIAL_STATE: PullState = { userId: null, cursors: {}, memberships: null, lastSuccessAt: null, lastError: null };

function readState(exec: Exec = db): PullState {
  const row = exec.select().from(deviceSettings).where(eq(deviceSettings.key, STATE_KEY)).get();
  // Spread over the defaults: state saved before `memberships` existed doesn't have it.
  return { ...INITIAL_STATE, ...(row?.value as Partial<PullState> | undefined) };
}

function writeState(exec: Exec, patch: Partial<PullState>): void {
  const value = { ...readState(exec), ...patch };
  exec
    .insert(deviceSettings)
    .values({ key: STATE_KEY, value })
    .onConflictDoUpdate({ target: deviceSettings.key, set: { value } })
    .run();
}

export function getPullState(): PullState {
  return readState();
}

export const householdCursorKey = (householdId: string, table: string) => `household:${householdId}:${table}`;

// --- Pending local edits -------------------------------------------------------------------

type Pending = { fields: Set<string>; counters: Record<string, number>; deleted: boolean };
type PendingIndex = Map<string, Pending>;

function refKey(table: string, id: unknown, key: Record<string, unknown> | undefined): string {
  if (typeof id === 'string') return `${table}:${id}`;
  const entries = Object.entries(key ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${table}:${JSON.stringify(entries)}`;
}

/** Unsent outbox mutations, by outbox id. */
type PendingMutations = Map<number, Mutation>;

function pendingMutations(exec: Exec): PendingMutations {
  const rows = exec.select({ id: outbox.id, mutation: outbox.mutation }).from(outbox).where(isNull(outbox.rejectedAt)).all();
  return new Map(rows.map((r) => [r.id, r.mutation as Mutation]));
}

/**
 * What the outbox has to send now, plus what it had to send when the rows being applied were
 * fetched (`before`): a push that settled meanwhile may have reached the server after them, so
 * those rows don't have it. Mutations rejected since are left out: the server never took them.
 */
function pendingSince(exec: Exec, before: PendingMutations): PendingMutations {
  const now = pendingMutations(exec);
  const gone = [...before.keys()].filter((id) => !now.has(id));
  if (!gone.length) return now;
  const rejected = new Set(
    exec
      .select({ id: outbox.id })
      .from(outbox)
      .where(and(inArray(outbox.id, gone), isNotNull(outbox.rejectedAt)))
      .all()
      .map((r) => r.id),
  );
  for (const id of gone) if (!rejected.has(id)) now.set(id, before.get(id)!);
  return now;
}

/** What the outbox still has to send, by row. */
function pendingIndex(exec: Exec, mutations: PendingMutations = pendingMutations(exec)): PendingIndex {
  const index: PendingIndex = new Map();
  for (const m of mutations.values()) {
    const ref = refKey(m.table, m.id, m.key);
    const entry = index.get(ref) ?? { fields: new Set<string>(), counters: {}, deleted: false };
    for (const field of Object.keys(m.fields)) entry.fields.add(field);
    for (const [name, delta] of Object.entries(m.counters ?? {})) entry.counters[name] = (entry.counters[name] ?? 0) + delta;
    if (m.delete) entry.deleted = true;
    index.set(ref, entry);
  }
  return index;
}

// --- Applying rows -------------------------------------------------------------------------

function columnsOf(table: SQLiteTable): Record<string, SQLiteColumn> {
  return getTableColumns(table) as Record<string, SQLiteColumn>;
}

/** A server value as the local column holds it. */
function fromWire(column: SQLiteColumn, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (column.dataType === 'date') return new Date(value as string);
  if (column.dataType === 'number' && typeof value === 'string') return Number(value);
  return value;
}

/** JSON with object keys sorted: Postgres reorders `jsonb` keys, so the same tags compare equal. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

const comparable = (value: unknown) =>
  value instanceof Date ? value.getTime() : value !== null && typeof value === 'object' ? canonicalJson(value) : (value ?? null);

/** The LWW rule (7.3) for one field of a row both sides have. */
export function remoteFieldWins(remoteHlc: string | undefined, localHlc: string | undefined, pendingLocally: boolean): boolean {
  if (remoteHlc) return !localHlc || compareHlc(remoteHlc, localHlc) >= 0;
  return !pendingLocally;
}

const LOCAL_ONLY = new Set(['fieldClock', 'createdAt', 'updatedAt']);

/** Rows per local read: well under SQLite's bound-parameter limit with up to three key columns. */
const LOCAL_READ_CHUNK = 250;

/** A row's key values as text, in key order: how `LocalRows` finds it. */
const localKey = (values: unknown[]) => JSON.stringify(values.map(String));

/**
 * The local copies of a page's rows, read up front (absent ones as `undefined`). Each is handed
 * out once, and one a write may have changed is forgotten, so reading it again goes to SQLite.
 */
class LocalRows {
  private readonly rows = new Map<string, Row | undefined>();

  has(key: string): boolean {
    return this.rows.has(key);
  }

  set(key: string, row: Row | undefined): void {
    this.rows.set(key, row);
  }

  /** The row read up front for `key`, or `read()` when there's none (or it was handed out). */
  take(key: string, read: () => Row | undefined): Row | undefined {
    if (!this.rows.has(key)) return read();
    const row = this.rows.get(key);
    this.rows.delete(key);
    return row;
  }

  forget(key: string): void {
    this.rows.delete(key);
  }
}

/** The local rows of `table` whose `key` columns (properties) match one of `rows`' (server rows). */
function readLocalRows(tx: Exec, table: SQLiteTable, key: readonly string[], rows: ServerRow[]): LocalRows {
  const columns = columnsOf(table);
  const local = new LocalRows();
  for (let i = 0; i < rows.length; i += LOCAL_READ_CHUNK) {
    const values = rows.slice(i, i + LOCAL_READ_CHUNK).map((row) => key.map((k) => fromWire(columns[k], row[columns[k].name])));
    for (const v of values) local.set(localKey(v), undefined);
    // Each key column against the chunk's values: with several, a superset of the chunk's rows.
    const where = and(...key.map((k, j) => inArray(columns[k], [...new Set(values.map((v) => v[j]))])));
    for (const row of tx.select().from(table).where(where).all() as Row[]) {
      const found = localKey(key.map((k) => row[k]));
      if (local.has(found)) local.set(found, row);
    }
  }
  return local;
}

const hasForeignKeys = (table: SQLiteTable) => getTableConfig(table).foreignKeys.length > 0;

/**
 * Merges every other local open item for `item`'s ingredient on its list into it (a silent
 * Combine, 4.4). So is one for another name of its family (4.15) that this device opened and hasn't
 * pushed (added, unchecked or restored), since that's when `apply_mutations` merges across a family,
 * but only when the household combines languages. Returns the merged ids; their contributions move
 * once `item` is written.
 */
function closeClashingItems(tx: Exec, item: Row, pending: PendingIndex): string[] {
  if (item.deletedAt != null || item.checkedAt != null) return [];
  const name = item.ingredientName as string;
  const sameName = eq(listItems.ingredientName, name);
  const combine = householdCombinesLanguages(tx, item.householdId as string);
  const opensOnPush = (id: string) => {
    const fields = pending.get(refKey(getTableName(listItems), id, undefined))?.fields;
    return !!fields && (fields.has('checked_at') || fields.has('deleted_at'));
  };
  const others = tx
    .select({ id: listItems.id, ingredientName: listItems.ingredientName })
    .from(listItems)
    .leftJoin(ingredients, eq(ingredients.normalizedName, listItems.ingredientName))
    .where(
      and(
        eq(listItems.listId, item.listId as string),
        combine
          ? or(sameName, eq(sql`coalesce(${ingredients.sameAs}, ${listItems.ingredientName})`, localFamilyKey(tx, name)))
          : sameName,
        isNull(listItems.deletedAt),
        isNull(listItems.checkedAt),
        ne(listItems.id, item.id as string),
      ),
    )
    .all()
    .filter((r) => r.ingredientName === name || opensOnPush(r.id))
    .map((r) => r.id);
  if (others.length) tx.update(listItems).set({ deletedAt: new Date() }).where(inArray(listItems.id, others)).run();
  return others;
}

/** Applies one server row of a household or per-user table. Throws if SQLite refuses it. */
function applySyncedRow(spec: PullSpec, tx: Exec, remote: ServerRow, pending: PendingIndex, locals: LocalRows): void {
  const { table } = spec;
  const tableName = getTableName(table);
  const columns = columnsOf(table);
  const keyValues: Row = {};
  for (const k of spec.key) keyValues[k] = fromWire(columns[k], remote[columns[k].name]);
  const where: SQL = and(...spec.key.map((k) => eq(columns[k], keyValues[k])))!;

  const ref =
    spec.key.length === 1 && spec.key[0] === 'id'
      ? refKey(tableName, remote.id, undefined)
      : refKey(tableName, undefined, Object.fromEntries(spec.key.map((k) => [columns[k].name, remote[columns[k].name]])));
  const mine = pending.get(ref);
  // Removed here and not yet pushed: the delete goes up and the server row with it.
  if (mine?.deleted) return;

  const local = locals.take(localKey(spec.key.map((k) => keyValues[k])), () => tx.select().from(table).where(where).get() as Row | undefined);
  const remoteClock = (remote.field_clock ?? {}) as FieldClock;
  const localClock = (local?.fieldClock ?? {}) as FieldClock;
  const clock: FieldClock = { ...localClock };
  const set: Row = {};
  for (const [prop, column] of Object.entries(columns)) {
    if (spec.key.includes(prop) || spec.counters?.includes(prop) || LOCAL_ONLY.has(prop)) continue;
    if (!(column.name in remote)) continue;
    let value = fromWire(column, remote[column.name]);
    if (local) {
      if (spec.latest?.includes(prop)) {
        if ((comparable(local[prop]) as number) > (comparable(value) as number)) value = local[prop];
      } else if (!remoteFieldWins(remoteClock[column.name], localClock[column.name], mine?.fields.has(column.name) ?? false)) {
        continue;
      }
    }
    set[prop] = value;
    if (remoteClock[column.name]) clock[column.name] = remoteClock[column.name];
  }
  for (const prop of spec.counters ?? []) {
    const name = columns[prop].name;
    set[prop] = Number(remote[name] ?? 0) + (mine?.counters[name] ?? 0);
  }
  // The default list may be in a household this device doesn't have; keep the local one then.
  if (table === userSettings && typeof set.defaultListId === 'string') {
    if (!tx.select({ id: lists.id }).from(lists).where(eq(lists.id, set.defaultListId)).get()) {
      delete set.defaultListId;
      delete clock.default_list_id;
    }
  }

  // A usage row at 0 or below reads as absent (7.1).
  if (spec.counters?.some((prop) => (set[prop] as number) <= 0)) {
    if (local) tx.delete(table).where(where).run();
    return;
  }

  const remoteUpdatedAt = new Date(remote.updated_at);
  const changed: Row = {};
  if (local) {
    for (const [prop, value] of Object.entries(set)) {
      if (comparable(local[prop]) !== comparable(value)) changed[prop] = value;
    }
    const clockChanged = JSON.stringify(clock) !== JSON.stringify(localClock);
    // Nothing new (e.g. the overlap read again): nothing to write, and no clash it could open.
    if (Object.keys(changed).length === 0 && !clockChanged) return;
  }
  const merged = table === listItems ? closeClashingItems(tx, { ...local, ...keyValues, ...set }, pending) : [];
  // Rows of this page it closed: their local copies changed.
  for (const id of merged) locals.forget(localKey([id]));
  if (local) {
    if ('updatedAt' in columns) {
      const localUpdatedAt = local.updatedAt as Date;
      changed.updatedAt = localUpdatedAt > remoteUpdatedAt ? localUpdatedAt : remoteUpdatedAt;
    }
    tx.update(table)
      .set({ ...changed, fieldClock: clock } as never)
      .where(where)
      .run();
  } else {
    const values: Row = { ...keyValues, ...set, fieldClock: remoteClock };
    if ('createdAt' in columns && remote.created_at) values.createdAt = new Date(remote.created_at as string);
    if ('updatedAt' in columns) values.updatedAt = remoteUpdatedAt;
    tx.insert(table)
      .values(values as never)
      .run();
  }
  if (merged.length) {
    tx.update(listItemContributions)
      .set({ listItemId: keyValues.id as string })
      .where(inArray(listItemContributions.listItemId, merged))
      .run();
  }
}

/** Per-user tables the server hard-deletes from, by server name: pull can't see those deletes. */
const HARD_DELETE_SPECS: Record<string, PullSpec> = {
  user_household_category_order: USER_SPECS[0],
};

/**
 * Applies a Realtime delete of one of the user's hard-deleted rows (spec 7.2). `old` is the row's
 * key, as Realtime sends it. A row with an unpushed local change stays: that change goes up and
 * brings it back. Returns whether a local row was deleted.
 */
export function applyRemoteDelete(table: string, old: Record<string, unknown>, userId: string): boolean {
  const spec = HARD_DELETE_SPECS[table];
  if (!spec || old.user_id !== userId) return false;
  const columns = columnsOf(spec.table);
  const names = spec.key.map((k) => columns[k].name);
  if (names.some((name) => typeof old[name] !== 'string')) return false;
  return db.transaction((tx) => {
    const ref = refKey(table, undefined, Object.fromEntries(names.map((name) => [name, old[name]])));
    if (pendingIndex(tx).has(ref)) return false;
    const where = and(...spec.key.map((k) => eq(columns[k], old[columns[k].name] as string)))!;
    if (!tx.select().from(spec.table).where(where).get()) return false;
    tx.delete(spec.table).where(where).run();
    return true;
  });
}

/**
 * Applies a catalog row to the local copy of an ingredient this device already has (7.4). Never
 * adds names: the device keeps the seed plus what it has seen. A server answer that isn't final
 * doesn't replace a categorized one. Language and link (`lang`, `same_as`, `linked_by`) come with it.
 */
function applyIngredient(tx: Exec, remote: ServerRow, locals: LocalRows): void {
  const name = remote.normalized_name as string;
  const local = locals.take(localKey([name]), () => tx.select().from(ingredients).where(eq(ingredients.normalizedName, name)).get()) as
    | typeof ingredients.$inferSelect
    | undefined;
  if (!local) return;
  if (remote.status !== 'categorized' && local.status === 'categorized') return;
  const next = {
    defaultCategoryId: (remote.default_category_id as string | null) ?? null,
    status: remote.status as typeof local.status,
    isGroceryItem: (remote.is_grocery_item as boolean | null) ?? null,
    categorizedBy: (remote.categorized_by as string | null) ?? null,
    defaultUnit: (remote.default_unit as string | null) ?? null,
    // A server without the link columns (4.15) yet leaves the seed's own alone.
    lang: 'lang' in remote ? ((remote.lang as typeof local.lang) ?? null) : local.lang,
    sameAs: 'same_as' in remote ? ((remote.same_as as string | null) ?? null) : local.sameAs,
    linkedBy: 'linked_by' in remote ? ((remote.linked_by as string | null) ?? null) : local.linkedBy,
  };
  const same = (Object.keys(next) as (keyof typeof next)[]).every((k) => next[k] === local[k]);
  if (!same) tx.update(ingredients).set(next).where(eq(ingredients.normalizedName, name)).run();
}

// --- Fetching ------------------------------------------------------------------------------

type Response = { data?: unknown; error?: { message?: string } | null; status?: number };

async function call(request: PromiseLike<Response>, what: string): Promise<unknown[]> {
  let res: Response;
  try {
    res = await request;
  } catch (err) {
    throw new Error(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.error) throw new Error(`${what}: ${res.error.message || `HTTP ${res.status ?? 0}`}`);
  if (!Array.isArray(res.data)) throw new Error(`${what}: unexpected response`);
  return res.data;
}

/**
 * Where a page starts: after `at`, or after the row at `at` with key `key` (the job's key columns'
 * values) when one is given.
 */
type Position = { at: string; key: string[] | null };

/** A value for a PostgREST logic tree, quoted so commas, dots and parentheses in it are plain text. */
const quoted = (value: string) => `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/**
 * The `or` filter for rows after `(at, key)` in `(updated_at, ...columns)` order: a later time, or
 * the same time and a later key, compared column by column.
 */
export function afterPositionFilter(columns: readonly string[], at: string, key: readonly string[]): string {
  const terms = [`updated_at.gt.${quoted(at)}`];
  for (let i = 0; i < columns.length; i++) {
    const equal = [`updated_at.eq.${quoted(at)}`, ...columns.slice(0, i).map((c, j) => `${c}.eq.${quoted(key[j])}`)];
    terms.push(`and(${[...equal, `${columns[i]}.gt.${quoted(key[i])}`].join(',')})`);
  }
  return terms.join(',');
}

/**
 * A page of rows changed after `from`, oldest first and by key within a time; with `keys`, only
 * the rows whose (single-column) key is one of them.
 */
function fetchRows(job: Job, from: Position | null, keys?: string[]): Promise<ServerRow[]> {
  let query = supabase.from(job.table).select('*');
  for (const [column, value] of job.filters) query = value === null ? query.is(column, null) : query.eq(column, value);
  if (keys) query = query.in(job.key[0], keys);
  if (from?.key) query = query.or(afterPositionFilter(job.key, from.at, from.key));
  else if (from) query = query.gt('updated_at', from.at);
  query = query.order('updated_at', { ascending: true });
  for (const column of job.key) query = query.order(column, { ascending: true });
  return call(query.limit(PULL_PAGE_SIZE), job.table) as Promise<ServerRow[]>;
}

/** Server timestamps share one format, so their text sorts like their time. */
const later = (a: string | undefined, b: string) => (a !== undefined && a > b ? a : b);

/** Thrown when the signed-in user changed during a run (sign-out): the rest of it is dropped. */
class UserChanged extends Error {}

/** Throws `UserChanged` unless `userId` is still the signed-in user. */
function assertSameUser(userId: string): void {
  if (getAccount()?.userId !== userId) throw new UserChanged();
}

// --- Quarantine ----------------------------------------------------------------------------

/** A server row this device skipped after SQLite refused it `QUARANTINE_AFTER` times. */
export type QuarantinedRow = {
  /** `table|updated_at|key`, the key being the job's key columns' values joined by commas. */
  key: string;
  table: string;
  /** The job's cursor key, e.g. `household:<id>:list_items`. */
  cursor: string;
  updatedAt: string;
  error: string;
  /** When it was skipped (ISO). */
  at: string;
};

type Quarantine = {
  /** Times each refused row (by `QuarantinedRow.key`) has failed so far, below `QUARANTINE_AFTER`. */
  failures: Record<string, number>;
  rows: QuarantinedRow[];
};

/** A refused row this many times in a row is skipped: it won't settle on its own. */
export const QUARANTINE_AFTER = 3;
const QUARANTINE_KEY = 'sync.quarantine';

function readQuarantine(exec: Exec): Quarantine {
  const row = exec.select().from(deviceSettings).where(eq(deviceSettings.key, QUARANTINE_KEY)).get();
  const value = row?.value as Partial<Quarantine> | undefined;
  return { failures: { ...value?.failures }, rows: [...(value?.rows ?? [])] };
}

function writeQuarantine(exec: Exec, value: Quarantine): void {
  exec
    .insert(deviceSettings)
    .values({ key: QUARANTINE_KEY, value })
    .onConflictDoUpdate({ target: deviceSettings.key, set: { value } })
    .run();
}

/** The rows pull skipped because they couldn't be applied, oldest first. */
export function getQuarantinedRows(exec: Exec = db): QuarantinedRow[] {
  return readQuarantine(exec).rows;
}

const quarantineKey = (job: Job, row: ServerRow) =>
  `${job.table}|${row.updated_at}|${job.key.map((column) => String(row[column] ?? '')).join(',')}`;

/**
 * Applies `rows` (oldest first) and moves the cursor past them, in one transaction. A row SQLite
 * refuses (e.g. its parent changed after its table was pulled) is usually a race the next pull
 * settles, so it stops the table there: the cursor stays before it so the next pull tries again
 * (`complete` false). The same row refused a `QUARANTINE_AFTER`th time won't settle on its own
 * (schema drift, a parent this device will never get): it's skipped and recorded in
 * `sync.quarantine` (Sync status counts them), and sent to Sentry, so it doesn't hold back the rest
 * of its table. A quarantined row that applies later (fetched again) leaves the quarantine. Writes
 * nothing (and throws `UserChanged`) if `userId` is no longer signed in: the rows are theirs, and
 * the device may have been wiped since they were fetched. `fetchedWith` is the outbox as it was
 * before the fetch. With `saveCursor` false the cursor is left alone (the caller saves it).
 */
function commit(
  userId: string,
  job: Job,
  rows: ServerRow[],
  fetchedWith: PendingMutations,
  saveCursor = true,
): { applied: number; complete: boolean } {
  assertSameUser(userId);
  return db.transaction((tx) => {
    const pending = pendingIndex(tx, pendingSince(tx, fetchedWith));
    const locals = job.readLocal(tx, rows);
    let cursor = saveCursor ? readState(tx).cursors[job.cursor] : undefined;
    let latestHlc: string | null = null;
    let applied = 0;
    const quarantine = readQuarantine(tx);
    let quarantineChanged = false;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        // Without foreign keys, SQLite refuses only a statement, which it undoes itself.
        if (job.savepoint) tx.transaction((sp) => job.apply(sp, row, pending, locals));
        else job.apply(tx, row, pending, locals);
      } catch (err) {
        const key = quarantineKey(job, row);
        if (quarantine.rows.some((r) => r.key === key)) continue;
        const times = (quarantine.failures[key] ?? 0) + 1;
        quarantineChanged = true;
        if (times >= QUARANTINE_AFTER) {
          console.warn(`[pull] couldn't apply a ${job.table} row ${times} times; skipping it`, err);
          reportError(err, { area: 'sync', event: 'pull_apply_failed', table: job.table });
          delete quarantine.failures[key];
          const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
          quarantine.rows.push({ key, table: job.table, cursor: job.cursor, updatedAt: row.updated_at, error, at: new Date().toISOString() });
          continue;
        }
        console.warn(`[pull] couldn't apply a ${job.table} row; will retry`, err);
        quarantine.failures[key] = times;
        writeQuarantine(tx, quarantine);
        // Rows at earlier times are all in; rows at this row's time may not be.
        const done = rows.slice(0, i).filter((r) => r.updated_at < row.updated_at);
        if (done.length && saveCursor) cursor = later(cursor, done[done.length - 1].updated_at);
        if (cursor !== undefined) writeState(tx, { cursors: { ...readState(tx).cursors, [job.cursor]: cursor } });
        if (latestHlc) observeHlc(latestHlc, tx);
        return { applied, complete: false };
      }
      if (Object.keys(quarantine.failures).length || quarantine.rows.length) {
        const key = quarantineKey(job, row);
        if (key in quarantine.failures || quarantine.rows.some((r) => r.key === key)) {
          delete quarantine.failures[key];
          quarantine.rows = quarantine.rows.filter((r) => r.key !== key);
          quarantineChanged = true;
        }
      }
      applied++;
      for (const hlc of Object.values((row.field_clock ?? {}) as FieldClock)) {
        if (typeof hlc === 'string' && (latestHlc === null || hlc > latestHlc)) latestHlc = hlc;
      }
    }
    if (quarantineChanged) writeQuarantine(tx, quarantine);
    if (rows.length && saveCursor) cursor = later(cursor, rows[rows.length - 1].updated_at);
    if (cursor !== undefined) writeState(tx, { cursors: { ...readState(tx).cursors, [job.cursor]: cursor } });
    // Later local writes must beat what we just saw (7.1).
    if (latestHlc) observeHlc(latestHlc, tx);
    return { applied, complete: true };
  });
}

/** Pulls one table from its cursor to now. Returns how many rows were applied. */
async function pullTable(userId: string, job: Job): Promise<number> {
  const cursor = readState().cursors[job.cursor];
  if (!cursor && job.firstPullKeys) {
    const keys = job.firstPullKeys(db);
    if (keys.length) return pullKeys(userId, job, keys);
  }
  let from: Position | null = cursor ? { at: new Date(Date.parse(cursor) - PULL_OVERLAP_MS).toISOString(), key: null } : null;
  let total = 0;
  for (;;) {
    // Before the fetch: a push that settles during it doesn't let its rows overwrite the edit.
    const fetchedWith = pendingMutations(db);
    const page = await fetchRows(job, from);
    if (page.length === 0) return total;
    const result = commit(userId, job, page, fetchedWith);
    total += result.applied;
    // A short page is the last one; a full one (even one PostgREST cut at `max_rows`) may not be.
    if (!result.complete || page.length < Math.min(PULL_PAGE_SIZE, POSTGREST_MAX_ROWS)) return total;
    const last = page[page.length - 1];
    from = { at: last.updated_at, key: job.key.map((column) => String(last[column])) };
  }
}

/** Keys per request on a first pull by key: one page each, and a URL of a few kB. */
export const PULL_KEYS_CHUNK = 200;

/**
 * A first pull of only the rows whose key is one of `keys`, `PULL_KEYS_CHUNK` keys per request.
 * The cursor is saved, at the newest row read, once all are in: a run cut short (or a row SQLite
 * refuses) leaves none, so the next pull does it again. Returns how many rows were applied.
 */
async function pullKeys(userId: string, job: Job, keys: string[]): Promise<number> {
  let newest: string | undefined;
  let total = 0;
  for (let i = 0; i < keys.length; i += PULL_KEYS_CHUNK) {
    const fetchedWith = pendingMutations(db);
    // A key matches at most one row, so a chunk is one page.
    const page = await fetchRows(job, null, keys.slice(i, i + PULL_KEYS_CHUNK));
    if (page.length === 0) continue;
    const result = commit(userId, job, page, fetchedWith, false);
    total += result.applied;
    if (!result.complete) return total;
    newest = later(newest, page[page.length - 1].updated_at);
  }
  assertSameUser(userId);
  if (newest !== undefined) {
    const at = newest;
    db.transaction((tx) => writeState(tx, { cursors: { ...readState(tx).cursors, [job.cursor]: at } }));
  }
  return total;
}

/** A spec's key columns, as the server names them. */
const serverKey = (spec: PullSpec) => spec.key.map((k) => columnsOf(spec.table)[k].name);

/** The job parts every household, user and system-category table shares. */
function syncedJob(spec: PullSpec): Pick<Job, 'key' | 'savepoint' | 'readLocal' | 'apply'> {
  return {
    key: serverKey(spec),
    savepoint: hasForeignKeys(spec.table),
    readLocal: (tx, rows) => readLocalRows(tx, spec.table, spec.key, rows),
    apply: (tx, row, pending, locals) => applySyncedRow(spec, tx, row, pending, locals),
  };
}

function householdJobs(householdId: string): Job[] {
  return HOUSEHOLD_SPECS.map((spec) => {
    const table = getTableName(spec.table);
    return {
      cursor: householdCursorKey(householdId, table),
      table,
      filters: [[spec.table === households ? 'id' : 'household_id', householdId]],
      ...syncedJob(spec),
    };
  });
}

function userJobs(userId: string): Job[] {
  return USER_SPECS.map((spec) => {
    const table = getTableName(spec.table);
    return { cursor: `user:${table}`, table, filters: [['user_id', userId]], ...syncedJob(spec) };
  });
}

/**
 * System categories first: ingredients point at them. Custom ones come with their household. A
 * first pull of the ingredients reads only the names this device has (the seed and what it has
 * seen), the only ones `applyIngredient` keeps; later ones read every change since.
 */
const CATALOG_JOBS: Job[] = [
  { cursor: 'catalog:categories', table: 'categories', filters: [['household_id', null]], ...syncedJob(SYSTEM_CATEGORIES_SPEC) },
  {
    cursor: 'catalog:ingredients',
    table: 'ingredients',
    key: ['normalized_name'],
    filters: [],
    savepoint: hasForeignKeys(ingredients),
    readLocal: (tx, rows) => readLocalRows(tx, ingredients, ['normalizedName'], rows),
    apply: (tx, row, _pending, locals) => applyIngredient(tx, row, locals),
    firstPullKeys: (exec) =>
      exec
        .select({ name: ingredients.normalizedName })
        .from(ingredients)
        .orderBy(ingredients.normalizedName)
        .all()
        .map((r) => r.name),
  },
];

// --- Running -------------------------------------------------------------------------------

export type PullSummary =
  | { skipped: 'no-session' | 'offline' }
  | {
      skipped?: undefined;
      /** Server rows applied (including ones that changed nothing locally). */
      pulled: number;
      /** The households pulled, in the server's order. */
      households: string[];
      /** Set when the run stopped early; cursors already saved stay. */
      error: string | null;
    };

/**
 * Part of a pull, for Realtime (spec 7.2): some households, the user's preference tables and/or
 * the catalog. Doesn't read memberships. Without a scope, a pull reads memberships and does it all.
 */
export type PullScope = { households?: string[]; user?: boolean; catalog?: boolean };

/** Everything both ask for; `'all'` (a full pull) covers the rest. */
export function mergeScopes(a: PullScope | 'all' | null, b: PullScope | 'all'): PullScope | 'all' {
  if (a === null) return b;
  if (a === 'all' || b === 'all') return 'all';
  return {
    households: [...new Set([...(a.households ?? []), ...(b.households ?? [])])],
    user: !!(a.user || b.user),
    catalog: !!(a.catalog || b.catalog),
  };
}

type MembershipListener = (households: string[]) => void;
const membershipListeners = new Set<MembershipListener>();
let lastMemberships: { userId: string; households: string[] } | null = null;

/**
 * Calls `listener` with the user's households each time a full pull reads them, and right away
 * with the last ones read for `userId`, if any. Returns an unsubscribe.
 */
export function onMemberships(userId: string, listener: MembershipListener): () => void {
  membershipListeners.add(listener);
  if (lastMemberships?.userId === userId) listener(lastMemberships.households);
  return () => {
    membershipListeners.delete(listener);
  };
}

/**
 * Households created on this device whose creation the server refused for good (a rejected
 * `create_household`, e.g. `already in a household`) and that it doesn't list in `current`.
 */
function refusedHouseholds(tx: Exec, current: string[]): string[] {
  const rows = tx.select({ mutation: outbox.mutation }).from(outbox).where(isNotNull(outbox.rejectedAt)).all();
  const ids = new Set<string>();
  for (const { mutation: m } of rows as { mutation: Mutation }[]) {
    // An insert carries `created_at`; a later rename doesn't (as in push.ts).
    if (m.table === 'households' && m.id && 'created_at' in m.fields && !current.includes(m.id)) ids.add(m.id);
  }
  return [...ids];
}

/**
 * Purges the households the last full pull listed and this one doesn't (left, removed or deleted,
 * 4.7), and the ones created here that the server refused and doesn't list, and remembers
 * `current` for next time. Everyone always has a household, so an empty list is taken as a bad
 * answer: nothing is purged and the last list is kept.
 */
function purgeLostHouseholds(current: string[]): void {
  if (current.length === 0) return;
  let purged = false;
  db.transaction((tx) => {
    const state = readState(tx);
    const lost = (state.memberships ?? []).filter((id) => !current.includes(id));
    const cursors = { ...state.cursors };
    for (const householdId of lost) {
      const summary = purgeHousehold(tx, householdId);
      console.info(`[pull] no longer a member of ${householdId}; removed it from this device`, summary);
      // Joining again pulls it in full.
      const prefix = householdCursorKey(householdId, '');
      for (const key of Object.keys(cursors)) if (key.startsWith(prefix)) delete cursors[key];
    }
    // Never on the server, so nothing of it there to keep (and no cursors or photos of it here).
    for (const householdId of refusedHouseholds(tx, current)) {
      if (lost.includes(householdId)) continue;
      const summary = purgeHousehold(tx, householdId);
      console.info(`[pull] the server refused to create ${householdId}; removed it from this device`, summary);
    }
    writeState(tx, { cursors, memberships: current });
    purged = lost.length > 0;
  });
  // Its photos may be in expo-image's cache (spec 4.5): a former member's phone doesn't keep them.
  if (purged) void clearPhotoCache();
}

async function runPull(now: () => Date, scope: PullScope | 'all'): Promise<PullSummary> {
  const account = getAccount();
  if (!isSupabaseConfigured || !account) return { skipped: 'no-session' };
  if (online === false) return { skipped: 'offline' };
  const { userId } = account;
  if (readState().userId !== userId) {
    db.transaction((tx) => writeState(tx, { userId, cursors: {}, memberships: null }));
  }
  const all = scope === 'all';

  let pulled = 0;
  let memberships: string[] = all ? [] : (scope.households ?? []);
  try {
    if (all) {
      const members = await call(
        supabase.from('household_members').select('household_id').eq('user_id', userId),
        'household_members',
      );
      assertSameUser(userId);
      memberships = [...new Set(members.map((m) => (m as { household_id: string }).household_id))];
      lastMemberships = { userId, households: memberships };
      for (const listener of [...membershipListeners]) listener(memberships);
    }
    for (const householdId of memberships) {
      for (const job of householdJobs(householdId)) pulled += await pullTable(userId, job);
    }
    assertSameUser(userId);
    if (all) purgeLostHouseholds(memberships);
    if (all || scope.user) {
      for (const job of userJobs(userId)) pulled += await pullTable(userId, job);
    }
    assertSameUser(userId);
    // Names pulled in are cached as pending until the catalog (or categorization) knows them.
    if (all || memberships.length || scope.user) ensureMissingIngredients();
    if (all || scope.catalog) {
      for (const job of CATALOG_JOBS) pulled += await pullTable(userId, job);
    }
    // Never throws: a household whose names don't load keeps the ones it had.
    if (all) await refreshAllMemberNames(memberships);
    assertSameUser(userId);
  } catch (err) {
    if (err instanceof UserChanged) {
      console.info('[pull] the user signed out during the pull; dropped the rest of it');
      return { skipped: 'no-session' };
    }
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[pull] failed: ${message}`);
    db.transaction((tx) => writeState(tx, { lastError: message }));
    return { pulled, households: memberships, error: message };
  }
  db.transaction((tx) => writeState(tx, { lastError: null, lastSuccessAt: now().toISOString() }));
  return { pulled, households: memberships, error: null };
}

let inFlight: Promise<PullSummary> | null = null;
/** What calls during the current run asked for; it runs once more with that. */
let queued: PullScope | 'all' | null = null;

/**
 * Pulls every household the user belongs to, their preferences and the catalog, or only `scope`.
 * Concurrent calls coalesce: a call during a run schedules exactly one more (so changes made
 * meanwhile come too), covering everything those calls asked for, and shares its promise. Never
 * throws.
 */
export function pullNow(options: { now?: () => Date; scope?: PullScope } = {}): Promise<PullSummary> {
  const now = options.now ?? (() => new Date());
  const scope = options.scope ?? 'all';
  if (inFlight) {
    queued = mergeScopes(queued, scope);
    return inFlight;
  }
  reportSyncActivity({ pulling: true });
  inFlight = (async () => {
    try {
      let result = await runPull(now, scope);
      while (queued) {
        const next = queued;
        queued = null;
        result = await runPull(now, next);
      }
      return result;
    } catch (err) {
      // runPull handles network failures; this is a local bug (e.g. the database).
      console.error('[pull] crashed', err);
      reportError(err, { area: 'sync', event: 'pull_crashed' });
      return { pulled: 0, households: [], error: err instanceof Error ? err.message : String(err) };
    } finally {
      inFlight = null;
      queued = null;
      reportSyncActivity({ pulling: false });
    }
  })();
  return inFlight;
}

/** Resolves once no pull is running (including the reruns queued during one). Never rejects. */
export async function whenIdle(): Promise<void> {
  while (inFlight) await inFlight;
}

// --- Triggers ------------------------------------------------------------------------------

/** Last known connectivity; null until the OS reports it. */
let online: boolean | null = null;

/**
 * Starts pulling: now, on foreground and on reconnect. While the OS says there's no connection,
 * pulls are skipped. Returns a cleanup.
 */
export function startPull(): () => void {
  const stopTriggers = startCatchUpTriggers(
    () => void pullNow(),
    (now) => {
      online = now;
    },
  );
  void pullNow();
  return () => {
    stopTriggers();
    online = null;
  };
}
