import { describe, expect, it } from '@jest/globals';

import {
  addedToast,
  movedToast,
  alsoInHint,
  checkOffLabel,
  compactHeaderSubtitle,
  duplicateQuery,
  isAlreadyOnList,
  DEFAULT_LIST_VIEW_MODE,
  groupListsByHousehold,
  itemRowLabel,
  launchListId,
  LIST_VIEW_MODES,
  orderByNewest,
  pairs,
  SORTING_LABEL,
  tileAccessibilityLabel,
  tileCount,
  toGetLabel,
  toggleActionLabel,
  viewModeKey,
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

  it('reads the aisle last (Newest shows it as a dot)', () => {
    expect(itemRowLabel({ name: 'Limes', amountText: '3', aisle: 'Produce' })).toBe('Limes, 3, Produce');
  });

  it('reads Sorting instead of the aisle while the item waits for one', () => {
    expect(itemRowLabel({ name: 'yuzu kosho', aisle: '' }, true)).toBe('yuzu kosho, Sorting, finding a section for these items');
  });

  it('leaves out an empty aisle name', () => {
    expect(itemRowLabel({ name: 'Milk', aisle: '' })).toBe('Milk');
  });
});

describe('list view modes', () => {
  it('orders the segments Newest | By aisle | By recipe', () => {
    expect(LIST_VIEW_MODES.map((m) => [m.value, m.label])).toEqual([
      ['newest', 'Newest'],
      ['category', 'By aisle'],
      ['recipe', 'By recipe'],
    ]);
  });

  it('gives Newest a hint saying what it shows', () => {
    expect(LIST_VIEW_MODES[0].hint).toBe('Items you added most recently first');
  });

  it('opens a list with no saved choice in Newest', () => {
    expect(DEFAULT_LIST_VIEW_MODE).toBe('newest');
  });

  it('keeps the key saved choices were stored under', () => {
    expect(viewModeKey('abc')).toBe('list.abc.viewMode');
  });
});

describe('orderByNewest', () => {
  const t = (minutes: number) => new Date(Date.UTC(2026, 9, 10, 9, minutes));
  const item = (
    id: string,
    contributions: [string, number][],
    { createdAt = 0, checked = false }: { createdAt?: number; checked?: boolean } = {},
  ) => ({
    id,
    createdAt: t(createdAt),
    checkedAt: checked ? t(59) : null,
    contributions: contributions.map(([cid, m]) => ({ id: cid, createdAt: t(m) })),
  });
  const ids = (items: { id: string }[]) => items.map((i) => i.id);

  it('puts the item with the latest earliest amount first', () => {
    expect(ids(orderByNewest([item('milk', [['c1', 1]]), item('eggs', [['c2', 3]]), item('bread', [['c3', 2]])]))).toEqual([
      'eggs',
      'bread',
      'milk',
    ]);
  });

  it('keeps a combined item where its first amount put it', () => {
    const milk = item('milk', [['c1', 1], ['c4', 10]]);
    expect(ids(orderByNewest([milk, item('eggs', [['c2', 3]])]))).toEqual(['eggs', 'milk']);
  });

  it('uses the earliest amount even if amounts come out of order', () => {
    const milk = item('milk', [['c4', 10], ['c1', 1]]);
    expect(ids(orderByNewest([milk, item('eggs', [['c2', 3]])]))).toEqual(['eggs', 'milk']);
  });

  it('moves a re-added item (its amounts replaced) to the top, whatever its own age', () => {
    const milk = item('milk', [['c9', 20]], { createdAt: 0 });
    expect(ids(orderByNewest([milk, item('eggs', [['c2', 3]], { createdAt: 3 })]))).toEqual(['milk', 'eggs']);
  });

  it('keeps a recipe batch (one timestamp) in ingredient order, i.e. by amount id', () => {
    const batch = [item('i9', [['c1', 5]]), item('i1', [['c2', 5]]), item('i5', [['c3', 5]])];
    const older = item('i0', [['c0', 1]]);
    expect(ids(orderByNewest([older, batch[2], batch[0], batch[1]]))).toEqual(['i9', 'i1', 'i5', 'i0']);
  });

  it('falls back to the item’s own createdAt when it has no amounts', () => {
    expect(ids(orderByNewest([item('milk', [['c1', 1]]), item('bare', [], { createdAt: 2 }), item('eggs', [['c2', 3]])]))).toEqual([
      'eggs',
      'bare',
      'milk',
    ]);
  });

  it('breaks other ties by id', () => {
    expect(ids(orderByNewest([item('b', [], { createdAt: 4 }), item('a', [], { createdAt: 4 })]))).toEqual(['a', 'b']);
    expect(ids(orderByNewest([item('b', [['x', 4]]), item('a', [['x', 4]])]))).toEqual(['a', 'b']);
  });

  it('leaves out checked items', () => {
    expect(ids(orderByNewest([item('milk', [['c1', 1]], { checked: true }), item('eggs', [['c2', 3]])]))).toEqual(['eggs']);
  });

  it('returns nothing for no items, and does not reorder its input', () => {
    expect(orderByNewest([])).toEqual([]);
    const input = [item('a', [['c1', 1]]), item('b', [['c2', 2]])];
    orderByNewest(input);
    expect(ids(input)).toEqual(['a', 'b']);
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

describe('movedToast', () => {
  it('reads a Combine as an add would', () => {
    expect(movedToast({ kind: 'combine', name: 'milk', totalAmountText: '2 gal', fromListName: 'Groceries' })).toEqual({
      message: 'Added to milk, now 2 gal',
      emphasis: 'milk',
    });
  });

  it('says where a moved or reopened item came from', () => {
    expect(movedToast({ kind: 'new', name: 'chicken thighs', fromListName: 'Groceries' })).toEqual({
      message: 'Moved chicken thighs from Groceries',
      emphasis: 'chicken thighs',
    });
    expect(movedToast({ kind: 'reopen', name: 'milk', fromListName: 'Costco' })).toEqual({
      message: 'Moved milk from Costco',
      emphasis: 'milk',
    });
  });

  it('leaves the list off when its name is missing', () => {
    expect(movedToast({ kind: 'new', name: 'milk', fromListName: '' })).toEqual({ message: 'Moved milk', emphasis: 'milk' });
  });
});

describe('launchListId', () => {
  const lists = [{ id: 'groceries' }, { id: 'costco' }, { id: 'hardware' }];

  it('opens the last opened list when it is still open', () => {
    expect(launchListId('costco', 'groceries', lists)).toBe('costco');
  });

  it('falls back to the default list when the last one is gone', () => {
    expect(launchListId('deleted', 'hardware', lists)).toBe('hardware');
  });

  it('falls back to the default list when nothing was opened yet', () => {
    expect(launchListId(null, 'hardware', lists)).toBe('hardware');
  });

  it('falls back to the first list when the default is gone too', () => {
    expect(launchListId('deleted', 'also-deleted', lists)).toBe('groceries');
    expect(launchListId(null, null, lists)).toBe('groceries');
  });

  it('lands on the Lists home when there are no lists', () => {
    expect(launchListId('costco', 'groceries', [])).toBeNull();
    expect(launchListId(null, null, [])).toBeNull();
  });
});

describe('add mode', () => {
  it('sums up the list under the compact title', () => {
    expect(compactHeaderSubtitle(8, 'newest')).toBe('8 to get · Newest');
    expect(compactHeaderSubtitle(1, 'category')).toBe('1 to get · By aisle');
    expect(compactHeaderSubtitle(0, 'recipe')).toBe('By recipe');
  });

  it('checks the typed name, without its amount, against items', () => {
    expect(duplicateQuery('chi')).toBe('chi');
    expect(duplicateQuery('2 lbs Chicken Thighs')).toBe('chicken thigh');
    expect(duplicateQuery('c')).toBeNull();
    expect(duplicateQuery('  ')).toBeNull();
  });

  it('highlights unchecked items whose name starts with or contains the typed text', () => {
    const broth = { ingredientName: 'chicken broth', checkedAt: null };
    expect(isAlreadyOnList(broth, duplicateQuery('chi'))).toBe(true);
    expect(isAlreadyOnList(broth, duplicateQuery('broth'))).toBe(true);
    expect(isAlreadyOnList(broth, duplicateQuery('tuna'))).toBe(false);
    expect(isAlreadyOnList(broth, null)).toBe(false);
    expect(isAlreadyOnList({ ...broth, checkedAt: new Date() }, duplicateQuery('chi'))).toBe(false);
  });
});
