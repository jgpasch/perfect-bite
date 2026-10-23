// Spec 4.4, quantity display rule and the edit sheet's stepper. Pure: no React, SQLite or network.
// Combining amounts is shared with the server: `src/shared/domain/quantity-math.ts`.

import type { Unit } from '@/shared';
import { combineGroup, groupAmounts, type Amount } from '@/shared/domain/quantity-math';

import { formatAmount } from './quantity-display';

export { combineAmounts, noAmountUnit } from '@/shared/domain/quantity-math';

function format(quantity: number, unit: Unit | null): string {
  return formatAmount({ quantity, unit });
}

/** One group of compatible amounts as text: the combined amount, or each amount listed. */
function formatGroup(amounts: Amount[]): string {
  const combined = combineGroup(amounts);
  if (combined) return format(combined.quantity!, combined.unit);
  return amounts.map((a) => format(a.quantity!, a.unit)).join(' + ');
}

/**
 * How an item's amounts read on its row (spec 4.4): `2 lb + 8 oz` → `2.5 lb`;
 * `1 cup + 1 tsp` → `1 cup + 1 tsp`; `2 cans + 400 g` → `2 cans + 400 g`. Alongside other
 * amounts, an add with no amount counts as one of the ingredient's `usualUnit` (spec 4.2) when
 * that's a unit things are bought in (`noAmountUnit`), else one with no unit: `milk` twice → `2`,
 * `2` and an add with no amount → `3`, `1 gal` and an add with no amount → `1 gal + 1`, or `2 gal`
 * when milk is usually bought by the gallon; `2 tbsp` and an add with no amount → `1 + 2 tbsp`
 * even when tbsp is usual. A single add with no amount → empty.
 */
export function summarizeAmounts(amounts: readonly Amount[], usualUnit: Unit | null = null): string {
  if (amounts.length === 0) return '';
  if (amounts.length === 1 && amounts[0].quantity === null) return '';
  return groupAmounts(amounts, usualUnit).map(formatGroup).join(' + ');
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
