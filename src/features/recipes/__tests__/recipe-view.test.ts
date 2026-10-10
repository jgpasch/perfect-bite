import { describe, expect, test } from '@jest/globals';

import {
  addCtaLabel,
  addedToRecipeToast,
  addToRecipeTitle,
  conflictResult,
  conflictTitle,
  groupRecipesByHousehold,
  ingredientCountLabel,
  keepLabel,
  onListByRecipe,
  orderByLastUse,
  recipeCardLabel,
  servingsLabel,
} from '../recipe-view';

describe('orderByLastUse', () => {
  const r = (id: string, name: string, updatedAt: string) => ({ id, name, updatedAt: new Date(updatedAt) });
  const use = (recipeId: string, at: string) => ({ recipeId, at: new Date(at) });

  test('orders by last change when no recipe has been added to a list', () => {
    const out = orderByLastUse([r('a', 'Tacos', '2026-10-01'), r('b', 'Chili', '2026-10-03'), r('c', 'Dal', '2026-10-02')], []);
    expect(out.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  test('a later add to a list counts as a use, and the latest add wins', () => {
    const out = orderByLastUse(
      [r('a', 'Tacos', '2026-10-01'), r('b', 'Chili', '2026-10-03'), r('c', 'Dal', '2026-10-02')],
      [use('a', '2026-09-01'), use('a', '2026-10-05'), use('c', '2026-10-04')],
    );
    expect(out.map((x) => x.id)).toEqual(['a', 'c', 'b']);
  });

  test('an add older than the last change does not move a recipe back', () => {
    const out = orderByLastUse(
      [r('a', 'Tacos', '2026-10-05'), r('b', 'Chili', '2026-10-03')],
      [use('a', '2026-09-01'), use('b', '2026-10-04')],
    );
    expect(out.map((x) => x.id)).toEqual(['a', 'b']);
  });

  test('ties go by name, then id; uses of other recipes are ignored', () => {
    const out = orderByLastUse(
      [r('z', 'Tacos', '2026-10-01'), r('y', 'Chili', '2026-10-01'), r('x', 'Tacos', '2026-10-01')],
      [use('gone', '2026-12-01')],
    );
    expect(out.map((x) => x.id)).toEqual(['y', 'x', 'z']);
  });

  test('empty input, and the input is not mutated', () => {
    expect(orderByLastUse([], [])).toEqual([]);
    const input = [r('a', 'Tacos', '2026-10-01'), r('b', 'Chili', '2026-10-02')];
    expect(orderByLastUse(input, []).map((x) => x.id)).toEqual(['b', 'a']);
    expect(input.map((x) => x.id)).toEqual(['a', 'b']);
  });
});

test('addToRecipeTitle', () => {
  expect(addToRecipeTitle(1)).toBe('Add 1 item to…');
  expect(addToRecipeTitle(3)).toBe('Add 3 items to…');
});

test('addedToRecipeToast', () => {
  expect(addedToRecipeToast(3, 'Tacos')).toEqual({ message: 'Added 3 items to Tacos', emphasis: 'Tacos' });
  expect(addedToRecipeToast(1, 'Weeknight dal')).toEqual({ message: 'Added 1 item to Weeknight dal', emphasis: 'Weeknight dal' });
});

describe('groupRecipesByHousehold', () => {
  const r = (id: string, householdId: string, householdName: string) => ({ id, householdId, householdName });

  test('keeps households in order of their first recipe and recipes in order', () => {
    const groups = groupRecipesByHousehold([
      r('tacos', 'home', 'Our place'),
      r('chili', 'lake', 'Lake house'),
      r('dal', 'home', 'Our place'),
    ]);
    expect(groups.map((g) => [g.householdId, g.name, g.recipes.map((x) => x.id)])).toEqual([
      ['home', 'Our place', ['tacos', 'dal']],
      ['lake', 'Lake house', ['chili']],
    ]);
  });

  test('is empty with no recipes', () => {
    expect(groupRecipesByHousehold([])).toEqual([]);
  });

  test('groups by id, not name: two households can share a name', () => {
    const groups = groupRecipesByHousehold([r('a', 'h1', 'Home'), r('b', 'h2', 'Home')]);
    expect(groups.map((g) => g.householdId)).toEqual(['h1', 'h2']);
  });
});

describe('onListByRecipe', () => {
  const at = (ms: number) => new Date(ms);

  test('picks the most recently added list per recipe, whatever the row order', () => {
    const map = onListByRecipe([
      { recipeId: 'tacos', listName: 'Costco', addedAt: at(30) },
      { recipeId: 'tacos', listName: 'Groceries', addedAt: at(10) },
      { recipeId: 'dal', listName: 'Groceries', addedAt: at(20) },
    ]);
    expect([...map].sort()).toEqual([
      ['dal', 'Groceries'],
      ['tacos', 'Costco'],
    ]);
  });

  test('keeps the first row on a tie', () => {
    const map = onListByRecipe([
      { recipeId: 'tacos', listName: 'Groceries', addedAt: at(5) },
      { recipeId: 'tacos', listName: 'Costco', addedAt: at(5) },
    ]);
    expect(map.get('tacos')).toBe('Groceries');
  });

  test('is empty with no rows', () => {
    expect(onListByRecipe([]).size).toBe(0);
  });
});

describe('labels', () => {
  test('ingredient counts are pluralised', () => {
    expect(ingredientCountLabel(0)).toBe('0 ingredients');
    expect(ingredientCountLabel(1)).toBe('1 ingredient');
    expect(ingredientCountLabel(9)).toBe('9 ingredients');
  });

  test('a recipe card reads its name, count and list', () => {
    expect(recipeCardLabel('Chicken tacos', 9, 'Groceries')).toBe('Chicken tacos, 9 ingredients, on Groceries');
    expect(recipeCardLabel('Dal', 1, null)).toBe('Dal, 1 ingredient');
    expect(recipeCardLabel('Dal', 1)).toBe('Dal, 1 ingredient');
    expect(recipeCardLabel('Dal', 1, '')).toBe('Dal, 1 ingredient');
  });

  test('servings use ½ for a half and × after the number', () => {
    expect([0.5, 1, 2, 3].map(servingsLabel)).toEqual(['½×', '1×', '2×', '3×']);
  });

  test('the add CTA counts what is ticked', () => {
    expect(addCtaLabel(8, 'Groceries')).toBe('Add 8 to Groceries');
    expect(addCtaLabel(1, 'Costco')).toBe('Add 1 to Costco');
    expect(addCtaLabel(0, 'Groceries')).toBe('Nothing selected');
  });

  test('the clash title agrees with the count', () => {
    expect(conflictTitle(2, 'Groceries')).toBe('2 are already on Groceries');
    expect(conflictTitle(1, 'Groceries')).toBe('1 is already on Groceries');
  });
});

describe('conflictResult and keepLabel (board 08)', () => {
  const chicken = { existingAmountText: '2 lb', combinedAmountText: '6 lb', keptAmountText: '2 lb' };

  test('combining shows the new total; keeping shows what stays', () => {
    expect(conflictResult(chicken, false)).toBe('→ 6 lb');
    expect(conflictResult(chicken, true)).toBe('stays 2 lb');
  });

  test('keeping that still changes the total (a recipe’s repeats) shows the new total', () => {
    expect(conflictResult({ existingAmountText: '1 cup', combinedAmountText: '1¾ cup', keptAmountText: '1¼ cup' }, true)).toBe(
      '→ 1¼ cup',
    );
  });

  test('shows nothing when there is no amount', () => {
    const none = { existingAmountText: '', combinedAmountText: '', keptAmountText: '' };
    expect(conflictResult(none, false)).toBe('');
    expect(conflictResult(none, true)).toBe('');
    expect(conflictResult({ existingAmountText: '2', combinedAmountText: '3', keptAmountText: '' }, true)).toBe('');
  });

  test('the Keep segment names the existing amount', () => {
    expect(keepLabel({ existingAmountText: '4' })).toBe('Keep 4');
    expect(keepLabel({ existingAmountText: '' })).toBe('Keep');
  });
});
