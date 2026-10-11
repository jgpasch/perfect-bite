import { describe, expect, test } from '@jest/globals';

import { UNITS } from '@/shared';

import {
  canStepDown,
  quantityText,
  typedAmount,
  UNIT_GROUPS,
  unitLabel,
  unitMenuSections,
  withUnit,
  type UnitMenuSection,
} from '../amount-stepper';

describe('unitLabel', () => {
  test('a unit reads as itself', () => {
    expect(unitLabel('lb')).toBe('lb');
    expect(unitLabel('fl oz')).toBe('fl oz');
  });

  test('no unit reads Count', () => {
    expect(unitLabel(null)).toBe('Count');
  });
});

describe('UNIT_GROUPS', () => {
  test('every supported unit, and Count, is in exactly one group', () => {
    const all = UNIT_GROUPS.flatMap((g) => g.units);
    for (const unit of [null, ...UNITS]) {
      expect([unit, UNIT_GROUPS.filter((g) => g.units.includes(unit)).length]).toEqual([unit, 1]);
    }
    expect(all).toHaveLength(UNITS.length + 1);
    expect(new Set(all).size).toBe(all.length);
  });

  test('groups and their order', () => {
    expect(UNIT_GROUPS.map((g) => g.title)).toEqual(['Count', 'Weight', 'Volume', 'Packages']);
    expect(UNIT_GROUPS[0].units).toEqual([null]);
    expect(UNIT_GROUPS[1].units).toEqual(['g', 'kg', 'oz', 'lb']);
    expect(UNIT_GROUPS[2].units).toEqual(['ml', 'l', 'tsp', 'tbsp', 'cup', 'fl oz', 'pt', 'qt', 'gal']);
    expect(UNIT_GROUPS[3].units).toEqual(['can', 'jar', 'bag', 'box', 'bunch', 'clove', 'pinch', 'dozen']);
  });
});

describe('unitMenuSections', () => {
  const units = (sections: UnitMenuSection[]) => sections.flatMap((s) => s.items.map((i) => i.unit));
  const checked = (sections: UnitMenuSection[]) => sections.flatMap((s) => s.items.filter((i) => i.checked));
  const usual = (sections: UnitMenuSection[]) => sections.flatMap((s) => s.items.filter((i) => i.usual));

  test('with no usual unit known: just the groups, the current unit ticked', () => {
    const sections = unitMenuSections('lb', undefined);
    expect(sections.map((s) => s.title)).toEqual(['Count', 'Weight', 'Volume', 'Packages']);
    expect(units(sections)).toEqual([null, ...UNITS]);
    expect(checked(sections)).toEqual([{ unit: 'lb', label: 'lb', checked: true, usual: false }]);
    expect(usual(sections)).toEqual([]);
  });

  test('the usual unit comes first, marked, and leaves its group', () => {
    const sections = unitMenuSections('gal', 'gal');
    expect(sections[0]).toEqual({ title: null, items: [{ unit: 'gal', label: 'gal', checked: true, usual: true }] });
    expect(sections[3].title).toBe('Volume');
    expect(sections[3].items.map((i) => i.unit)).toEqual(['ml', 'l', 'tsp', 'tbsp', 'cup', 'fl oz', 'pt', 'qt']);
    // Every unit still appears exactly once.
    expect(units(sections)).toHaveLength(UNITS.length + 1);
    expect(new Set(units(sections)).size).toBe(UNITS.length + 1);
  });

  test('the usual unit need not be the current one', () => {
    const sections = unitMenuSections('kg', 'lb');
    expect(sections[0].items).toEqual([{ unit: 'lb', label: 'lb', checked: false, usual: true }]);
    expect(checked(sections).map((i) => i.unit)).toEqual(['kg']);
  });

  test('a count as the usual unit: Count first and its empty group dropped', () => {
    const sections = unitMenuSections(null, null);
    expect(sections.map((s) => s.title)).toEqual([null, 'Weight', 'Volume', 'Packages']);
    expect(sections[0].items).toEqual([{ unit: null, label: 'Count', checked: true, usual: true }]);
    expect(units(sections)).toEqual([null, ...UNITS]);
  });
});

describe('quantityText', () => {
  test('decimals for the keypad, empty for no quantity', () => {
    expect(quantityText(2)).toBe('2');
    expect(quantityText(1.5)).toBe('1.5');
    expect(quantityText(0.25)).toBe('0.25');
    expect(quantityText(1 / 3)).toBe('0.33');
    expect(quantityText(null)).toBe('');
  });
});

describe('typedAmount', () => {
  const lb = { quantity: 2, unit: 'lb' as const };

  test('a number keeps the shown unit', () => {
    expect(typedAmount('3', lb)).toEqual({ quantity: 3, unit: 'lb' });
    expect(typedAmount(' 1.5 ', lb)).toEqual({ quantity: 1.5, unit: 'lb' });
    expect(typedAmount('1,5', lb)).toEqual({ quantity: 1.5, unit: 'lb' });
    expect(typedAmount('1/2', lb)).toEqual({ quantity: 0.5, unit: 'lb' });
    expect(typedAmount('4', { quantity: 1, unit: null })).toEqual({ quantity: 4, unit: null });
  });

  test('no rounding to the step', () => {
    expect(typedAmount('1.3', lb)).toEqual({ quantity: 1.3, unit: 'lb' });
    expect(typedAmount('150', { quantity: 100, unit: 'g' })).toEqual({ quantity: 150, unit: 'g' });
  });

  test('an item with no amount takes the number in the shown (usual) unit', () => {
    expect(typedAmount('3', { quantity: null, unit: 'gal' })).toEqual({ quantity: 3, unit: 'gal' });
  });

  test('an empty field clears the amount', () => {
    expect(typedAmount('', lb)).toEqual({ quantity: null, unit: null });
    expect(typedAmount('   ', lb)).toEqual({ quantity: null, unit: null });
  });

  test('nothing to save when it is unchanged', () => {
    expect(typedAmount('2', lb)).toBeNull();
    expect(typedAmount('2.0', lb)).toBeNull();
    expect(typedAmount('', { quantity: null, unit: 'gal' })).toBeNull();
  });

  test('text that is not a positive number is undefined', () => {
    expect(typedAmount('lots', lb)).toBeUndefined();
    expect(typedAmount('lb', lb)).toBeUndefined();
    expect(typedAmount('2 kg', lb)).toBeUndefined();
    expect(typedAmount('0', lb)).toBeUndefined();
    expect(typedAmount('-2', lb)).toBeUndefined();
    expect(typedAmount('2,5,1', lb)).toBeUndefined();
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
