import { describe, expect, it } from '@jest/globals';

import { OTHER_CATEGORY_ID } from '@/shared';

import {
  effectiveCategoryId,
  groupByCategory,
  orderCategories,
  SORTING_CATEGORY_ID,
} from '../category-resolver';

describe('effectiveCategoryId', () => {
  it('prefers the override, then the default', () => {
    expect(effectiveCategoryId('mine', 'global', 'categorized')).toBe('mine');
    expect(effectiveCategoryId(null, 'global', 'categorized')).toBe('global');
  });

  it('lets the override beat a pending or failed ingredient', () => {
    expect(effectiveCategoryId('mine', null, 'pending')).toBe('mine');
    expect(effectiveCategoryId('mine', null, null)).toBe('mine');
    expect(effectiveCategoryId('mine', null, 'failed')).toBe('mine');
  });

  it('lets the default beat a missing or pending status', () => {
    expect(effectiveCategoryId(null, 'global', null)).toBe('global');
    expect(effectiveCategoryId(null, 'global', 'pending')).toBe('global');
  });

  it('shows pending and unknown ingredients under Sorting', () => {
    expect(SORTING_CATEGORY_ID).toBe('sorting');
    expect(effectiveCategoryId(null, null, 'pending')).toBe(SORTING_CATEGORY_ID);
    expect(effectiveCategoryId(null, null, null)).toBe(SORTING_CATEGORY_ID);
  });

  it('sends failed ingredients, and categorized ones with no default, to Other', () => {
    expect(effectiveCategoryId(null, null, 'failed')).toBe(OTHER_CATEGORY_ID);
    expect(effectiveCategoryId(null, null, 'categorized')).toBe(OTHER_CATEGORY_ID);
  });
});

const cat = (id: string, defaultRank: number | null, position: number | null = null) => ({
  id,
  name: id,
  defaultRank,
  position,
});

describe('orderCategories', () => {
  it('uses store-walk order with custom categories at the end', () => {
    const ordered = orderCategories([cat('zebra', null), cat('dairy', 5), cat('produce', 1), cat('apple', null)]);
    expect(ordered.map((c) => c.id)).toEqual(['produce', 'dairy', 'apple', 'zebra']);
  });

  it('puts the categories the user placed first, by position', () => {
    const ordered = orderCategories([cat('produce', 1, 2), cat('dairy', 5, 1), cat('frozen', 6), cat('mine', null)]);
    expect(ordered.map((c) => c.id)).toEqual(['dairy', 'produce', 'frozen', 'mine']);
  });
});

describe('groupByCategory', () => {
  const categories = [{ id: 'produce' }, { id: 'dairy' }, { id: OTHER_CATEGORY_ID }];

  it('groups in category order and hides empty sections', () => {
    const sections = groupByCategory(categories, [
      { name: 'milk', categoryId: 'dairy' },
      { name: 'kale', categoryId: 'produce' },
      { name: 'eggs', categoryId: 'dairy' },
    ]);
    expect(sections.map((s) => [s.category.id, s.items.map((i) => i.name)])).toEqual([
      ['produce', ['kale']],
      ['dairy', ['milk', 'eggs']],
    ]);
  });

  it('sends items in unknown categories to Other', () => {
    const sections = groupByCategory(categories, [{ name: 'x', categoryId: 'deleted-custom' }]);
    expect(sections.map((s) => s.category.id)).toEqual([OTHER_CATEGORY_ID]);
  });

  it('puts Sorting first, whatever the user order', () => {
    const items = [
      { name: 'milk', categoryId: 'dairy' },
      { name: 'dukkah', categoryId: SORTING_CATEGORY_ID },
      { name: 'x', categoryId: OTHER_CATEGORY_ID },
      { name: 'kale', categoryId: 'produce' },
      { name: 'yuzu kosho', categoryId: SORTING_CATEGORY_ID },
    ];
    const reordered = [{ id: OTHER_CATEGORY_ID }, { id: 'dairy' }, { id: 'produce' }];
    for (const order of [categories, reordered]) {
      const sections = groupByCategory(order, items);
      expect(sections[0].category).toEqual({ id: SORTING_CATEGORY_ID, name: 'Sorting...' });
      expect(sections[0].items.map((i) => i.name)).toEqual(['dukkah', 'yuzu kosho']);
    }
    expect(groupByCategory(reordered, items).map((s) => s.category.id)).toEqual([
      SORTING_CATEGORY_ID,
      OTHER_CATEGORY_ID,
      'dairy',
      'produce',
    ]);
  });

  it('hides an empty Sorting section', () => {
    const sections = groupByCategory(categories, [{ name: 'milk', categoryId: 'dairy' }]);
    expect(sections.map((s) => s.category.id)).toEqual(['dairy']);
    expect(groupByCategory(categories, [])).toEqual([]);
  });
});
