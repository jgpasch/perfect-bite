import { describe, expect, it } from '@jest/globals';

import {
  addedAt,
  addedToast,
  applyManualOrder,
  manualOrderEntries,
  manualOrderKey,
  readManualOrder,
  aisleSectionKey,
  collapsedSectionsKey,
  collapsedShowing,
  expandSection,
  readCollapsedSections,
  recipeSectionKey,
  toggleCollapsedSection,
  movedToast,
  aisleColorStyleLabel,
  alsoInHint,
  readAisleColorStyle,
  readItemRowStyle,
  fromRecipesHint,
  withLingering,
  checkOffLabel,
  clearCheckedLabel,
  clearedToast,
  uncheckedAllToast,
  checkedChoiceAfterAllDoneChange,
  checkedSectionOpen,
  compactHeaderSubtitle,
  deletedToast,
  duplicateQuery,
  alreadyOnListMatch,
  alreadyOnListParts,
  isAlreadyOnList,
  DEFAULT_LIST_VIEW_MODE,
  groupListsByHousehold,
  householdHeaderLabel,
  listsOverview,
  itemRowLabel,
  launchListId,
  listRowAccessibilityLabel,
  listRowCount,
  LIST_VIEW_MODES,
  VIEW_BUTTON_HINT,
  viewButtonAccessibilityLabel,
  viewModeLabel,
  orderByNewest,
  SORTING_LABEL,
  switcherAccessibilityLabel,
  toGetLabel,
  toggleActionLabel,
  viewModeKey,
} from '../list-view';
import { normalizeIngredientName } from '@/shared';

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

describe('listRowCount', () => {
  it('shows the count of items to get', () => {
    expect(listRowCount(12)).toBe('12');
    expect(listRowCount(1)).toBe('1');
  });

  it('says Done at zero', () => {
    expect(listRowCount(0)).toBe('Done');
  });
});

describe('listRowAccessibilityLabel', () => {
  it('reads the name and how many items are left', () => {
    expect(listRowAccessibilityLabel('Costco', 5)).toBe('Costco, 5 items to get');
    expect(listRowAccessibilityLabel('Costco', 1)).toBe('Costco, 1 item to get');
    expect(listRowAccessibilityLabel('Hardware store', 0)).toBe('Hardware store, all done');
  });

  it('says which list is Siri’s, which are archived and which is current', () => {
    expect(listRowAccessibilityLabel('Groceries', 12, { isDefault: true })).toBe('Groceries, 12 items to get, Siri list');
    expect(listRowAccessibilityLabel('Old', 0, { archived: true })).toBe('Old, all done, archived');
    expect(listRowAccessibilityLabel('HEB', 3, { current: true })).toBe('HEB, 3 items to get, current');
    expect(listRowAccessibilityLabel('Groceries', 12, { isDefault: true, current: true })).toBe(
      'Groceries, 12 items to get, Siri list, current',
    );
  });

  it('leaves out flags that are false', () => {
    expect(listRowAccessibilityLabel('HEB', 2, { isDefault: false, archived: false, current: false })).toBe('HEB, 2 items to get');
  });
});

describe('switcherAccessibilityLabel', () => {
  it('reads the list name and that it switches lists', () => {
    expect(switcherAccessibilityLabel('Groceries', 0)).toBe('Groceries, switch list');
  });

  it('adds the waiting invites', () => {
    expect(switcherAccessibilityLabel('Groceries', 1)).toBe('Groceries, switch list, 1 invite waiting');
    expect(switcherAccessibilityLabel('Groceries', 3)).toBe('Groceries, switch list, 3 invites waiting');
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

  it('reads "All done" when everything on the list is checked', () => {
    expect(toGetLabel(0, 2)).toBe('All done');
    expect(toGetLabel(3, 2)).toBe('3 to get');
  });
});

describe('checkedSectionOpen', () => {
  it('opens by itself only once nothing is left to get', () => {
    expect(checkedSectionOpen(null, false, false)).toBe(false);
    expect(checkedSectionOpen(null, true, false)).toBe(true);
  });

  it('is always open with Always show checked items on', () => {
    expect(checkedSectionOpen(null, false, true)).toBe(true);
  });

  it("follows the user's own choice over either", () => {
    expect(checkedSectionOpen(false, true, true)).toBe(false);
    expect(checkedSectionOpen(true, false, false)).toBe(true);
  });
});

describe('checkedChoiceAfterAllDoneChange', () => {
  it('forgets a fold by hand and keeps an open by hand', () => {
    expect(checkedChoiceAfterAllDoneChange(false)).toBeNull();
    expect(checkedChoiceAfterAllDoneChange(null)).toBeNull();
    expect(checkedChoiceAfterAllDoneChange(true)).toBe(true);
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

describe('fromRecipesHint', () => {
  it('names each recipe once', () => {
    expect(
      fromRecipesHint([
        { recipeId: 'r1', recipeName: 'Tacos' },
        { recipeId: 'r1', recipeName: 'Tacos' },
        { recipeId: null, recipeName: null },
        { recipeId: 'r2', recipeName: 'Chili' },
      ]),
    ).toBe('From Tacos, Chili');
  });

  it('is undefined for an item from no recipe', () => {
    expect(fromRecipesHint([{ recipeId: null, recipeName: null }])).toBeUndefined();
    expect(fromRecipesHint([])).toBeUndefined();
  });
});

describe('withLingering', () => {
  const at = new Date(0);
  const a: { id: string; checkedAt: Date | null } = { id: 'a', checkedAt: null };
  const b = { id: 'b', checkedAt: at };
  const c = { id: 'c', checkedAt: at };

  it('keeps a just-checked item in place, as unchecked, and out of Checked', () => {
    expect(withLingering([a], [b, c], new Set(['b']))).toEqual({ placed: [a, { id: 'b', checkedAt: null }], checked: [c] });
  });

  it('changes nothing when nothing lingers', () => {
    expect(withLingering([a], [b], new Set())).toEqual({ placed: [a], checked: [b] });
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

  it('reads the aisle last (As added shows it as a dot)', () => {
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
  it('orders the menu As added | By aisle | By recipe, each with its icon', () => {
    expect(LIST_VIEW_MODES.map((m) => [m.value, m.label, m.icon])).toEqual([
      ['newest', 'As added', 'clock'],
      ['category', 'By aisle', 'cart'],
      ['recipe', 'By recipe', 'fork.knife'],
    ]);
  });

  it('labels the view button with the current view', () => {
    expect(viewModeLabel('newest')).toBe('As added');
    expect(viewButtonAccessibilityLabel('newest')).toBe('View: As added');
    expect(viewButtonAccessibilityLabel('category')).toBe('View: By aisle');
    expect(VIEW_BUTTON_HINT).toBe('Changes how the list is grouped');
  });

  it('shows no user-facing "Newest"', () => {
    expect(LIST_VIEW_MODES.some((m) => /newest/i.test(m.label))).toBe(false);
  });

  it('opens a list with no saved choice in As added', () => {
    expect(DEFAULT_LIST_VIEW_MODE).toBe('newest');
  });

  it('keeps the key saved choices were stored under', () => {
    expect(viewModeKey('abc')).toBe('list.abc.viewMode');
  });
});

describe('collapsed sections', () => {
  it('keeps a setting per list and per view mode', () => {
    expect(collapsedSectionsKey('abc', 'category')).toBe('list.abc.collapsed.category');
    expect(collapsedSectionsKey('abc', 'recipe')).toBe('list.abc.collapsed.recipe');
    expect(collapsedSectionsKey('xyz', 'category')).toBe('list.xyz.collapsed.category');
    expect(new Set([
      collapsedSectionsKey('abc', 'category'),
      collapsedSectionsKey('abc', 'recipe'),
      collapsedSectionsKey('xyz', 'category'),
      viewModeKey('abc'),
    ]).size).toBe(4);
  });

  it('keys sections by category and by recipe, with Other items as r-other', () => {
    expect(aisleSectionKey('produce-1')).toBe('c-produce-1');
    expect(recipeSectionKey('rec-7')).toBe('r-rec-7');
    expect(recipeSectionKey(null)).toBe('r-other');
  });

  it('reads a saved list of keys, dropping duplicates', () => {
    expect(readCollapsedSections(['c-a', 'c-b', 'c-a'])).toEqual(['c-a', 'c-b']);
  });

  it('reads nothing saved, or anything malformed, as no folded sections', () => {
    expect(readCollapsedSections(null)).toEqual([]);
    expect(readCollapsedSections(undefined)).toEqual([]);
    expect(readCollapsedSections('c-a')).toEqual([]);
    expect(readCollapsedSections({ 'c-a': true })).toEqual([]);
    expect(readCollapsedSections(['c-a', 3, null, { k: 1 }, 'r-other'])).toEqual(['c-a', 'r-other']);
  });

  it('toggles a section folded, then open again', () => {
    const folded = toggleCollapsedSection(['c-a'], 'c-b');
    expect(folded).toEqual(['c-a', 'c-b']);
    expect(toggleCollapsedSection(folded, 'c-b')).toEqual(['c-a']);
    expect(toggleCollapsedSection(['c-a'], 'c-a')).toEqual([]);
    expect(toggleCollapsedSection([], 'r-other')).toEqual(['r-other']);
  });

  it('does not change the saved keys it is given', () => {
    const saved = ['c-a'];
    toggleCollapsedSection(saved, 'c-b');
    toggleCollapsedSection(saved, 'c-a');
    expandSection(saved, 'c-a');
    expect(saved).toEqual(['c-a']);
  });

  it('opens a folded section, and leaves the keys as they were when it was open', () => {
    expect(expandSection(['c-a', 'c-b'], 'c-a')).toEqual(['c-b']);
    const saved = ['c-a'];
    expect(expandSection(saved, 'c-b')).toBe(saved);
  });

  it('ignores stale keys for sections that are not showing', () => {
    const showing = collapsedShowing(['c-a', 'c-gone', 'r-deleted-recipe'], ['c-a', 'c-b']);
    expect([...showing]).toEqual(['c-a']);
    expect(collapsedShowing(['c-gone'], []).size).toBe(0);
    expect(collapsedShowing([], ['c-a']).size).toBe(0);
  });

  it('keeps stale keys when toggling, so a section that comes back is still folded', () => {
    const saved = toggleCollapsedSection(['c-gone'], 'c-a');
    expect(saved).toEqual(['c-gone', 'c-a']);
    expect([...collapsedShowing(saved, ['c-a', 'c-gone'])]).toEqual(['c-gone', 'c-a']);
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

describe('manual As added order', () => {
  const t = (minutes: number) => new Date(Date.UTC(2026, 9, 10, 9, minutes));
  const ms = (minutes: number) => t(minutes).getTime();
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
  const view = (items: ReturnType<typeof item>[], saved: unknown) => ids(applyManualOrder(orderByNewest(items), readManualOrder(saved)));

  const milk = item('milk', [['c1', 1]]);
  const eggs = item('eggs', [['c2', 2]]);
  const bread = item('bread', [['c3', 3]]);

  it('keys the setting by list', () => {
    expect(manualOrderKey('abc')).toBe('list.abc.manualOrder');
    expect(manualOrderKey('xyz')).toBe('list.xyz.manualOrder');
  });

  describe('addedAt', () => {
    it('is the earliest current amount’s createdAt, whatever their order', () => {
      expect(addedAt(item('milk', [['c4', 10], ['c1', 1]], { createdAt: 0 }))).toBe(ms(1));
    });

    it('is the item’s own createdAt with no amounts', () => {
      expect(addedAt(item('bare', [], { createdAt: 7 }))).toBe(ms(7));
    });
  });

  describe('readManualOrder', () => {
    it('reads a list of { id, at }', () => {
      expect(readManualOrder([{ id: 'a', at: 1 }, { id: 'b', at: 2 }])).toEqual([
        { id: 'a', at: 1 },
        { id: 'b', at: 2 },
      ]);
    });

    it('keeps the first place of an id saved twice', () => {
      expect(readManualOrder([{ id: 'a', at: 1 }, { id: 'b', at: 2 }, { id: 'a', at: 3 }])).toEqual([
        { id: 'a', at: 1 },
        { id: 'b', at: 2 },
      ]);
    });

    it('drops extra fields', () => {
      expect(readManualOrder([{ id: 'a', at: 1, extra: true }])).toEqual([{ id: 'a', at: 1 }]);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'milk,eggs'],
      ['a number', 4],
      ['an object', { id: 'a', at: 1 }],
      ['a list of strings', ['a', 'b']],
      ['an entry with no at', [{ id: 'a' }]],
      ['an at that is a string', [{ id: 'a', at: '1' }]],
      ['an at that is NaN', [{ id: 'a', at: NaN }]],
      ['an at that is Infinity', [{ id: 'a', at: Infinity }]],
      ['an id that is a number', [{ id: 1, at: 1 }]],
      ['a null entry among good ones', [{ id: 'a', at: 1 }, null]],
    ])('reads %s as no order', (_, saved) => {
      expect(readManualOrder(saved)).toEqual([]);
    });
  });

  describe('applyManualOrder', () => {
    it('is plain As added with nothing saved', () => {
      expect(view([milk, eggs, bread], null)).toEqual(['bread', 'eggs', 'milk']);
    });

    it('is plain As added with garbage saved', () => {
      expect(view([milk, eggs, bread], 'garbage')).toEqual(['bread', 'eggs', 'milk']);
    });

    it('puts saved items in their saved places', () => {
      const saved = [
        { id: 'milk', at: ms(1) },
        { id: 'bread', at: ms(3) },
        { id: 'eggs', at: ms(2) },
      ];
      expect(view([milk, eggs, bread], saved)).toEqual(['milk', 'bread', 'eggs']);
    });

    it('puts new items above every saved one, newest first', () => {
      const saved = [
        { id: 'milk', at: ms(1) },
        { id: 'eggs', at: ms(2) },
      ];
      const jam = item('jam', [['c5', 5]]);
      const oats = item('oats', [['c4', 4]]);
      expect(view([milk, eggs, jam, oats], saved)).toEqual(['jam', 'oats', 'milk', 'eggs']);
    });

    it('treats an unsaved item older than the saved ones as new, too', () => {
      const old = item('old', [['c0', 0]]);
      expect(view([milk, eggs, old], [{ id: 'eggs', at: ms(2) }, { id: 'milk', at: ms(1) }])).toEqual(['old', 'eggs', 'milk']);
    });

    it('lands a recipe add on top as a block in ingredient order', () => {
      const saved = [
        { id: 'milk', at: ms(1) },
        { id: 'eggs', at: ms(2) },
      ];
      const batch = [item('i9', [['r1', 5]]), item('i1', [['r2', 5]]), item('i5', [['r3', 5]])];
      expect(view([batch[2], milk, batch[0], eggs, batch[1]], saved)).toEqual(['i9', 'i1', 'i5', 'milk', 'eggs']);
    });

    it('keeps a combined item where the user put it', () => {
      const saved = [
        { id: 'milk', at: ms(1) },
        { id: 'bread', at: ms(3) },
        { id: 'eggs', at: ms(2) },
      ];
      const combined = item('milk', [['c1', 1], ['c9', 20]]);
      expect(view([combined, eggs, bread], saved)).toEqual(['milk', 'bread', 'eggs']);
    });

    it('moves a re-added item (new amounts, so a new at) to the top', () => {
      const saved = [
        { id: 'milk', at: ms(1) },
        { id: 'bread', at: ms(3) },
        { id: 'eggs', at: ms(2) },
      ];
      const readded = item('eggs', [['c9', 20]]);
      expect(view([milk, readded, bread], saved)).toEqual(['eggs', 'milk', 'bread']);
    });

    it('ignores saved entries for items not showing, and puts an unchecked item back in its place', () => {
      const saved = [
        { id: 'milk', at: ms(1) },
        { id: 'eggs', at: ms(2) },
        { id: 'gone', at: ms(4) },
        { id: 'bread', at: ms(3) },
      ];
      expect(view([milk, item('eggs', [['c2', 2]], { checked: true }), bread], saved)).toEqual(['milk', 'bread']);
      // Unchecked again, with its amounts unchanged.
      expect(view([milk, eggs, bread], saved)).toEqual(['milk', 'eggs', 'bread']);
    });

    it('does not change its input', () => {
      const ordered = orderByNewest([milk, eggs]);
      applyManualOrder(ordered, [{ id: 'milk', at: ms(1) }]);
      expect(ids(ordered)).toEqual(['eggs', 'milk']);
    });
  });

  describe('manualOrderEntries', () => {
    it('pins every item on screen in its order, with its current at', () => {
      expect(manualOrderEntries(['milk', 'bread', 'eggs'], [milk, eggs, bread], [])).toEqual([
        { id: 'milk', at: ms(1) },
        { id: 'bread', at: ms(3) },
        { id: 'eggs', at: ms(2) },
      ]);
    });

    it('saves a re-added item with its new at', () => {
      const readded = item('eggs', [['c9', 20]]);
      expect(manualOrderEntries(['eggs', 'milk'], [milk, readded], [{ id: 'eggs', at: ms(2) }, { id: 'milk', at: ms(1) }])).toEqual([
        { id: 'eggs', at: ms(20) },
        { id: 'milk', at: ms(1) },
      ]);
    });

    it('keeps a checked item’s previous entry just after the item it followed', () => {
      const checkedEggs = item('eggs', [['c2', 2]], { checked: true });
      const previous = [
        { id: 'milk', at: ms(1) },
        { id: 'eggs', at: ms(2) },
        { id: 'bread', at: ms(3) },
      ];
      const entries = manualOrderEntries(['bread', 'milk'], [milk, checkedEggs, bread], previous);
      expect(entries).toEqual([
        { id: 'bread', at: ms(3) },
        { id: 'milk', at: ms(1) },
        { id: 'eggs', at: ms(2) },
      ]);
      // Unchecked, Eggs comes back under Milk.
      expect(view([milk, eggs, bread], entries)).toEqual(['bread', 'milk', 'eggs']);
    });

    it('keeps a checked item that was first at the top', () => {
      const checkedEggs = item('eggs', [['c2', 2]], { checked: true });
      const previous = [
        { id: 'eggs', at: ms(2) },
        { id: 'milk', at: ms(1) },
        { id: 'bread', at: ms(3) },
      ];
      expect(manualOrderEntries(['bread', 'milk'], [milk, checkedEggs, bread], previous)).toEqual([
        { id: 'eggs', at: ms(2) },
        { id: 'bread', at: ms(3) },
        { id: 'milk', at: ms(1) },
      ]);
    });

    it('keeps a checked item’s saved at, so re-adding it later still counts as new', () => {
      const checkedEggs = item('eggs', [['c2', 2]], { checked: true });
      const entries = manualOrderEntries(['milk'], [milk, checkedEggs], [{ id: 'eggs', at: ms(2) }, { id: 'milk', at: ms(1) }]);
      expect(entries).toEqual([
        { id: 'eggs', at: ms(2) },
        { id: 'milk', at: ms(1) },
      ]);
      expect(view([milk, item('eggs', [['c9', 20]])], entries)).toEqual(['eggs', 'milk']);
    });

    it('drops entries for items that are gone, and does not keep a checked item that was never saved', () => {
      const checkedJam = item('jam', [['c5', 5]], { checked: true });
      const previous = [
        { id: 'gone', at: ms(4) },
        { id: 'milk', at: ms(1) },
        { id: 'eggs', at: ms(2) },
      ];
      expect(manualOrderEntries(['eggs', 'milk'], [milk, eggs, checkedJam], previous)).toEqual([
        { id: 'eggs', at: ms(2) },
        { id: 'milk', at: ms(1) },
      ]);
    });

    it('skips ids on screen that are not items, and ids repeated', () => {
      expect(manualOrderEntries(['milk', 'ghost', 'milk', 'eggs'], [milk, eggs], [])).toEqual([
        { id: 'milk', at: ms(1) },
        { id: 'eggs', at: ms(2) },
      ]);
    });
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
  it('says what the item is now, with the name in bold and sentence case', () => {
    expect(addedToast('milk', '1 gal + 1')).toEqual({ message: 'Added to Milk, now 1 gal + 1', emphasis: 'Milk' });
  });

  it('leaves out the total when there is none', () => {
    expect(addedToast('milk', '')).toEqual({ message: 'Added to Milk', emphasis: 'Milk' });
    expect(addedToast('milk', null)).toEqual({ message: 'Added to Milk', emphasis: 'Milk' });
    expect(addedToast('milk', undefined)).toEqual({ message: 'Added to Milk', emphasis: 'Milk' });
  });

  it('leaves a name that starts with a capital or a digit as stored', () => {
    expect(addedToast('iPhone charger', null)).toEqual({ message: 'Added to iPhone charger', emphasis: 'iPhone charger' });
    expect(addedToast('2% milk', '2 gal')).toEqual({ message: 'Added to 2% milk, now 2 gal', emphasis: '2% milk' });
  });
});

describe('deletedToast', () => {
  it('names the deleted item in bold, in sentence case', () => {
    expect(deletedToast('chicken thighs')).toEqual({ message: 'Deleted Chicken thighs', emphasis: 'Chicken thighs' });
    expect(deletedToast('Oat milk')).toEqual({ message: 'Deleted Oat milk', emphasis: 'Oat milk' });
    expect(deletedToast('iPhone charger')).toEqual({ message: 'Deleted iPhone charger', emphasis: 'iPhone charger' });
  });
});

describe('clearedToast and clearCheckedLabel', () => {
  it('counts the cleared items, singular for one', () => {
    expect(clearedToast(3)).toEqual({ message: 'Cleared 3 items' });
    expect(clearedToast(1)).toEqual({ message: 'Cleared 1 item' });
    expect(clearedToast(0)).toEqual({ message: 'Cleared 0 items' });
  });

  it('labels the Clear button with how many checked items it clears', () => {
    expect(clearCheckedLabel(3)).toBe('Clear 3 checked items');
    expect(clearCheckedLabel(1)).toBe('Clear 1 checked item');
    expect(clearCheckedLabel(12)).toBe('Clear 12 checked items');
  });

  it('counts the items Uncheck all unchecked, singular for one', () => {
    expect(uncheckedAllToast(6)).toEqual({ message: 'Unchecked 6 items' });
    expect(uncheckedAllToast(1)).toEqual({ message: 'Unchecked 1 item' });
    expect(uncheckedAllToast(2)).toEqual({ message: 'Unchecked 2 items' });
  });
});

describe('movedToast', () => {
  it('reads a Combine as an add would', () => {
    expect(movedToast({ kind: 'combine', name: 'milk', totalAmountText: '2 gal', fromListName: 'Groceries' })).toEqual({
      message: 'Added to Milk, now 2 gal',
      emphasis: 'Milk',
    });
  });

  it('says where a moved or reopened item came from', () => {
    expect(movedToast({ kind: 'new', name: 'chicken thighs', fromListName: 'Groceries' })).toEqual({
      message: 'Moved Chicken thighs from Groceries',
      emphasis: 'Chicken thighs',
    });
    expect(movedToast({ kind: 'reopen', name: 'milk', fromListName: 'Costco' })).toEqual({
      message: 'Moved Milk from Costco',
      emphasis: 'Milk',
    });
  });

  it('leaves the list off when its name is missing', () => {
    expect(movedToast({ kind: 'new', name: 'milk', fromListName: '' })).toEqual({ message: 'Moved Milk', emphasis: 'Milk' });
  });

  it("doesn't change the list's name", () => {
    expect(movedToast({ kind: 'new', name: 'milk', fromListName: 'costco run' }).message).toBe('Moved Milk from costco run');
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
    expect(compactHeaderSubtitle(8, 'newest')).toBe('8 to get · As added');
    expect(compactHeaderSubtitle(1, 'category')).toBe('1 to get · By aisle');
    expect(compactHeaderSubtitle(0, 'recipe')).toBe('By recipe');
    expect(compactHeaderSubtitle(0, 'newest', 2)).toBe('All done · As added');
  });

  it('checks the typed name, without its amount, against items', () => {
    expect(duplicateQuery('chi')).toBe('chi');
    expect(duplicateQuery('2 lbs Chicken Thighs')).toBe('chicken thigh');
    expect(duplicateQuery('c')).toBeNull();
    expect(duplicateQuery('  ')).toBeNull();
  });

  describe('already on list: whole words only (spec 4.2)', () => {
    // As the list stores them: the item's key, normalized from its name.
    const on = (name: string, typed: string, checkedAt: Date | null = null) =>
      isAlreadyOnList({ ingredientName: normalizeIngredientName(name), checkedAt }, duplicateQuery(typed));

    it('marks an item whose name is the typed name, or has it as whole words', () => {
      expect(on('Cumin', 'cumin')).toBe(true);
      expect(on('Ground cumin', 'cumin')).toBe(true);
      expect(on('Chicken thighs', 'chicken')).toBe(true);
      expect(on('Chicken thighs', 'chicken thighs')).toBe(true);
      expect(on('Chicken broth', 'broth')).toBe(true);
      expect(on('Chicken broth', '2 cups Chicken Broth')).toBe(true);
    });

    it('marks nothing for part of a word', () => {
      expect(on('Cumin', 'cum')).toBe(false);
      expect(on('Cumin', 'cumi')).toBe(false);
      expect(on('Ground cumin', 'cum')).toBe(false);
      expect(on('Cucumber', 'cum')).toBe(false);
      expect(on('Chicken thighs', 'chicken th')).toBe(false);
      expect(on('Chicken thighs', 'chi')).toBe(false);
      expect(on('Licorice', 'rice')).toBe(false);
    });

    it('lines up plurals because both sides are normalized', () => {
      expect(on('Peas', 'pea')).toBe(true);
      expect(on('Peanut butter', 'pea')).toBe(false);
      expect(on('Egg', 'eggs')).toBe(true);
      expect(on('Eggs', 'egg')).toBe(true);
      expect(on('Eggs benedict', 'eggs')).toBe(true);
    });

    it('needs the words in order and next to each other', () => {
      expect(on('Chicken thighs', 'thigh chicken')).toBe(false);
      expect(on('Chicken thighs', 'chicken thighs boneless')).toBe(false);
      expect(on('Red wine vinegar', 'red vinegar')).toBe(false);
      expect(on('Red wine vinegar', 'wine vinegar')).toBe(true);
    });

    it('never marks a checked item, and nothing without a query', () => {
      expect(on('Cumin', 'cumin', new Date())).toBe(false);
      expect(on('Ground cumin', 'cumin', new Date())).toBe(false);
      expect(on('Cumin', 'c')).toBe(false);
      expect(isAlreadyOnList({ ingredientName: 'cumin', checkedAt: null }, null)).toBe(false);
    });

    describe('across a family (spec 4.15)', () => {
      // `pepino` → `cucumber` (linked); `tomate` and `tomato` unlinked. `family` is the typed key's family key.
      const item = (ingredientName: string, familyKey: string, checkedAt: Date | null = null) => ({
        ingredientName,
        familyKey,
        checkedAt,
      });
      const cucumber = item('cucumber', 'cucumber');
      const pepino = item('pepino', 'cucumber');

      it('with no family (the household doesn\'t combine languages), compares own keys only', () => {
        expect(alreadyOnListMatch(cucumber, 'pepino', null)).toBeNull();
        expect(alreadyOnListMatch(pepino, 'cucumber', null)).toBeNull();
        expect(alreadyOnListMatch(pepino, 'pepino', null)).toBe('pepino');
        expect(alreadyOnListMatch(item('english cucumber', 'english cucumber'), 'cucumber', null)).toBe('cucumber');
        expect(isAlreadyOnList(cucumber, 'pepino', null)).toBe(false);
      });

      it('marks Cucumber when pepino is typed, matching the family key', () => {
        expect(alreadyOnListMatch(cucumber, 'pepino', 'cucumber')).toBe('cucumber');
        expect(isAlreadyOnList(cucumber, 'pepino', 'cucumber')).toBe(true);
      });

      it('marks Pepino when cucumber is typed', () => {
        expect(alreadyOnListMatch(pepino, 'cucumber', 'cucumber')).toBe('cucumber');
      });

      it('prefers the typed key when the item has it, so its own name highlights', () => {
        expect(alreadyOnListMatch(pepino, 'pepino', 'cucumber')).toBe('pepino');
      });

      it('compares family keys as whole words, as the typed key', () => {
        expect(alreadyOnListMatch(item('english cucumber', 'english cucumber'), 'pepino', 'cucumber')).toBe('cucumber');
        expect(alreadyOnListMatch(cucumber, 'pepin', 'pepin')).toBeNull();
        expect(alreadyOnListMatch(item('leche de avena', 'oat milk'), 'milk', 'milk')).toBe('milk');
      });

      it('leaves an unlinked pair apart', () => {
        expect(isAlreadyOnList(item('tomato', 'tomato'), 'tomate', 'tomate')).toBe(false);
        expect(isAlreadyOnList(item('tomate', 'tomate'), 'tomato', 'tomato')).toBe(false);
      });

      it('never marks a checked twin, and nothing without a query', () => {
        expect(alreadyOnListMatch(item('cucumber', 'cucumber', new Date()), 'pepino', 'cucumber')).toBeNull();
        expect(alreadyOnListMatch(item('pepino', 'cucumber', new Date()), 'cucumber', 'cucumber')).toBeNull();
        expect(alreadyOnListMatch(cucumber, null, 'cucumber')).toBeNull();
      });

      it('without a family key, compares the item key (as before links)', () => {
        expect(alreadyOnListMatch({ ingredientName: 'cucumber', checkedAt: null }, 'pepino', 'cucumber')).toBe('cucumber');
        expect(alreadyOnListMatch({ ingredientName: 'cucumber', checkedAt: null }, 'cucumber')).toBe('cucumber');
        expect(alreadyOnListMatch({ ingredientName: 'pepino', checkedAt: null }, 'cucumber')).toBeNull();
      });
    });

    it('highlights the matched word(s) of the name', () => {
      expect(alreadyOnListParts('Ground cumin', 'cumin')).toEqual({ before: 'Ground ', match: 'cumin', after: '' });
      expect(alreadyOnListParts('Chicken Thighs', 'chicken')).toEqual({ before: '', match: 'Chicken', after: ' Thighs' });
      expect(alreadyOnListParts('Chicken Thighs', 'chicken thigh')).toEqual({ before: '', match: 'Chicken Thighs', after: '' });
      expect(alreadyOnListParts('Peas', 'pea')).toEqual({ before: '', match: 'Peas', after: '' });
      expect(alreadyOnListParts('Egg', 'egg')).toEqual({ before: '', match: 'Egg', after: '' });
      expect(alreadyOnListParts('Red wine vinegar', 'wine vinegar')).toEqual({
        before: 'Red ',
        match: 'wine vinegar',
        after: '',
      });
    });

    it('highlights through punctuation in the name as the key ignores it', () => {
      expect(alreadyOnListParts('Half-and-half', 'half and half')).toEqual({ before: '', match: 'Half-and-half', after: '' });
      expect(alreadyOnListParts("Za'atar, ground", 'zaatar')).toEqual({ before: '', match: "Za'atar", after: ', ground' });
    });

    it('highlights nothing for part of a word or a name without the words', () => {
      expect(alreadyOnListParts('Licorice', 'rice')).toBeNull();
      expect(alreadyOnListParts('Peanut butter', 'pea')).toBeNull();
      expect(alreadyOnListParts('Milk', 'eggs')).toBeNull();
      expect(alreadyOnListParts('', 'milk')).toBeNull();
    });
  });
});

describe('readItemRowStyle', () => {
  it('reads a saved choice', () => {
    expect(readItemRowStyle('white')).toBe('white');
    expect(readItemRowStyle('bands')).toBe('bands');
  });

  it('reads the old White tiles choice as White rows', () => {
    expect(readItemRowStyle('tiles')).toBe('white');
  });

  it('is the colour bands default for nothing saved or anything unknown', () => {
    expect(readItemRowStyle(null)).toBe('bands');
    expect(readItemRowStyle('stripes')).toBe('bands');
  });
});

describe('readAisleColorStyle', () => {
  it('reads a saved choice', () => {
    expect(readAisleColorStyle('header')).toBe('header');
    expect(readAisleColorStyle('rows')).toBe('rows');
  });

  it('is the whole-row default for nothing saved or anything unknown', () => {
    expect(readAisleColorStyle(null)).toBe('rows');
    expect(readAisleColorStyle('stripes')).toBe('rows');
    expect(readAisleColorStyle(1)).toBe('rows');
  });

  it('labels each choice', () => {
    expect(aisleColorStyleLabel('rows')).toBe('Whole row');
    expect(aisleColorStyleLabel('header')).toBe('Header only');
  });
});

describe('listsOverview', () => {
  const tile = (id: string, householdId: string) => ({ id, householdId });

  it('has no household UI with one household', () => {
    const lists = [tile('a', 'h1'), tile('b', 'h1')];
    expect(listsOverview([{ id: 'h1', name: 'Home' }], lists, 'h1')).toEqual({ kind: 'single', householdId: 'h1', lists });
  });

  it('gives each of several households a section: primary first, then by name, empty ones too', () => {
    const overview = listsOverview(
      [
        { id: 'h1', name: 'Peacher Paschal Fam' },
        { id: 'h2', name: 'test fam' },
        { id: 'h3', name: 'Lake house' },
      ],
      [tile('a', 'h2'), tile('b', 'h1'), tile('c', 'h2')],
      'h1',
    );
    expect(overview.kind === 'multi' && overview.sections.map((s) => [s.householdId, s.lists.map((l) => l.id)])).toEqual([
      ['h1', ['b']],
      ['h3', []],
      ['h2', ['a', 'c']],
    ]);
  });

  it('goes back to one layout when a household is left', () => {
    expect(listsOverview([{ id: 'h2', name: 'test fam' }], [tile('a', 'h2')], 'h2').kind).toBe('single');
  });
});

describe('householdHeaderLabel', () => {
  it('reads the name, with the member count when known', () => {
    expect(householdHeaderLabel('test fam', 2)).toBe('test fam, 2 members');
    expect(householdHeaderLabel('Solo', 1)).toBe('Solo, 1 member');
    expect(householdHeaderLabel('test fam')).toBe('test fam');
  });
});
