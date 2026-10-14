// Spec 4.5, scaled servings: a scaled amount rounded to something you'd measure. Pure.

import type { Amount } from './quantity-display';

/** The cup fractions a scaled amount lands on, within each whole cup. */
const CUP_STEPS = [0, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 1];

const TBSP_PER_CUP = 16;
const TSP_PER_TBSP = 3;

/** `n` to the nearest `step`, never below `min`. */
function nearest(n: number, step: number, min = step): number {
  return Math.max(Math.round(n / step) * step, min);
}

/** `n` cups to the nearest whole plus one of `CUP_STEPS`. */
function nearestCup(n: number): number {
  const whole = Math.floor(n);
  return CUP_STEPS.map((s) => whole + s).reduce((best, c) => (Math.abs(c - n) < Math.abs(best - n) ? c : best));
}

function isCleanCup(cups: number): boolean {
  const fraction = cups - Math.floor(cups);
  return CUP_STEPS.some((s) => Math.abs(fraction - s) < 1e-9);
}

function teaspoons(n: number): Amount {
  return { quantity: n < 3 / 16 ? 1 / 8 : nearest(n, 1 / 4), unit: 'tsp' };
}

function tablespoons(n: number): Amount {
  if (n < 1) return teaspoons(n * TSP_PER_TBSP);
  const tbsp = nearest(n, 1 / 2);
  if (tbsp >= 3 && isCleanCup(tbsp / TBSP_PER_CUP)) return { quantity: tbsp / TBSP_PER_CUP, unit: 'cup' };
  return { quantity: tbsp, unit: 'tbsp' };
}

function cups(n: number): Amount {
  if (n < 1 / 4) return tablespoons(n * TBSP_PER_CUP);
  return { quantity: nearestCup(n), unit: 'cup' };
}

/**
 * A scaled amount rounded to a kitchen measure (spec 4.5): `0.42 cup` → `½ cup` (nearest ¼, ⅓, ½, ⅔
 * or ¾), under ¼ cup in tablespoons, tablespoons to the ½ (under 1 in teaspoons; 3 or more back to
 * cups when that's a clean cup fraction), teaspoons to the ¼ (⅛ at the least), grams to 5 (10 from
 * 100), ounces and pounds to the ¼, ml to 5, a count to the ½ (½ at the least), any other unit to 2
 * significant figures. Nothing rounds to 0. Only for scaled amounts: a recipe's own are shown as written.
 */
export function kitchenRound(amount: Amount): Amount {
  const { quantity: q, unit } = amount;
  if (q === null || q <= 0) return amount;
  switch (unit) {
    case 'cup':
      return cups(q);
    case 'tbsp':
      return tablespoons(q);
    case 'tsp':
      return teaspoons(q);
    case 'g':
      return { quantity: q >= 100 ? nearest(q, 10) : nearest(q, 5), unit };
    case 'oz':
    case 'lb':
      return { quantity: nearest(q, 1 / 4), unit };
    case 'ml':
      return { quantity: nearest(q, 5), unit };
    case null:
      return { quantity: nearest(q, 1 / 2), unit };
    default:
      return { quantity: Number(q.toPrecision(2)), unit };
  }
}
