import { describe, expect, test } from '@jest/globals';

import { UNITS } from '@/shared';

import { canStepDown, UNIT_CHOICES, unitLabel, unitMenuChoice, unitMenuOptions, withUnit } from '../amount-stepper';

describe('unitLabel', () => {
  test('a unit reads as itself', () => {
    expect(unitLabel('lb')).toBe('lb');
    expect(unitLabel('fl oz')).toBe('fl oz');
  });

  test('no unit reads Count', () => {
    expect(unitLabel(null)).toBe('Count');
  });
});

describe('unitMenuOptions', () => {
  test('lists Count, every unit, then Cancel', () => {
    const { options, cancelButtonIndex } = unitMenuOptions();
    expect(options).toEqual(['Count', ...UNITS, 'Cancel']);
    expect(options).toHaveLength(UNITS.length + 2);
    expect(cancelButtonIndex).toBe(UNITS.length + 1);
    expect(options[cancelButtonIndex]).toBe('Cancel');
  });

  test('labels line up with the choices', () => {
    const { options } = unitMenuOptions();
    UNIT_CHOICES.forEach((unit, i) => expect(options[i]).toBe(unitLabel(unit)));
  });
});

describe('unitMenuChoice', () => {
  test('index 0 is Count (no unit)', () => {
    expect(unitMenuChoice(0)).toBeNull();
  });

  test('later indexes are units in menu order', () => {
    expect(unitMenuChoice(1)).toBe('g');
    expect(unitMenuChoice(4)).toBe('lb');
    expect(unitMenuChoice(UNITS.length)).toBe('dozen');
    const { options } = unitMenuOptions();
    expect(unitMenuChoice(options.indexOf('gal'))).toBe('gal');
  });

  test('Cancel and out-of-range indexes are undefined', () => {
    expect(unitMenuChoice(unitMenuOptions().cancelButtonIndex)).toBeUndefined();
    expect(unitMenuChoice(-1)).toBeUndefined();
    expect(unitMenuChoice(999)).toBeUndefined();
    expect(unitMenuChoice(1.5)).toBeUndefined();
  });
});

describe('withUnit', () => {
  test('keeps the number and changes only the unit, without converting', () => {
    expect(withUnit({ quantity: 2, unit: 'lb' }, 'kg')).toEqual({ quantity: 2, unit: 'kg' });
    expect(withUnit({ quantity: 0.25, unit: 'cup' }, 'tbsp')).toEqual({ quantity: 0.25, unit: 'tbsp' });
  });

  test('to and from a count', () => {
    expect(withUnit({ quantity: 3, unit: null }, 'can')).toEqual({ quantity: 3, unit: 'can' });
    expect(withUnit({ quantity: 2, unit: 'gal' }, null)).toEqual({ quantity: 2, unit: null });
  });

  test('the same unit needs no save', () => {
    expect(withUnit({ quantity: 2, unit: 'lb' }, 'lb')).toBeNull();
    expect(withUnit({ quantity: 2, unit: null }, null)).toBeNull();
  });

  test('a null quantity becomes 1 of the new unit', () => {
    expect(withUnit({ quantity: null, unit: null }, 'gal')).toEqual({ quantity: 1, unit: 'gal' });
    expect(withUnit({ quantity: null, unit: 'gal' }, 'gal')).toEqual({ quantity: 1, unit: 'gal' });
  });

  test('does not mutate its input', () => {
    const amount = { quantity: 2, unit: 'lb' as const };
    withUnit(amount, 'kg');
    expect(amount).toEqual({ quantity: 2, unit: 'lb' });
  });
});

describe('canStepDown', () => {
  test('false at or below one step', () => {
    expect(canStepDown({ quantity: 1, unit: null })).toBe(false);
    expect(canStepDown({ quantity: 0.5, unit: 'lb' })).toBe(false);
    expect(canStepDown({ quantity: 0.25, unit: 'cup' })).toBe(false);
    expect(canStepDown({ quantity: 100, unit: 'g' })).toBe(false);
    expect(canStepDown({ quantity: 50, unit: 'g' })).toBe(false);
  });

  test('true above one step', () => {
    expect(canStepDown({ quantity: 2, unit: null })).toBe(true);
    expect(canStepDown({ quantity: 1, unit: 'lb' })).toBe(true);
    expect(canStepDown({ quantity: 0.5, unit: 'cup' })).toBe(true);
    expect(canStepDown({ quantity: 200, unit: 'ml' })).toBe(true);
  });

  test('a null quantity is 1 of the usual unit', () => {
    expect(canStepDown({ quantity: null, unit: null }, 'gal')).toBe(false);
    expect(canStepDown({ quantity: null, unit: null }, 'lb')).toBe(true);
    expect(canStepDown({ quantity: null, unit: null })).toBe(false);
  });
});
