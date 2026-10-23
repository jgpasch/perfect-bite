// Spec 4.4, quantity math: combining amounts. Pure. How they read (with i18n) is the app's
// `src/domain/quantity-math.ts`.
import type { Unit } from '../quantity-parser.ts';

/** An amount on a list item: a quantity (null: none given) and a unit (null: a count). */
export type Amount = { quantity: number | null; unit: Unit | null };

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

/**
 * One group of compatible amounts (from `groupAmounts`) as a single amount. Converted sums are in
 * the unit of the largest amount, rounded; null if rounding would hide an amount (they're listed
 * instead).
 */
export function combineGroup(amounts: Amount[]): Amount | null {
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

/** Units something is bought in, as opposed to cooking measures (`tbsp`, `cup`, `g`...). */
const BUYING_UNITS: ReadonlySet<Unit> = new Set<Unit>([
  'gal', 'qt', 'pt', 'l', 'lb', 'kg', 'dozen', 'can', 'jar', 'bag', 'box', 'bunch',
]);

/**
 * The unit an add with no amount counts as one of (spec 4.4): the ingredient's `usualUnit` when
 * it's a unit things are bought in (`gal` for milk), else a plain count. A usual unit from recipe
 * measures (`tbsp` for pistachios) would turn a bare `pistachios` into `1 tbsp`.
 */
export function noAmountUnit(usualUnit: Unit | null): Unit | null {
  return usualUnit !== null && BUYING_UNITS.has(usualUnit) ? usualUnit : null;
}

/** Groups amounts that can be summed, counting a null quantity as one of `noAmountUnit(usualUnit)`. */
export function groupAmounts(amounts: readonly Amount[], usualUnit: Unit | null): Amount[][] {
  const groups = new Map<string, Amount[]>();
  const unit = noAmountUnit(usualUnit);
  for (const a of amounts) {
    const counted = a.quantity === null ? { quantity: 1, unit } : a;
    const key = groupKey(counted);
    groups.set(key, [...(groups.get(key) ?? []), counted]);
  }
  return [...groups.values()];
}

/**
 * An item's amounts as the one amount they total, for the edit sheet's stepper: `2 lb + 8 oz` →
 * `2.5 lb`. Null when they don't make one amount (`2 cans + 400 g`, `1 cup + 1 tsp`). No amounts
 * at all, or one with no quantity, is 1 of `usualUnit`; alongside others a null quantity counts as
 * in `summarizeAmounts`.
 */
export function combineAmounts(amounts: readonly Amount[], usualUnit: Unit | null = null): Amount | null {
  if (amounts.length === 0 || (amounts.length === 1 && amounts[0].quantity === null)) {
    return { quantity: 1, unit: usualUnit };
  }
  const groups = groupAmounts(amounts, usualUnit);
  return groups.length === 1 ? combineGroup(groups[0]) : null;
}
