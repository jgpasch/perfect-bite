import { describe, expect, it } from '@jest/globals';

import type { Unit } from '@/shared';

import { kitchenRound } from '../kitchen-round';
import { formatAmount } from '../quantity-display';

const round = (quantity: number, unit: Unit | null = null) => kitchenRound({ quantity, unit });
const text = (quantity: number, unit: Unit | null = null) => formatAmount(round(quantity, unit));

describe('kitchenRound', () => {
  it('rounds cups to the nearest ¼, ⅓, ½, ⅔ or ¾', () => {
    expect(round(0.42, 'cup')).toEqual({ quantity: 0.5, unit: 'cup' });
    expect(text(0.3, 'cup')).toBe('⅓ cup');
    expect(text(0.25, 'cup')).toBe('¼ cup');
    expect(text(0.7, 'cup')).toBe('⅔ cup');
    expect(text(0.74, 'cup')).toBe('¾ cup');
    expect(text(1.6, 'cup')).toBe('1⅔ cup');
    expect(text(1.1, 'cup')).toBe('1 cup');
    expect(text(2.9, 'cup')).toBe('3 cup');
  });

  it('turns under ¼ cup into tablespoons, 16 to a cup', () => {
    expect(round(0.125, 'cup')).toEqual({ quantity: 2, unit: 'tbsp' });
    expect(text(0.2, 'cup')).toBe('3 tbsp');
    expect(text(0.1, 'cup')).toBe('1½ tbsp');
    // 3.84 tbsp rounds to 4, which is ¼ cup again.
    expect(text(0.24, 'cup')).toBe('¼ cup');
    // 0.8 tbsp is under 1, so teaspoons: 2.4 → 2½.
    expect(text(0.05, 'cup')).toBe('2½ tsp');
  });

  it('rounds tablespoons to the nearest ½', () => {
    expect(round(1.3, 'tbsp')).toEqual({ quantity: 1.5, unit: 'tbsp' });
    expect(text(2.2, 'tbsp')).toBe('2 tbsp');
    expect(text(2.75, 'tbsp')).toBe('3 tbsp');
    expect(text(1, 'tbsp')).toBe('1 tbsp');
  });

  it('turns under 1 tbsp into teaspoons, 3 to a tbsp', () => {
    expect(round(0.5, 'tbsp')).toEqual({ quantity: 1.5, unit: 'tsp' });
    expect(text(0.7, 'tbsp')).toBe('2 tsp');
    expect(text(0.75, 'tbsp')).toBe('2¼ tsp');
    expect(text(0.01, 'tbsp')).toBe('⅛ tsp');
  });

  it('turns 3 tbsp or more into cups only on a clean cup fraction', () => {
    expect(round(4, 'tbsp')).toEqual({ quantity: 0.25, unit: 'cup' });
    expect(text(8.2, 'tbsp')).toBe('½ cup');
    expect(text(12, 'tbsp')).toBe('¾ cup');
    expect(text(16, 'tbsp')).toBe('1 cup');
    expect(text(24, 'tbsp')).toBe('1½ cup');
    // ⅜, 3/16 and 4.5/16 cup aren't clean fractions.
    expect(text(6, 'tbsp')).toBe('6 tbsp');
    expect(text(3, 'tbsp')).toBe('3 tbsp');
    expect(text(4.5, 'tbsp')).toBe('4½ tbsp');
    // Under 3 never becomes cups.
    expect(text(2, 'tbsp')).toBe('2 tbsp');
  });

  it('rounds teaspoons to the nearest ¼, with ⅛ the smallest', () => {
    expect(round(1.3, 'tsp')).toEqual({ quantity: 1.25, unit: 'tsp' });
    expect(text(1.4, 'tsp')).toBe('1½ tsp');
    expect(text(0.2, 'tsp')).toBe('¼ tsp');
    expect(text(0.18, 'tsp')).toBe('⅛ tsp');
    expect(text(0.125, 'tsp')).toBe('⅛ tsp');
    expect(text(0.01, 'tsp')).toBe('⅛ tsp');
    // Teaspoons stay teaspoons.
    expect(text(4, 'tsp')).toBe('4 tsp');
  });

  it('rounds grams to 5, and to 10 from 100 up', () => {
    expect(round(33.33, 'g')).toEqual({ quantity: 35, unit: 'g' });
    expect(text(31, 'g')).toBe('30 g');
    expect(text(97, 'g')).toBe('95 g');
    expect(text(100, 'g')).toBe('100 g');
    expect(text(104, 'g')).toBe('100 g');
    expect(text(106, 'g')).toBe('110 g');
    expect(text(1, 'g')).toBe('5 g');
  });

  it('rounds ounces and pounds to the nearest ¼', () => {
    expect(round(1.1, 'oz')).toEqual({ quantity: 1, unit: 'oz' });
    expect(text(1.2, 'oz')).toBe('1.25 oz');
    expect(text(0.05, 'oz')).toBe('0.25 oz');
    expect(text(1.4, 'lb')).toBe('1.5 lb');
    expect(text(1 / 3, 'lb')).toBe('0.25 lb');
    expect(text(0.01, 'lb')).toBe('0.25 lb');
  });

  it('rounds ml to 5', () => {
    expect(round(12, 'ml')).toEqual({ quantity: 10, unit: 'ml' });
    expect(text(13, 'ml')).toBe('15 ml');
    expect(text(62.5, 'ml')).toBe('65 ml');
    expect(text(1, 'ml')).toBe('5 ml');
  });

  it('rounds a count to the nearest ½, never below ½', () => {
    expect(round(8 / 3)).toEqual({ quantity: 2.5, unit: null });
    expect(text(2.8)).toBe('3');
    expect(text(1.5)).toBe('1½');
    expect(text(0.25)).toBe('½');
    expect(text(0.1)).toBe('½');
  });

  it('rounds any other unit to 2 significant figures', () => {
    expect(round(4 / 3, 'can')).toEqual({ quantity: 1.3, unit: 'can' });
    expect(round(1.234, 'kg')).toEqual({ quantity: 1.2, unit: 'kg' });
    expect(round(1 / 3, 'gal')).toEqual({ quantity: 0.33, unit: 'gal' });
    expect(round(12.34, 'dozen')).toEqual({ quantity: 12, unit: 'dozen' });
    expect(round(0.25, 'pinch')).toEqual({ quantity: 0.25, unit: 'pinch' });
    expect(round(0.001, 'clove')).toEqual({ quantity: 0.001, unit: 'clove' });
  });

  it('never rounds anything to 0', () => {
    for (const unit of [null, 'cup', 'tbsp', 'tsp', 'g', 'oz', 'lb', 'ml', 'kg', 'can'] as const) {
      expect(round(0.0001, unit).quantity).toBeGreaterThan(0);
    }
  });

  it('leaves no quantity, and a zero one, as it is', () => {
    expect(kitchenRound({ quantity: null, unit: 'cup' })).toEqual({ quantity: null, unit: 'cup' });
    expect(kitchenRound({ quantity: null, unit: null })).toEqual({ quantity: null, unit: null });
    expect(kitchenRound({ quantity: 0, unit: 'g' })).toEqual({ quantity: 0, unit: 'g' });
  });
});
