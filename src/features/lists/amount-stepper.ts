// The item edit sheet's amount controls (spec 4.4): the number field, the unit menu and the
// − / + stepper. Pure helpers for the screen.

import { formatNumber, type Amount } from '@/domain/quantity-display';
import { stepAmount } from '@/domain/quantity-math';
import { parseAmount, type Unit } from '@/shared';

/** The unit menu's groups, in menu order. Every supported unit (spec 4.2) is in exactly one. */
export const UNIT_GROUPS: readonly { title: string; units: readonly (Unit | null)[] }[] = [
  { title: 'Count', units: [null] },
  { title: 'Weight', units: ['g', 'kg', 'oz', 'lb'] },
  { title: 'Volume', units: ['ml', 'l', 'tsp', 'tbsp', 'cup', 'fl oz', 'pt', 'qt', 'gal'] },
  { title: 'Packages', units: ['can', 'jar', 'bag', 'box', 'bunch', 'clove', 'pinch', 'dozen'] },
];

/** `lb` → `lb`; no unit → `Count`. */
export function unitLabel(unit: Unit | null): string {
  return unit ?? 'Count';
}

export type UnitMenuItem = { unit: Unit | null; label: string; checked: boolean; usual: boolean };
export type UnitMenuSection = { title: string | null; items: UnitMenuItem[] };

/**
 * The unit menu: the ingredient's usual unit first in a section of its own (marked usual), then
 * the groups without it, with `current` ticked. `usual` undefined means no usual unit is known;
 * null means a plain count is usual.
 */
export function unitMenuSections(current: Unit | null, usual: Unit | null | undefined): UnitMenuSection[] {
  const item = (unit: Unit | null): UnitMenuItem => ({
    unit,
    label: unitLabel(unit),
    checked: unit === current,
    usual: unit === usual,
  });
  const groups = UNIT_GROUPS.map((g) => ({
    title: g.title,
    items: g.units.filter((u) => u !== usual).map(item),
  })).filter((g) => g.items.length > 0);
  return usual === undefined ? groups : [{ title: null, items: [item(usual)] }, ...groups];
}

/**
 * The amount in another unit, keeping the number: `2 lb` → `2 kg`. It doesn't convert. A null
 * quantity is 1. Null when the unit doesn't change, so nothing needs saving.
 */
export function withUnit(amount: Amount, unit: Unit | null): Amount | null {
  if (amount.quantity !== null && amount.unit === unit) return null;
  return { quantity: amount.quantity ?? 1, unit };
}

/** Whether − can step `amount` down (it's more than one step). */
export function canStepDown(amount: Amount, usualUnit: Unit | null = null): boolean {
  return stepAmount(amount, -1, usualUnit) !== null;
}

/** The number field's text for a quantity, in decimals for the keypad: `1.5`; none → empty. */
export function quantityText(quantity: number | null): string {
  return quantity === null ? '' : formatNumber(quantity, true);
}

/**
 * What typing `text` in the number field saves, given the `shown` amount (its quantity is null
 * when the item has no amount): the number in the shown unit, or no amount for an empty field.
 * Null when nothing changes; undefined when the text isn't a number (`lb`, `0`, `-2`).
 */
export function typedAmount(text: string, shown: Amount): Amount | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return shown.quantity === null ? null : { quantity: null, unit: null };
  // A decimal comma (`1,5`) from the keypad in some regions.
  const parsed = parseAmount(trimmed.replace(/^(\d+),(\d+)$/, '$1.$2'));
  if (!parsed || parsed.unit !== null || parsed.quantity === null) return undefined;
  if (!Number.isFinite(parsed.quantity) || parsed.quantity <= 0) return undefined;
  if (parsed.quantity === shown.quantity) return null;
  return { quantity: parsed.quantity, unit: shown.unit };
}
