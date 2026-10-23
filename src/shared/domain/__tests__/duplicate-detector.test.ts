// Runs under Jest and Deno (`supabase/functions/_shared/shared-domain.test.ts`).
import { describe, expect, it } from '@jest/globals';

import { detectDuplicate, planBulkAdd, type ExistingItem } from '../duplicate-detector.ts';

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

  it('folds twins in the batch and combines them with the list by family key (spec 4.15)', () => {
    const cucumber = { ...open('c', 'cucumber'), familyKey: 'cucumber' };
    expect(
      planBulkAdd(['pepino', 'leche', 'milk', 'tomate'], [cucumber], ['cucumber', 'milk', 'milk', 'tomate']),
    ).toEqual([{ kind: 'combine', itemId: 'c' }, { kind: 'new' }, { kind: 'sameAsEarlier', index: 1 }, { kind: 'new' }]);
  });
});

describe('detectDuplicate across a family (spec 4.15)', () => {
  const twin = (item: ExistingItem, familyKey: string): ExistingItem => ({ ...item, familyKey });

  it('combines into an open item of the same family, both ways', () => {
    expect(detectDuplicate('pepino', [twin(open('c', 'cucumber'), 'cucumber')], 'cucumber')).toEqual({
      kind: 'combine',
      itemId: 'c',
    });
    expect(detectDuplicate('cucumber', [twin(open('p', 'pepino'), 'cucumber')], 'cucumber')).toEqual({
      kind: 'combine',
      itemId: 'p',
    });
  });

  it('prefers its own key, open before checked', () => {
    const items = [twin(open('c', 'cucumber'), 'cucumber'), twin(open('p', 'pepino'), 'cucumber')];
    expect(detectDuplicate('pepino', items, 'cucumber')).toEqual({ kind: 'combine', itemId: 'p' });
    const ownChecked = [twin(checked('p', 'pepino', 5), 'cucumber'), twin(open('c', 'cucumber'), 'cucumber')];
    expect(detectDuplicate('pepino', ownChecked, 'cucumber')).toEqual({ kind: 'combine', itemId: 'c' });
    const bothChecked = [twin(checked('c', 'cucumber', 9), 'cucumber'), twin(checked('p', 'pepino', 5), 'cucumber')];
    expect(detectDuplicate('pepino', bothChecked, 'cucumber')).toEqual({ kind: 'reopen', itemId: 'p' });
    expect(detectDuplicate('pepino', [twin(checked('c', 'cucumber', 9), 'cucumber')], 'cucumber')).toEqual({
      kind: 'reopen',
      itemId: 'c',
    });
  });

  it("doesn't match other families, or without a family given", () => {
    expect(detectDuplicate('tomate', [twin(open('t', 'tomato'), 'tomato')], 'tomate')).toEqual({ kind: 'new' });
    expect(detectDuplicate('pepino', [twin(open('c', 'cucumber'), 'cucumber')])).toEqual({ kind: 'new' });
  });
});
