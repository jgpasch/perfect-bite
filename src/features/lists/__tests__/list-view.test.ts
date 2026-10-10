import { describe, expect, it } from '@jest/globals';

import {
  addedToast,
  alsoInHint,
  checkOffLabel,
  groupListsByHousehold,
  itemRowLabel,
  pairs,
  SORTING_LABEL,
  tileAccessibilityLabel,
  tileCount,
  toGetLabel,
  toggleActionLabel,
} from '../list-view';

const list = (id: string, householdId: string, householdName: string) => ({ id, householdId, householdName });

describe('groupListsByHousehold', () => {
  it('groups lists under their household, keeping the list order', () => {
    const groups = groupListsByHousehold([
      list('groceries', 'h1', 'Our place'),
      list('weekend', 'h2', 'Lake house'),
      list('costco', 'h1', 'Our place'),
      list('hardware', 'h1', 'Our place'),
    ]);
    expect(groups.map((g) => [g.householdId, g.name, g.lists.map((l) => l.id)])).toEqual([
      ['h1', 'Our place', ['groceries', 'costco', 'hardware']],
      ['h2', 'Lake house', ['weekend']],
    ]);
  });

  it('orders households by their first list', () => {
    const groups = groupListsByHousehold([list('weekend', 'h2', 'Lake house'), list('groceries', 'h1', 'Our place')]);
    expect(groups.map((g) => g.name)).toEqual(['Lake house', 'Our place']);
  });

  it('keeps two households with the same name apart', () => {
    const groups = groupListsByHousehold([list('a', 'h1', 'Home'), list('b', 'h2', 'Home')]);
    expect(groups.map((g) => [g.householdId, g.lists.length])).toEqual([
      ['h1', 1],
      ['h2', 1],
    ]);
  });

  it('is empty with no lists', () => {
    expect(groupListsByHousehold([])).toEqual([]);
  });
});

describe('pairs', () => {
  it('puts cells two to a row', () => {
    expect(pairs([1, 2, 3, 4])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('leaves an odd last cell alone in its row', () => {
    expect(pairs(['a', 'b', 'c'])).toEqual([['a', 'b'], ['c']]);
    expect(pairs(['new'])).toEqual([['new']]);
  });

  it('is empty with no cells', () => {
    expect(pairs([])).toEqual([]);
  });
});

describe('tileCount', () => {
  it('shows the count of items to get', () => {
    expect(tileCount(12)).toEqual({ kind: 'count', text: '12' });
    expect(tileCount(1)).toEqual({ kind: 'count', text: '1' });
  });

  it('says All done at zero', () => {
    expect(tileCount(0)).toEqual({ kind: 'done', text: 'All done' });
  });
});

describe('tileAccessibilityLabel', () => {
  it('reads the name and how many items are left', () => {
    expect(tileAccessibilityLabel('Costco', 5)).toBe('Costco, 5 items to get');
    expect(tileAccessibilityLabel('Costco', 1)).toBe('Costco, 1 item to get');
    expect(tileAccessibilityLabel('Hardware store', 0)).toBe('Hardware store, all done');
  });

  it('says which list is Siri’s and which are archived', () => {
    expect(tileAccessibilityLabel('Groceries', 12, { isDefault: true })).toBe('Groceries, 12 items to get, Siri list');
    expect(tileAccessibilityLabel('Old', 0, { archived: true })).toBe('Old, all done, archived');
  });
});

describe('toGetLabel', () => {
  it('reads "N to get"', () => {
    expect(toGetLabel(12)).toBe('12 to get');
    expect(toGetLabel(1)).toBe('1 to get');
  });

  it('is null when there is nothing to get', () => {
    expect(toGetLabel(0)).toBeNull();
  });
});

describe('alsoInHint', () => {
  it('names the other recipes', () => {
    expect(alsoInHint(['Weeknight dal'])).toBe('Also in Weeknight dal');
    expect(alsoInHint(['Weeknight dal', 'Tacos'])).toBe('Also in Weeknight dal, Tacos');
  });

  it('is undefined for an item in one recipe', () => {
    expect(alsoInHint([])).toBeUndefined();
  });
});

describe('itemRowLabel', () => {
  it('reads the name, amount, note and hint', () => {
    expect(itemRowLabel({ name: 'Limes', amountText: '3', note: 'ripe', hint: 'Also in Weeknight dal' })).toBe(
      'Limes, 3, ripe, Also in Weeknight dal',
    );
  });

  it('leaves out empty parts', () => {
    expect(itemRowLabel({ name: 'Milk', amountText: '', note: null })).toBe('Milk');
  });

  it('keeps the Sorting section’s label on a sorting row', () => {
    expect(itemRowLabel({ name: 'gochujang' }, true)).toBe('gochujang, Sorting, finding a section for these items');
    expect(SORTING_LABEL).toBe('Sorting…');
  });
});

describe('checkOffLabel', () => {
  it('names the item', () => {
    expect(checkOffLabel('Limes')).toBe('Check off Limes');
  });

  it('keeps the name as shown, case and spaces included', () => {
    expect(checkOffLabel('chicken thighs')).toBe('Check off chicken thighs');
  });
});

describe('toggleActionLabel', () => {
  it('offers to check off an open item', () => {
    expect(toggleActionLabel(false)).toBe('Check off');
  });

  it('offers to uncheck a checked item', () => {
    expect(toggleActionLabel(true)).toBe('Uncheck');
  });
});

describe('addedToast', () => {
  it('says what the item is now, with the name in bold', () => {
    expect(addedToast('milk', '1 gal + 1')).toEqual({ message: 'Added to milk, now 1 gal + 1', emphasis: 'milk' });
  });

  it('leaves out the total when there is none', () => {
    expect(addedToast('milk', '')).toEqual({ message: 'Added to milk', emphasis: 'milk' });
    expect(addedToast('milk', null)).toEqual({ message: 'Added to milk', emphasis: 'milk' });
    expect(addedToast('milk', undefined)).toEqual({ message: 'Added to milk', emphasis: 'milk' });
  });
});
