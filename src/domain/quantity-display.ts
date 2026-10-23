// Formatting a single amount. Summing an item's amounts is quantity-math.ts (spec 4.4).

import { unitName } from '@/i18n/vocabulary';
import type { Unit } from '@/shared';
import type { Amount } from '@/shared/domain/quantity-math';

export type { Amount };

const FRACTIONS: [number, string][] = [
  [1 / 8, '⅛'],
  [1 / 4, '¼'],
  [1 / 3, '⅓'],
  [1 / 2, '½'],
  [2 / 3, '⅔'],
  [3 / 4, '¾'],
];

/** Units read in decimals (`1.5 lb`); the rest use fractions (`1½ cups`). */
const DECIMAL_UNITS = new Set<Unit>(['g', 'kg', 'oz', 'lb', 'ml', 'l', 'fl oz']);

/** `1.5` → `1½`, `0.25` → `¼`, `2.4` → `2.4`; with `decimal`, `1.5` → `1.5`. */
export function formatNumber(n: number, decimal = false): string {
  if (decimal) return String(Math.round(n * 100) / 100);
  const whole = Math.floor(n);
  const fraction = FRACTIONS.find(([value]) => Math.abs(n - whole - value) < 0.01);
  if (fraction) return `${whole === 0 ? '' : whole}${fraction[1]}`;
  return String(Math.round(n * 100) / 100);
}

/** `2 lb`, `3`, `1 dozen` (*2 tazas* in Spanish); empty when there is no quantity. */
export function formatAmount({ quantity, unit }: Amount): string {
  if (quantity === null) return '';
  if (!unit) return formatNumber(quantity);
  return `${formatNumber(quantity, DECIMAL_UNITS.has(unit))} ${unitName(unit, quantity)}`;
}
