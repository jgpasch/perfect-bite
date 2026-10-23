import { describe, expect, it } from '@jest/globals';

import { OTHER_CATEGORY_ID } from '@/shared';

import {
  categoryNameById,
  effectiveCategoryId,
  groupByCategory,
  sectionAccessibilityLabel,
  SORTING_CATEGORY,
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

describe('sectionAccessibilityLabel', () => {
  it('explains the Sorting section', () => {
    expect(sectionAccessibilityLabel(SORTING_CATEGORY)).toBe('Sorting, finding a section for these items');
  });

  it('reads other sections by name, even one named like Sorting', () => {
    expect(sectionAccessibilityLabel({ id: 'dairy', name: 'Dairy & Eggs' })).toBe('Dairy & Eggs');
    expect(sectionAccessibilityLabel({ id: 'custom', name: 'Sorting...' })).toBe('Sorting...');
  });
});

describe('categoryNameById', () => {
  const categories = [
    { id: 'dairy', name: 'Dairy & Eggs' },
    { id: OTHER_CATEGORY_ID, name: 'Other' },
  ];

  it('names Sorting, which is not in the list', () => {
    expect(categoryNameById(categories, SORTING_CATEGORY_ID)).toBe('Sorting...');
    expect(categoryNameById([], SORTING_CATEGORY_ID)).toBe('Sorting...');
  });

  it('finds a category by id', () => {
    expect(categoryNameById(categories, 'dairy')).toBe('Dairy & Eggs');
  });

  it('falls back to Other for an unknown id', () => {
    expect(categoryNameById(categories, 'deleted')).toBe('Other');
    expect(categoryNameById([], 'dairy')).toBe('Other');
  });
});
