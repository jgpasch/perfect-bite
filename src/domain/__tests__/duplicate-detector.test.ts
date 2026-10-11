import { describe, expect, it } from '@jest/globals';

import { detectDuplicate, planBulkAdd, type ExistingItem } from '../duplicate-detector';

const open = (id: string, ingredientName: string): ExistingItem => ({ id, ingredientName, checkedAt: null });
const checked = (id: string, ingredientName: string, at: number): ExistingItem => ({
  id,
  ingredientName,
  checkedAt: new Date(at),
});

describe('detectDuplicate', () => {
  it('is a new item when nothing matches', () => {
    expect(detectDuplicate('milk', [open('1', 'egg')])).toEqual({ kind: 'new' });
    expect(detectDuplicate('milk', [])).toEqual({ kind: 'new' });
  });

  it('combines with an open match, even when checked copies exist', () => {
    expect(detectDuplicate('milk', [checked('1', 'milk', 5), open('2', 'milk')])).toEqual({
      kind: 'combine',
      itemId: '2',
    });
  });

  it('reopens the most recently checked match', () => {
    expect(detectDuplicate('milk', [checked('1', 'milk', 5), checked('2', 'milk', 9), checked('3', 'egg', 10)])).toEqual(
      { kind: 'reopen', itemId: '2' },
    );
  });
});

describe('planBulkAdd', () => {
  it('decides each add as a single add would, and folds repeats in the batch', () => {
    const plan = planBulkAdd(['milk', 'egg', 'salt', 'milk'], [open('m', 'milk'), checked('e', 'egg', 1)]);
    expect(plan).toEqual([
      { kind: 'combine', itemId: 'm' },
      { kind: 'reopen', itemId: 'e' },
      { kind: 'new' },
      { kind: 'sameAsEarlier', index: 0 },
    ]);
  });

  it('adds everything new to an empty list', () => {
    expect(planBulkAdd(['a', 'b'], [])).toEqual([{ kind: 'new' }, { kind: 'new' }]);
  });
});
