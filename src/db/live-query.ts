import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { addDatabaseChangeListener } from 'expo-sqlite';
import { useEffect, useState } from 'react';

/**
 * Like drizzle's `useLiveQuery`, but re-runs when any of `tables` changes. Drizzle's version only
 * watches the query's FROM table, so a join (e.g. phrases ⋈ outbox) goes stale when the joined
 * table is updated.
 */
export function useLiveQueryOn<T>(
  query: PromiseLike<T[]>,
  tables: SQLiteTable[],
  deps: unknown[] = [],
): { data: T[]; error: Error | undefined } {
  const [data, setData] = useState<T[]>([]);
  const [error, setError] = useState<Error>();

  useEffect(() => {
    let active = true;
    const run = () =>
      query.then(
        (rows) => active && setData(rows),
        (err: Error) => active && setError(err),
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

  return { data, error };
}
