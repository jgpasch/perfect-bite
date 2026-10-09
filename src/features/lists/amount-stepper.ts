// The item edit sheet's − / + stepper and unit picker (spec 4.4). Pure helpers for the screen.

import type { Amount } from '@/domain/quantity-display';
import { stepAmount } from '@/domain/quantity-math';
import { UNITS, type Unit } from '@/shared';

/** The unit picker's choices, in menu order: Count (no unit) first, then every unit. */
export const UNIT_CHOICES: readonly (Unit | null)[] = [null, ...UNITS];

/** `lb` → `lb`; no unit → `Count`. */
export function unitLabel(unit: Unit | null): string {
  return unit ?? 'Count';
}

/** The unit picker's `ActionSheetIOS` options: every choice, then Cancel. */
export function unitMenuOptions(): { options: string[]; cancelButtonIndex: number } {
  return { options: [...UNIT_CHOICES.map(unitLabel), 'Cancel'], cancelButtonIndex: UNIT_CHOICES.length };
}

/** The unit picked at `index` in `unitMenuOptions`, or undefined for Cancel. */
export function unitMenuChoice(index: number): Unit | null | undefined {
  return Number.isInteger(index) && index >= 0 && index < UNIT_CHOICES.length ? UNIT_CHOICES[index] : undefined;
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
