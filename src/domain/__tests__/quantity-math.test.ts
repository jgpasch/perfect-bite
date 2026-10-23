import { describe, expect, it } from '@jest/globals';

import type { Unit } from '@/shared';

import { combineAmounts, stepAmount, summarizeAmounts } from '../quantity-math';

const a = (quantity: number | null, unit: Unit | null = null) => ({ quantity, unit });

describe('summarizeAmounts', () => {
  it('shows nothing for no amounts or a single unspecified one', () => {
    expect(summarizeAmounts([])).toBe('');
    expect(summarizeAmounts([a(null)])).toBe('');
  });

  it('counts unspecified adds as one each when there are two or more amounts', () => {
    expect(summarizeAmounts([a(null), a(null)])).toBe('2');
    expect(summarizeAmounts([a(null), a(null), a(null)])).toBe('3');
    expect(summarizeAmounts([a(2), a(null)])).toBe('3');
    expect(summarizeAmounts([a(null), a(2)])).toBe('3');
    expect(summarizeAmounts([a(0.5), a(null)])).toBe('1½');
  });

  it('keeps an unspecified add apart from amounts with a unit', () => {
    expect(summarizeAmounts([a(2, 'can'), a(null)])).toBe('2 can + 1');
    expect(summarizeAmounts([a(2, 'lb'), a(8, 'oz'), a(null)])).toBe('2.5 lb + 1');
    expect(summarizeAmounts([a(1, 'gal'), a(null), a(null)])).toBe('1 gal + 2');
    expect(summarizeAmounts([a(3), a(1, 'dozen'), a(null)])).toBe('4 + 1 dozen');
  });

  it('sums the same unit exactly', () => {
    expect(summarizeAmounts([a(2), a(3)])).toBe('5');
    expect(summarizeAmounts([a(200, 'g'), a(300, 'g')])).toBe('500 g');
    expect(summarizeAmounts([a(1, 'can'), a(2, 'can')])).toBe('3 can');
    expect(summarizeAmounts([a(0.5, 'cup'), a(0.25, 'cup')])).toBe('¾ cup');
  });

  it('converts within a dimension, in the unit of the larger amount', () => {
    expect(summarizeAmounts([a(2, 'lb'), a(8, 'oz')])).toBe('2.5 lb');
    expect(summarizeAmounts([a(8, 'oz'), a(2, 'lb')])).toBe('2.5 lb');
    expect(summarizeAmounts([a(500, 'g'), a(1, 'kg')])).toBe('1.5 kg');
    expect(summarizeAmounts([a(1, 'gal'), a(1, 'qt')])).toBe('1¼ gal');
    expect(summarizeAmounts([a(1, 'lb'), a(500, 'g')])).toBe('954 g'); // 500 g is the larger
  });

  it('mixes metric and US customary', () => {
    expect(summarizeAmounts([a(1, 'lb'), a(1, 'kg')])).toBe('1.5 kg'); // 1 lb ≈ 0.45 kg
    expect(summarizeAmounts([a(1, 'cup'), a(250, 'ml')])).toBe('487 ml'); // 1 cup ≈ 237 ml
  });

  it('lists the amounts when rounding would hide one', () => {
    expect(summarizeAmounts([a(1, 'cup'), a(1, 'tsp')])).toBe('1 cup + 1 tsp');
    expect(summarizeAmounts([a(1, 'kg'), a(5, 'g')])).toBe('1 kg + 5 g');
  });

  it('shows incompatible units side by side', () => {
    expect(summarizeAmounts([a(2, 'can'), a(400, 'g')])).toBe('2 can + 400 g');
    expect(summarizeAmounts([a(1, 'lb'), a(1, 'cup')])).toBe('1 lb + 1 cup');
    expect(summarizeAmounts([a(3), a(1, 'dozen')])).toBe('3 + 1 dozen');
  });

  it('joins an unspecified add as 1', () => {
    expect(summarizeAmounts([a(1, 'gal'), a(null)])).toBe('1 gal + 1');
    expect(summarizeAmounts([a(null), a(2, 'lb'), a(8, 'oz')])).toBe('1 + 2.5 lb');
  });
});

describe('summarizeAmounts with a usual unit', () => {
  it('counts an unspecified add as one of the usual unit', () => {
    expect(summarizeAmounts([a(1, 'gal'), a(null)], 'gal')).toBe('2 gal');
    expect(summarizeAmounts([a(null), a(null)], 'gal')).toBe('2 gal');
    expect(summarizeAmounts([a(null), a(null), a(null)], 'can')).toBe('3 can');
    expect(summarizeAmounts([a(2, 'can'), a(null)], 'can')).toBe('3 can');
  });

  it('counts it as a unitless one when the usual unit is a count (null)', () => {
    expect(summarizeAmounts([a(1, 'gal'), a(null)], null)).toBe('1 gal + 1');
    expect(summarizeAmounts([a(2), a(null)], null)).toBe('3');
  });

  it('converts within the usual unit’s dimension', () => {
    expect(summarizeAmounts([a(8, 'oz'), a(null)], 'lb')).toBe('1.5 lb');
    expect(summarizeAmounts([a(1, 'qt'), a(null)], 'qt')).toBe('2 qt');
    expect(summarizeAmounts([a(500, 'ml'), a(null)], 'l')).toBe('1.5 l');
  });

  it('keeps the usual unit apart from an amount it can’t sum with', () => {
    expect(summarizeAmounts([a(400, 'g'), a(null)], 'can')).toBe('400 g + 1 can');
    expect(summarizeAmounts([a(2), a(null)], 'gal')).toBe('2 + 1 gal');
  });

  it('an add with no amount stays a plain count when the usual unit is a cooking measure', () => {
    // Pistachios usually measured by the tbsp in recipes: a bare `pistachios` isn't 1 tbsp.
    expect(summarizeAmounts([a(null), a(2, 'tbsp')], 'tbsp')).toBe('1 + 2 tbsp');
    expect(summarizeAmounts([a(null), a(null)], 'cup')).toBe('2');
    expect(summarizeAmounts([a(200, 'g'), a(null)], 'g')).toBe('200 g + 1');
    expect(summarizeAmounts([a(3), a(null)], 'tsp')).toBe('4');
  });

  it('still shows nothing for a lone unspecified add, whatever the usual unit', () => {
    expect(summarizeAmounts([a(null)], 'gal')).toBe('');
    expect(summarizeAmounts([a(null)], 'lb')).toBe('');
    expect(summarizeAmounts([a(null)], null)).toBe('');
    expect(summarizeAmounts([], 'gal')).toBe('');
  });

  it('leaves amounts that all have a quantity alone', () => {
    expect(summarizeAmounts([a(2, 'lb')], 'gal')).toBe('2 lb');
    expect(summarizeAmounts([a(2, 'can'), a(400, 'g')], 'can')).toBe('2 can + 400 g');
  });
});

describe('stepAmount', () => {
  it('steps each unit by its step size', () => {
    const cases: [Unit | null, number][] = [
      [null, 1],
      ['can', 1],
      ['jar', 1],
      ['bag', 1],
      ['box', 1],
      ['bunch', 1],
      ['clove', 1],
      ['pinch', 1],
      ['dozen', 1],
      ['oz', 1],
      ['fl oz', 1],
      ['pt', 1],
      ['qt', 1],
      ['gal', 1],
      ['lb', 0.5],
      ['kg', 0.5],
      ['l', 0.5],
      ['tsp', 0.5],
      ['tbsp', 0.5],
      ['cup', 0.25],
      ['g', 100],
      ['ml', 100],
    ];
    for (const [unit, size] of cases) {
      expect(stepAmount(a(size * 4, unit), 1)).toEqual(a(size * 5, unit));
      expect(stepAmount(a(size * 4, unit), -1)).toEqual(a(size * 3, unit));
    }
  });

  it('keeps the unit and ignores the usual unit when there is a quantity', () => {
    expect(stepAmount(a(2, 'lb'), 1, 'gal')).toEqual(a(2.5, 'lb'));
    expect(stepAmount(a(2), 1, 'gal')).toEqual(a(3));
  });

  it('returns null for − at or below one step', () => {
    expect(stepAmount(a(1), -1)).toBeNull();
    expect(stepAmount(a(0.5), -1)).toBeNull();
    expect(stepAmount(a(0.5, 'lb'), -1)).toBeNull();
    expect(stepAmount(a(0.25, 'cup'), -1)).toBeNull();
    expect(stepAmount(a(100, 'g'), -1)).toBeNull();
    expect(stepAmount(a(50, 'g'), -1)).toBeNull();
    expect(stepAmount(a(1, 'gal'), -1)).toBeNull();
  });

  it('goes down to exactly one step', () => {
    expect(stepAmount(a(2), -1)).toEqual(a(1));
    expect(stepAmount(a(1, 'lb'), -1)).toEqual(a(0.5, 'lb'));
    expect(stepAmount(a(200, 'g'), -1)).toEqual(a(100, 'g'));
  });

  it('never goes below one step from an amount off the grid', () => {
    expect(stepAmount(a(1.4), -1)).toEqual(a(1));
    expect(stepAmount(a(0.6, 'lb'), -1)).toEqual(a(0.5, 'lb'));
  });

  it('can step up from below one step', () => {
    expect(stepAmount(a(0.5), 1)).toEqual(a(2)); // 1.5 rounds half up
    expect(stepAmount(a(50, 'g'), 1)).toEqual(a(200, 'g'));
  });

  it('rounds to the step, with no float drift', () => {
    let cup = a(0.25, 'cup');
    for (let i = 0; i < 3; i++) cup = stepAmount(cup, 1)!;
    expect(cup.quantity).toBe(1);
    expect(cup.unit).toBe('cup');
    expect(stepAmount(a(0.1 + 0.2, 'cup'), 1)).toEqual(a(0.5, 'cup'));
    expect(stepAmount(a(2.3, 'lb'), 1)).toEqual(a(3, 'lb'));
    expect(stepAmount(a(2.3, 'lb'), -1)).toEqual(a(2, 'lb'));
    expect(stepAmount(a(250, 'g'), 1)).toEqual(a(400, 'g')); // 350 rounds half up
  });

  it('treats a null quantity as one of the usual unit', () => {
    expect(stepAmount(a(null), 1, 'gal')).toEqual(a(2, 'gal'));
    expect(stepAmount(a(null), 1, 'lb')).toEqual(a(1.5, 'lb'));
    expect(stepAmount(a(null), -1, 'lb')).toEqual(a(0.5, 'lb'));
    expect(stepAmount(a(null), -1, 'gal')).toBeNull();
  });

  it('treats a null quantity as a count of one with no usual unit', () => {
    expect(stepAmount(a(null), 1)).toEqual(a(2));
    expect(stepAmount(a(null), 1, null)).toEqual(a(2));
    expect(stepAmount(a(null), -1)).toBeNull();
  });

  it('does not mutate its input', () => {
    const amount = a(2, 'lb');
    stepAmount(amount, 1);
    expect(amount).toEqual(a(2, 'lb'));
  });
});

describe('combineAmounts', () => {
  it('returns a single amount as is', () => {
    expect(combineAmounts([a(2, 'lb')])).toEqual(a(2, 'lb'));
    expect(combineAmounts([a(3)])).toEqual(a(3));
  });

  it('sums the same unit', () => {
    expect(combineAmounts([a(1, 'gal'), a(2, 'gal')])).toEqual(a(3, 'gal'));
    expect(combineAmounts([a(2), a(null)])).toEqual(a(3));
  });

  it('converts within a dimension', () => {
    expect(combineAmounts([a(2, 'lb'), a(8, 'oz')])).toEqual(a(2.5, 'lb'));
  });

  it('returns null when the total is not one amount', () => {
    expect(combineAmounts([a(2, 'can'), a(400, 'g')])).toBeNull();
    expect(combineAmounts([a(1, 'cup'), a(1, 'tsp')])).toBeNull(); // rounding would hide the tsp
    expect(combineAmounts([a(1, 'gal'), a(null)])).toBeNull();
  });

  it('counts null quantities as the usual unit', () => {
    expect(combineAmounts([a(1, 'gal'), a(null)], 'gal')).toEqual(a(2, 'gal'));
    expect(combineAmounts([a(8, 'oz'), a(null)], 'lb')).toEqual(a(1.5, 'lb'));
    expect(combineAmounts([a(null)], 'gal')).toEqual(a(1, 'gal'));
    expect(combineAmounts([a(null)])).toEqual(a(1));
    expect(combineAmounts([a(null)], 'tbsp')).toEqual(a(1, 'tbsp')); // a lone add steps from the usual unit
    expect(combineAmounts([a(2, 'tbsp'), a(null)], 'tbsp')).toBeNull();
  });

  it('is one of the usual unit, or a count of one, for no amounts', () => {
    expect(combineAmounts([], 'gal')).toEqual(a(1, 'gal'));
    expect(combineAmounts([])).toEqual(a(1));
  });
});
