import { expect, test } from '@jest/globals';

import { positionBetween, positionForMove } from '../position';

test('positionBetween', () => {
  expect(positionBetween(null, null)).toBe(1);
  expect(positionBetween(null, 1)).toBe(0);
  expect(positionBetween(3, null)).toBe(4);
  expect(positionBetween(1, 2)).toBe(1.5);
});

test('positionForMove', () => {
  const positions = [1, 2, 3, 4];
  expect(positionForMove(positions, 0, 3)).toBe(5); // first to last
  expect(positionForMove(positions, 3, 0)).toBe(0); // last to first
  expect(positionForMove(positions, 0, 1)).toBe(2.5); // down one: between 2 and 3
  expect(positionForMove(positions, 2, 1)).toBe(1.5); // up one: between 1 and 2
  expect(positionForMove([1], 0, 0)).toBe(1);
});
