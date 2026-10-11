import { expect, test } from '@jest/globals';

import type { MoveItemResult } from '../items';
import { setMoveResult, takeMoveResult } from '../move-result';

const move: MoveItemResult = {
  itemId: 'milk-1',
  fromListId: 'groceries',
  fromListName: 'Groceries',
  toListId: 'costco',
  kind: 'combine',
  targetItemId: 'milk-2',
  name: 'milk',
  totalAmountText: '2 gal',
  contributionIds: ['c1'],
};

test('the list it moved to takes it once', () => {
  setMoveResult(move);
  expect(takeMoveResult('costco')).toEqual(move);
  expect(takeMoveResult('costco')).toBeNull();
});

test('the list it came from, or nothing pending, gives null and leaves it', () => {
  expect(takeMoveResult('costco')).toBeNull();
  setMoveResult(move);
  expect(takeMoveResult('groceries')).toBeNull();
  expect(takeMoveResult('costco')).toEqual(move);
});

test('a newer move replaces one not yet taken', () => {
  setMoveResult(move);
  setMoveResult({ ...move, toListId: 'hardware', kind: 'new' });
  expect(takeMoveResult('costco')).toBeNull();
  expect(takeMoveResult('hardware')).toMatchObject({ toListId: 'hardware', kind: 'new' });
});
