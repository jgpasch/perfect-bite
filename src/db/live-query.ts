import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { addDatabaseChangeListener } from 'expo-sqlite';
import { useEffect, useState } from 'react';

const sameDeps = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((d, i) => Object.is(d, b[i]));

/**
 * Like drizzle's `useLiveQuery`, but re-runs when any of `tables` changes. Drizzle's version only
 * watches the query's FROM table, so a join (e.g. phrases ⋈ outbox) goes stale when the joined
 * table is updated.
 *
 * `loading` is true until the query first settles, and again from the render where `deps` change
 * until the new query settles, so a screen can hold its empty state back rather than flash it.
 */
export function useLiveQueryOn<T>(
  query: PromiseLike<T[]>,
  tables: SQLiteTable[],
  deps: unknown[] = [],
): { data: T[]; error: Error | undefined; loading: boolean } {
  const [data, setData] = useState<T[]>([]);
  const [error, setError] = useState<Error>();
  // The deps of the last settled run: loading while they aren't the current ones.
  const [settled, setSettled] = useState<unknown[]>();

  useEffect(() => {
    let active = true;
    const settledFor = deps;
    const run = () =>
      query.then(
        (rows) => {
          if (!active) return;
          setData(rows);
          setSettled(settledFor);
        },
        (err: Error) => {
          if (!active) return;
          setError(err);
          setSettled(settledFor);
        },
      );
    run();
    const names = new Set(tables.map((t) => getTableConfig(t).name));
    // expo-sqlite fires once per changed row, so a bulk write (a pull commit, a purge) is hundreds
    // of events: coalesce them into one re-run per microtask.
    let queued = false;
    const listener = addDatabaseChangeListener(({ tableName }) => {
      if (!names.has(tableName) || queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (active) run();
      });
    });
    return () => {
      active = false;
      listener.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- same contract as drizzle's useLiveQuery
  }, deps);

  return { data, error, loading: settled === undefined || !sameDeps(settled, deps) };
}
