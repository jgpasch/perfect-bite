// Runs under Jest and Deno (`supabase/functions/_shared/shared-domain.test.ts`). How amounts read
// is tested with the app's formatting, in `src/domain/__tests__/quantity-math.test.ts`.
import { describe, expect, it } from '@jest/globals';

import type { Unit } from '../../quantity-parser.ts';
import { combineAmounts, combineGroup, groupAmounts, noAmountUnit } from '../quantity-math.ts';

const a = (quantity: number | null, unit: Unit | null = null) => ({ quantity, unit });

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

describe('noAmountUnit', () => {
  it('is a usual unit things are bought in', () => {
    expect(noAmountUnit('gal')).toBe('gal');
    expect(noAmountUnit('dozen')).toBe('dozen');
    expect(noAmountUnit('can')).toBe('can');
  });

  it('is a plain count for a cooking measure, or no usual unit', () => {
    expect(noAmountUnit('tbsp')).toBeNull();
    expect(noAmountUnit('g')).toBeNull();
    expect(noAmountUnit(null)).toBeNull();
  });
});

describe('groupAmounts and combineGroup', () => {
  it('groups by dimension or unit, counting a null quantity as one', () => {
    expect(groupAmounts([a(1, 'lb'), a(2, 'can'), a(3, 'oz'), a(null)], null)).toEqual([
      [a(1, 'lb'), a(3, 'oz')],
      [a(2, 'can')],
      [a(1)],
    ]);
    expect(groupAmounts([a(null), a(1, 'gal')], 'gal')).toEqual([[a(1, 'gal'), a(1, 'gal')]]);
    expect(groupAmounts([], null)).toEqual([]);
  });

  it('combines a group, or gives null when rounding would hide an amount', () => {
    expect(combineGroup([a(1, 'kg'), a(500, 'g')])).toEqual(a(1.5, 'kg'));
    expect(combineGroup([a(2, 'can'), a(1, 'can')])).toEqual(a(3, 'can'));
    expect(combineGroup([a(1, 'gal'), a(1, 'tsp')])).toBeNull();
  });
});
