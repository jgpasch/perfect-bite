import { describe, expect, it, test } from '@jest/globals';

import { formatAmount, formatNumber } from '../quantity-display';

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

test('formatAmount', () => {
  expect(formatAmount({ quantity: 2, unit: 'lb' })).toBe('2 lb');
  expect(formatAmount({ quantity: 3, unit: null })).toBe('3');
  expect(formatAmount({ quantity: 1.5, unit: 'lb' })).toBe('1.5 lb');
  expect(formatAmount({ quantity: 1.5, unit: 'cup' })).toBe('1½ cup');
  expect(formatAmount({ quantity: null, unit: null })).toBe('');
});
