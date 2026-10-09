import { describe, expect, it } from '@jest/globals';

import { OTHER_CATEGORY_ID } from '@/shared';

import { effectiveCategoryId, groupByCategory, orderCategories } from '../category-resolver';

describe('effectiveCategoryId', () => {
  it('prefers the override, then the default, then Other', () => {
    expect(effectiveCategoryId('mine', 'global')).toBe('mine');
    expect(effectiveCategoryId(null, 'global')).toBe('global');
    expect(effectiveCategoryId(null, null)).toBe(OTHER_CATEGORY_ID);
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
});
