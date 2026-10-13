import { describe, expect, test } from '@jest/globals';

import {
  addCtaLabel,
  addedRecipeToListToast,
  addedToRecipeToast,
  addToRecipeTitle,
  groupRecipesByHousehold,
  ingredientCountLabel,
  onListByRecipe,
  orderByLastUse,
  recipeCardLabel,
  recipeSuggestionDetail,
  recipeSuggestionLabel,
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

  test('a card matched only through an ingredient reads it in place of the count', () => {
    expect(recipeCardLabel('Tacos', 9, 'Groceries', 'chicken thighs')).toBe('Tacos, has chicken thighs, on Groceries');
    expect(recipeCardLabel('Tacos', 9, null, 'chicken thighs')).toBe('Tacos, has chicken thighs');
    expect(recipeCardLabel('Tacos', 9, null, null)).toBe('Tacos, 9 ingredients');
  });

  test('servings use ½ for a half and × after the number', () => {
    expect([0.5, 1, 2, 3].map(servingsLabel)).toEqual(['½×', '1×', '2×', '3×']);
  });

  test('the add CTA counts what is ticked', () => {
    expect(addCtaLabel(8, 'Groceries')).toBe('Add 8 to Groceries');
    expect(addCtaLabel(1, 'Costco')).toBe('Add 1 to Costco');
    expect(addCtaLabel(0, 'Groceries')).toBe('Nothing selected');
  });

  test('the toast after adding a recipe names it and counts its items', () => {
    expect(addedRecipeToListToast('Tacos', 8)).toEqual({ message: 'Added Tacos · 8 items', emphasis: 'Tacos' });
    expect(addedRecipeToListToast('Toast', 1)).toEqual({ message: 'Added Toast · 1 item', emphasis: 'Toast' });
    expect(addedRecipeToListToast('Tacos', 0)).toEqual({ message: 'Added Tacos · 0 items', emphasis: 'Tacos' });
  });

  test("an add bar recipe row says it's a recipe and counts its items", () => {
    expect(recipeSuggestionDetail(8)).toBe('Recipe · 8 items');
    expect(recipeSuggestionDetail(1)).toBe('Recipe · 1 item');
    expect(recipeSuggestionDetail(0)).toBe('Recipe · 0 items');
    expect(recipeSuggestionLabel('Tacos', 8)).toBe('Add recipe Tacos, 8 items');
    expect(recipeSuggestionLabel('Toast', 1)).toBe('Add recipe Toast, 1 item');
  });
});
