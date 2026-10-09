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
 * One group of compatible amounts as a single amount. Converted sums are in the unit of the
 * largest amount, rounded; null if rounding would hide an amount (they're listed instead).
 */
function combineGroup(amounts: Amount[]): Amount | null {
  if (amounts.length === 1) return { quantity: amounts[0].quantity, unit: amounts[0].unit };
  const units = new Set(amounts.map((a) => a.unit));
  if (units.size === 1) {
    // Same unit: an exact sum, no rounding needed.
    return { quantity: amounts.reduce((sum, a) => sum + a.quantity!, 0), unit: amounts[0].unit };
  }
  const inBase = (a: Amount) => a.quantity! * BASE[a.unit!]!.size;
  const largest = amounts.reduce((max, a) => (inBase(a) > inBase(max) ? a : max));
  const size = BASE[largest.unit!]!.size;
  const total = amounts.reduce((sum, a) => sum + inBase(a), 0) / size;
  const rounded = roundTo(total, largest.unit);
  const withoutSmaller = roundTo(inBase(largest) / size, largest.unit);
  const hidesAmount = rounded === withoutSmaller || rounded === 0;
  return hidesAmount ? null : { quantity: rounded, unit: largest.unit };
}

/** One group of compatible amounts as text: the combined amount, or each amount listed. */
function formatGroup(amounts: Amount[]): string {
  const combined = combineGroup(amounts);
  if (combined) return format(combined.quantity!, combined.unit);
  return amounts.map((a) => format(a.quantity!, a.unit)).join(' + ');
}

/** Groups amounts that can be summed, counting a null quantity as one of `usualUnit`. */
function groupAmounts(amounts: readonly Amount[], usualUnit: Unit | null): Amount[][] {
  const groups = new Map<string, Amount[]>();
  for (const a of amounts) {
    const counted = a.quantity === null ? { quantity: 1, unit: usualUnit } : a;
    const key = groupKey(counted);
    groups.set(key, [...(groups.get(key) ?? []), counted]);
  }
  return [...groups.values()];
}

/**
 * How an item's amounts read on its row (spec 4.4): `2 lb + 8 oz` → `2.5 lb`;
 * `1 cup + 1 tsp` → `1 cup + 1 tsp`; `2 cans + 400 g` → `2 cans + 400 g`. Alongside other
 * amounts, an add with no amount counts as one of the ingredient's `usualUnit` (spec 4.2), or one
 * with no unit when that's null: `milk` twice → `2`, `2` and an add with no amount → `3`, `1 gal`
 * and an add with no amount → `1 gal + 1`, or `2 gal` when milk is usually bought by the gallon.
 * A single add with no amount → empty.
 */
export function summarizeAmounts(amounts: readonly Amount[], usualUnit: Unit | null = null): string {
  if (amounts.length === 0) return '';
  if (amounts.length === 1 && amounts[0].quantity === null) return '';
  return groupAmounts(amounts, usualUnit).map(formatGroup).join(' + ');
}

/**
 * An item's amounts as the one amount they total, for the edit sheet's stepper: `2 lb + 8 oz` →
 * `2.5 lb`. Null when they don't make one amount (`2 cans + 400 g`, `1 cup + 1 tsp`). A null
 * quantity counts as one of `usualUnit`, so no amounts at all, or one with no quantity, is 1 of it.
 */
export function combineAmounts(amounts: readonly Amount[], usualUnit: Unit | null = null): Amount | null {
  if (amounts.length === 0) return { quantity: 1, unit: usualUnit };
  const groups = groupAmounts(amounts, usualUnit);
  return groups.length === 1 ? combineGroup(groups[0]) : null;
}

/** How far the stepper moves each unit (spec 4.4). A count steps by 1. */
function stepSize(unit: Unit | null): number {
  switch (unit) {
    case 'lb':
    case 'kg':
    case 'l':
    case 'tsp':
    case 'tbsp':
      return 0.5;
    case 'cup':
      return 0.25;
    case 'g':
    case 'ml':
      return 100;
    default:
      return 1;
  }
}

/**
 * The edit sheet's − / + (spec 4.4): one step up or down, rounded to the step (`2.3 lb` + →
 * `3 lb`). A null quantity is 1 of `usualUnit` (a count if none), so + on `milk` usually bought
 * by the gallon gives `2 gal`. Returns null for − when the amount is already one step or less:
 * it can't go lower.
 */
export function stepAmount(amount: Amount, direction: 1 | -1, usualUnit: Unit | null = null): Amount | null {
  const { quantity, unit } = amount.quantity === null ? { quantity: 1, unit: amount.unit ?? usualUnit } : amount;
  const s = stepSize(unit);
  if (direction === -1 && quantity! <= s) return null;
  const stepped = Math.round((quantity! + direction * s) / s) * s;
  return { quantity: Math.max(stepped, s), unit };
}
