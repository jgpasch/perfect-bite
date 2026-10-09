// Spec 4.4, quantity math and display rule. Pure: no React, SQLite or network.

import type { Unit } from '@/shared';

import { formatAmount, type Amount } from './quantity-display';

type Dimension = 'mass' | 'volume';

/** Size of each convertible unit in its dimension's base (grams, millilitres). */
const BASE: Partial<Record<Unit, { dimension: Dimension; size: number }>> = {
  g: { dimension: 'mass', size: 1 },
  kg: { dimension: 'mass', size: 1000 },
  oz: { dimension: 'mass', size: 28.349523125 },
  lb: { dimension: 'mass', size: 453.59237 },
  ml: { dimension: 'volume', size: 1 },
  l: { dimension: 'volume', size: 1000 },
  tsp: { dimension: 'volume', size: 4.92892159375 },
  tbsp: { dimension: 'volume', size: 14.78676478125 },
  'fl oz': { dimension: 'volume', size: 29.5735295625 },
  cup: { dimension: 'volume', size: 236.5882365 },
  pt: { dimension: 'volume', size: 473.176473 },
  qt: { dimension: 'volume', size: 946.352946 },
  gal: { dimension: 'volume', size: 3785.411784 },
};

/** Friendly rounding step per unit (spec 4.4): ¼ for cooking measures, 0.1 for big metric/US, whole otherwise. */
function step(unit: Unit | null): number {
  switch (unit) {
    case 'cup':
    case 'tsp':
    case 'tbsp':
    case 'pt':
    case 'qt':
    case 'gal':
      return 0.25;
    case 'lb':
    case 'kg':
    case 'l':
    case 'oz':
    case 'fl oz':
      return 0.1;
    default:
      return 1;
  }
}

function roundTo(n: number, unit: Unit | null): number {
  const s = step(unit);
  return Math.round(n / s) * s;
}

/** Which amounts can be summed together: same unit, or same dimension. */
function groupKey(a: Amount): string {
  const base = a.unit ? BASE[a.unit] : undefined;
  return base ? base.dimension : `unit:${a.unit ?? ''}`;
}

function format(quantity: number, unit: Unit | null): string {
  return formatAmount({ quantity, unit });
}

/**
 * One group of compatible amounts as text. Converted sums show in the unit of the largest
 * amount, rounded; if rounding would hide an amount, the amounts are listed instead.
 */
function formatGroup(amounts: Amount[]): string {
  if (amounts.length === 1) return format(amounts[0].quantity!, amounts[0].unit);
  const units = new Set(amounts.map((a) => a.unit));
  if (units.size === 1) {
    // Same unit: an exact sum, no rounding needed.
    const unit = amounts[0].unit;
    return format(
      amounts.reduce((sum, a) => sum + a.quantity!, 0),
      unit,
    );
  }
  const inBase = (a: Amount) => a.quantity! * BASE[a.unit!]!.size;
  const largest = amounts.reduce((max, a) => (inBase(a) > inBase(max) ? a : max));
  const size = BASE[largest.unit!]!.size;
  const total = amounts.reduce((sum, a) => sum + inBase(a), 0) / size;
  const rounded = roundTo(total, largest.unit);
  const withoutSmaller = roundTo(inBase(largest) / size, largest.unit);
  const hidesAmount = rounded === withoutSmaller || rounded === 0;
  if (hidesAmount) return amounts.map((a) => format(a.quantity!, a.unit)).join(' + ');
  return format(rounded, largest.unit);
}

/**
 * How an item's amounts read on its row (spec 4.4): `2 lb + 8 oz` → `2.5 lb`;
 * `1 cup + 1 tsp` → `1 cup + 1 tsp`; `2 cans + 400 g` → `2 cans + 400 g`. Alongside other
 * amounts, an add with no amount counts as one with no unit: `milk` twice → `2`, `2` and an add
 * with no amount → `3`, `1 gal` and an add with no amount → `1 gal + 1`. A single add with no
 * amount → empty.
 */
export function summarizeAmounts(amounts: readonly Amount[]): string {
  if (amounts.length === 0) return '';
  if (amounts.length === 1 && amounts[0].quantity === null) return '';
  const groups = new Map<string, Amount[]>();
  for (const a of amounts) {
    const counted = a.quantity === null ? { quantity: 1, unit: null } : a;
    const key = groupKey(counted);
    groups.set(key, [...(groups.get(key) ?? []), counted]);
  }
  return [...groups.values()].map(formatGroup).join(' + ');
}
