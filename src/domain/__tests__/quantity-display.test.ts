import { describe, expect, it } from '@jest/globals';

import { formatAmount, formatAmounts, formatNumber } from '../quantity-display';

describe('formatNumber', () => {
  it.each([
    [2, '2'],
    [1.5, '1½'],
    [0.25, '¼'],
    [0.333, '⅓'],
    [2.4, '2.4'],
    [0.125, '⅛'],
  ])('%s → %s', (n, expected) => {
    expect(formatNumber(n)).toBe(expected);
  });
});

describe('formatAmounts', () => {
  it('shows one amount', () => {
    expect(formatAmount({ quantity: 2, unit: 'lb' })).toBe('2 lb');
    expect(formatAmounts([{ quantity: 3, unit: null }])).toBe('3');
    expect(formatAmounts([{ quantity: null, unit: null }])).toBe('');
    expect(formatAmounts([])).toBe('');
  });

  it('joins several adds, counting an add with no amount as 1', () => {
    expect(
      formatAmounts([
        { quantity: 1, unit: 'gal' },
        { quantity: null, unit: null },
      ]),
    ).toBe('1 gal + 1');
    expect(
      formatAmounts([
        { quantity: null, unit: null },
        { quantity: null, unit: null },
      ]),
    ).toBe('');
  });
});
