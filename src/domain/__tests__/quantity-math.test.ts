import { describe, expect, it } from '@jest/globals';

import type { Unit } from '@/shared';

import { summarizeAmounts } from '../quantity-math';

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
