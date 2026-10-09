// How an item's amount reads on its row. M1 joins contributions as they are; M3 adds the
// quantity math and display rule (spec 4.4).

import type { Unit } from '@/shared';

export type Amount = { quantity: number | null; unit: Unit | null };

const FRACTIONS: [number, string][] = [
  [1 / 8, '⅛'],
  [1 / 4, '¼'],
  [1 / 3, '⅓'],
  [1 / 2, '½'],
  [2 / 3, '⅔'],
  [3 / 4, '¾'],
];

/** `1.5` → `1½`, `0.25` → `¼`, `2.4` → `2.4`. */
export function formatNumber(n: number): string {
  const whole = Math.floor(n);
  const fraction = FRACTIONS.find(([value]) => Math.abs(n - whole - value) < 0.01);
  if (fraction) return `${whole === 0 ? '' : whole}${fraction[1]}`;
  return String(Math.round(n * 100) / 100);
}

/** `2 lb`, `3`, `1 dozen`; empty when there is no quantity. */
export function formatAmount({ quantity, unit }: Amount): string {
  if (quantity === null) return '';
  return unit ? `${formatNumber(quantity)} ${unit}` : formatNumber(quantity);
}

/**
 * All of an item's contributions: `2 lb`; `1 gal + 1` (a second add with no amount counts as 1);
 * empty for a single add with no amount.
 */
export function formatAmounts(amounts: readonly Amount[]): string {
  if (amounts.length === 0) return '';
  if (amounts.length === 1) return formatAmount(amounts[0]);
  if (amounts.every((a) => a.quantity === null)) return '';
  return amounts.map((a) => formatAmount(a) || '1').join(' + ');
}
