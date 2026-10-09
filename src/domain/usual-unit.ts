// Spec 4.2, 4.4: the unit a household usually buys an ingredient in, from `ingredient_unit_usage`
// rows. Pure.
import { UNITS, type Unit } from '@/shared';

/** `unit_key` for a quantity with no unit. */
export const COUNT_KEY = 'count';

export type UnitUsageRow = {
  unitKey: string;
  useCount: number;
  lastUsedAt: Date;
};

/** The `unit_key` stored for a unit: the unit itself, or `'count'` for none. */
export function unitKey(unit: Unit | null): string {
  return unit ?? COUNT_KEY;
}

/** The inverse of `unitKey`: `null` for `'count'`, `undefined` for a key it doesn't know. */
export function unitFromKey(key: string): Unit | null | undefined {
  if (key === COUNT_KEY) return null;
  return (UNITS as readonly string[]).includes(key) ? (key as Unit) : undefined;
}

/**
 * The most used unit: highest `useCount`, then latest `lastUsedAt`, then the alphabetically first
 * key. `null` means a plain count; `undefined` means nothing is known (no rows, all zero, or only
 * unknown keys).
 */
export function usualUnit(rows: readonly UnitUsageRow[]): Unit | null | undefined {
  let best: UnitUsageRow | undefined;
  for (const row of rows) {
    if (row.useCount <= 0 || unitFromKey(row.unitKey) === undefined) continue;
    if (!best || compare(row, best) < 0) best = row;
  }
  return best && unitFromKey(best.unitKey);
}

/** Negative when `a` ranks ahead of `b`. */
function compare(a: UnitUsageRow, b: UnitUsageRow): number {
  if (a.useCount !== b.useCount) return b.useCount - a.useCount;
  const time = b.lastUsedAt.getTime() - a.lastUsedAt.getTime();
  if (time !== 0) return time;
  return a.unitKey < b.unitKey ? -1 : a.unitKey > b.unitKey ? 1 : 0;
}
