// Spec 4.2, 4.4: the unit a household usually buys an ingredient in, from `ingredient_unit_usage`
// rows, falling back to the catalog's default unit. Pure.
import { UNITS, type Unit } from '../quantity-parser.ts';

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

/**
 * The usual unit with the catalog's default unit (`ingredients.default_unit`, a `unit_key`) as the
 * fallback: household history wins, and the default applies until there is some. Same return as
 * `usualUnit`; an unknown default key counts as nothing known.
 */
export function withDefaultUnit(
  known: Unit | null | undefined,
  defaultUnitKey: string | null | undefined,
): Unit | null | undefined {
  if (known !== undefined) return known;
  return defaultUnitKey == null ? undefined : unitFromKey(defaultUnitKey);
}

/**
 * The usual unit of each ingredient key in `rows` (`ingredient_unit_usage` rows for one
 * household). Keys with nothing known (`usualUnit` is undefined) are left out.
 */
export function usualUnitsByKey(
  rows: readonly (UnitUsageRow & { ingredientName: string })[],
): Map<string, Unit | null> {
  const byKey = new Map<string, UnitUsageRow[]>();
  for (const row of rows) byKey.set(row.ingredientName, [...(byKey.get(row.ingredientName) ?? []), row]);
  const result = new Map<string, Unit | null>();
  for (const [key, keyRows] of byKey) {
    const unit = usualUnit(keyRows);
    if (unit !== undefined) result.set(key, unit);
  }
  return result;
}

/** Negative when `a` ranks ahead of `b`. */
function compare(a: UnitUsageRow, b: UnitUsageRow): number {
  if (a.useCount !== b.useCount) return b.useCount - a.useCount;
  const time = b.lastUsedAt.getTime() - a.lastUsedAt.getTime();
  if (time !== 0) return time;
  return a.unitKey < b.unitKey ? -1 : a.unitKey > b.unitKey ? 1 : 0;
}
