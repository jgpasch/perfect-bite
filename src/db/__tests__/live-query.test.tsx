import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { asc, eq } from 'drizzle-orm';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { db, households, listItems, lists } from '@/db';
import { resetDb } from '@/test/db';

import { useLiveQueryOn } from '../live-query';

jest.mock('@/db/client', () => require('@/test/db'));

// Real writes go to better-sqlite3, which has no change hook: tests announce changes by hand.
type ChangeListener = (event: { tableName: string }) => void;
const mockChangeListeners = new Set<ChangeListener>();
jest.mock('expo-sqlite', () => ({
  addDatabaseChangeListener: (l: ChangeListener) => {
    mockChangeListeners.add(l);
    return { remove: () => mockChangeListeners.delete(l) };
  },
}));

/** Announces a change and lets the re-run query settle. */
async function changed(tableName: string) {
  await act(async () => {
    mockChangeListeners.forEach((l) => l({ tableName }));
  });
}

type Result<T> = { data: T[]; error: Error | undefined; loading: boolean };

const mounted: ReactTestRenderer[] = [];

function render<T>(useIt: () => Result<T>) {
  const seen: { current: Result<T> } = { current: { data: [], error: undefined, loading: true } };
  function Probe() {
    seen.current = useIt();
    return null;
  }
  let tree!: ReactTestRenderer;
  return {
    seen,
    mount: async () => {
      await act(async () => {
        tree = create(<Probe />);
      });
      mounted.push(tree);
      return tree;
    },
  };
}

const addList = (id: string, name: string, position: number) =>
  db.insert(lists).values({ id, householdId: 'h1', name, position }).run();

/** List names with how many items each has: a join, so it reads two tables. */
const namesWithItems = () =>
  db
    .select({ name: lists.name, itemId: listItems.id })
    .from(lists)
    .leftJoin(listItems, eq(listItems.listId, lists.id))
    .orderBy(asc(lists.position));

afterEach(() => {
  act(() => mounted.splice(0).forEach((t) => t.unmount()));
});

beforeEach(() => {
  resetDb();
  db.insert(households).values({ id: 'h1', name: 'Home' }).run();
});

describe('useLiveQueryOn', () => {
  test('starts empty, then has the rows', async () => {
    addList('l1', 'Groceries', 1);
    const { seen, mount } = render(() => useLiveQueryOn(db.select({ name: lists.name }).from(lists), [lists]));
    await mount();
    expect(seen.current).toEqual({ data: [{ name: 'Groceries' }], error: undefined, loading: false });
  });

  test('re-runs when any watched table changes, not just the FROM table', async () => {
    addList('l1', 'Groceries', 1);
    const { seen, mount } = render(() => useLiveQueryOn(namesWithItems(), [lists, listItems]));
    await mount();
    expect(seen.current.data).toEqual([{ name: 'Groceries', itemId: null }]);

    db.insert(listItems)
      .values({ id: 'i1', householdId: 'h1', listId: 'l1', ingredientName: 'milk', displayName: 'milk' } as typeof listItems.$inferInsert)
      .run();
    await changed('list_items');
    expect(seen.current.data).toEqual([{ name: 'Groceries', itemId: 'i1' }]);

    addList('l2', 'Costco', 2);
    await changed('lists');
    expect(seen.current.data.map((r) => r.name)).toEqual(['Groceries', 'Costco']);
  });

  test('ignores changes to tables it does not watch', async () => {
    const { seen, mount } = render(() => useLiveQueryOn(db.select({ name: lists.name }).from(lists), [lists]));
    await mount();
    addList('l1', 'Groceries', 1);
    await changed('recipes');
    expect(seen.current.data).toEqual([]);
  });

  /** A query that counts how often it runs. */
  const counted = () => {
    const runs = { n: 0 };
    const query: PromiseLike<{ name: string }[]> = {
      then: (ok, fail) => {
        runs.n += 1;
        return db.select({ name: lists.name }).from(lists).then(ok, fail);
      },
    };
    return { runs, query };
  };

  test('coalesces a burst of change events into one re-run', async () => {
    const { runs, query } = counted();
    const { seen, mount } = render(() => useLiveQueryOn(query, [lists, listItems]));
    await mount();
    expect(runs.n).toBe(1);

    // A 500-row pull commit: one event per row, across both watched tables.
    for (let i = 0; i < 500; i++) addList(`l${i}`, `List ${i}`, i);
    await act(async () => {
      for (let i = 0; i < 500; i++) mockChangeListeners.forEach((l) => l({ tableName: i % 2 ? 'lists' : 'list_items' }));
    });
    expect(runs.n).toBe(2);
    expect(seen.current.data).toHaveLength(500);

    // A later change still re-runs.
    addList('late', 'Late', 999);
    await changed('lists');
    expect(runs.n).toBe(3);
    expect(seen.current.data).toHaveLength(501);
  });

  test('a burst of unwatched changes does not re-run', async () => {
    const { runs, query } = counted();
    const { mount } = render(() => useLiveQueryOn(query, [lists]));
    await mount();
    await act(async () => {
      for (let i = 0; i < 100; i++) mockChangeListeners.forEach((l) => l({ tableName: 'recipes' }));
    });
    expect(runs.n).toBe(1);
  });

  test('a burst queued just before unmount does not run', async () => {
    const { runs, query } = counted();
    const { mount } = render(() => useLiveQueryOn(query, [lists]));
    const tree = await mount();
    act(() => {
      mockChangeListeners.forEach((l) => l({ tableName: 'lists' }));
      tree.unmount();
    });
    await act(async () => {});
    expect(runs.n).toBe(1);
  });

  test('reports a failing query as an error', async () => {
    const failing: PromiseLike<never[]> = { then: (_ok, fail) => Promise.reject(new Error('no such table')).then(_ok, fail) };
    const { seen, mount } = render(() => useLiveQueryOn(failing, [lists]));
    await mount();
    expect(seen.current.data).toEqual([]);
    expect(seen.current.error?.message).toBe('no such table');
  });

  test('stops listening on unmount, and a result that lands after unmount is dropped', async () => {
    let resolve!: (rows: string[]) => void;
    const slow: PromiseLike<string[]> = {
      then: (ok, fail) => new Promise<string[]>((r) => (resolve = r)).then(ok, fail),
    };
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { seen, mount } = render(() => useLiveQueryOn(slow, [lists]));
    const tree = await mount();
    expect(mockChangeListeners.size).toBe(1);

    act(() => tree.unmount());
    expect(mockChangeListeners.size).toBe(0);
    await act(async () => resolve(['late']));
    expect(seen.current.data).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  /** A query that waits for `resolve` (or `reject`) on each run. */
  const deferred = <T,>() => {
    const pending: { resolve: (rows: T[]) => void; reject: (err: Error) => void }[] = [];
    const query: PromiseLike<T[]> = {
      then: (ok, fail) => new Promise<T[]>((resolve, reject) => pending.push({ resolve, reject })).then(ok, fail),
    };
    return { pending, query };
  };

  test('is loading until the first result lands, then not', async () => {
    const { pending, query } = deferred<string>();
    const { seen, mount } = render(() => useLiveQueryOn(query, [lists]));
    await mount();
    expect(seen.current).toEqual({ data: [], error: undefined, loading: true });

    await act(async () => pending[0].resolve([]));
    // An empty result is a result: no longer loading.
    expect(seen.current).toEqual({ data: [], error: undefined, loading: false });
  });

  test('a re-run after a change does not go back to loading', async () => {
    const { pending, query } = deferred<string>();
    const loadings: boolean[] = [];
    const { mount } = render(() => {
      const r = useLiveQueryOn(query, [lists]);
      loadings.push(r.loading);
      return r;
    });
    await mount();
    await act(async () => pending[0].resolve(['a']));
    loadings.length = 0;
    await changed('lists');
    await act(async () => pending[1].resolve(['a', 'b']));
    expect(loadings.length).toBeGreaterThan(0);
    expect(loadings.every((l) => !l)).toBe(true);
  });

  test('a failing query stops loading', async () => {
    const { pending, query } = deferred<string>();
    const { seen, mount } = render(() => useLiveQueryOn(query, [lists]));
    await mount();
    await act(async () => pending[0].reject(new Error('no such table')));
    expect(seen.current.loading).toBe(false);
    expect(seen.current.error?.message).toBe('no such table');
  });

  test('is loading again from the very render its deps change until the new result lands', async () => {
    const { pending, query } = deferred<string>();
    const renders: { id: string; data: string[]; loading: boolean }[] = [];
    function Named({ id }: { id: string }) {
      const { data, loading } = useLiveQueryOn(query, [lists], [id]);
      renders.push({ id, data, loading });
      return null;
    }
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Named id="l1" />);
    });
    mounted.push(tree);
    await act(async () => pending[0].resolve(['Groceries']));
    expect(renders.at(-1)).toEqual({ id: 'l1', data: ['Groceries'], loading: false });

    renders.length = 0;
    await act(async () => tree.update(<Named id="l2" />));
    // The first render with the new id is already loading: the old rows never pass as its result.
    expect(renders[0]).toEqual({ id: 'l2', data: ['Groceries'], loading: true });
    expect(renders.at(-1)?.loading).toBe(true);

    await act(async () => pending[1].resolve([]));
    expect(renders.at(-1)).toEqual({ id: 'l2', data: [], loading: false });
  });

  test('re-runs with the new query when deps change, and keeps one listener', async () => {
    addList('l1', 'Groceries', 1);
    addList('l2', 'Costco', 2);
    const seen: { current: Result<{ name: string }> } = { current: { data: [], error: undefined, loading: true } };
    function Named({ id }: { id: string }) {
      seen.current = useLiveQueryOn(db.select({ name: lists.name }).from(lists).where(eq(lists.id, id)), [lists], [id]);
      return null;
    }
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Named id="l1" />);
    });
    mounted.push(tree);
    expect(seen.current.data).toEqual([{ name: 'Groceries' }]);

    await act(async () => tree.update(<Named id="l2" />));
    expect(seen.current.data).toEqual([{ name: 'Costco' }]);
    expect(mockChangeListeners.size).toBe(1);
  });
});
