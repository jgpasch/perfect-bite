// Searching the Recipes tab (spec 4.14): names and ingredients, ignoring case and accents.
import { describe, expect, test } from '@jest/globals';

import { foldForSearch, recipeSearchPlaceholder, searchRecipes } from '../recipe-search';

const RECIPES = [
  { id: 'r1', name: 'Chicken tikka masala' },
  { id: 'r2', name: 'Weeknight tacos' },
  { id: 'r3', name: 'Crème brûlée' },
  { id: 'r4', name: 'Pho' },
];
const INGREDIENTS = [
  { recipeId: 'r2', displayName: 'tortillas' },
  { recipeId: 'r2', displayName: 'Chicken thighs' },
  { recipeId: 'r2', displayName: 'chicken stock' },
  { recipeId: 'r3', displayName: 'cream' },
  { recipeId: 'r4', displayName: 'Jalapeño' },
  { recipeId: 'r1', displayName: 'chicken breast' },
];

const names = (query: string) => searchRecipes(RECIPES, INGREDIENTS, query).map((r) => [r.recipe.name, r.ingredientMatch]);

describe('foldForSearch', () => {
  test('lower-cases, strips accents and collapses spaces', () => {
    expect(foldForSearch('  Crème   Brûlée ')).toBe('creme brulee');
    expect(foldForSearch('JALAPEÑO')).toBe('jalapeno');
    expect(foldForSearch('')).toBe('');
  });
});

describe('searchRecipes', () => {
  test('a blank query keeps every recipe in order, with no "Has" line', () => {
    expect(names('')).toEqual(RECIPES.map((r) => [r.name, null]));
    expect(names('   ')).toEqual(RECIPES.map((r) => [r.name, null]));
  });

  test('matches recipe names anywhere in the name', () => {
    expect(names('taco')).toEqual([['Weeknight tacos', null]]);
    expect(names('masala')).toEqual([['Chicken tikka masala', null]]);
  });

  test('matches ingredients, with the first matching ingredient as the "Has" line', () => {
    expect(names('thigh')).toEqual([['Weeknight tacos', 'Chicken thighs']]);
    // r2's first chicken ingredient is the thighs, not the stock.
    expect(names('chicken')).toEqual([
      ['Chicken tikka masala', null],
      ['Weeknight tacos', 'Chicken thighs'],
    ]);
  });

  test('a recipe matching by name gets no "Has" line even if an ingredient matches too', () => {
    expect(names('chicken')[0]).toEqual(['Chicken tikka masala', null]);
  });

  test('ignores case and accents in both directions', () => {
    expect(names('CREME')).toEqual([['Crème brûlée', null]]);
    expect(names('brûlée')).toEqual([['Crème brûlée', null]]);
    expect(names('jalapeno')).toEqual([['Pho', 'Jalapeño']]);
    expect(names('JALAPEÑO')).toEqual([['Pho', 'Jalapeño']]);
    expect(names('crêam')).toEqual([['Crème brûlée', 'cream']]);
  });

  test('extra spaces in the query are ignored', () => {
    expect(names('  chicken   thighs ')).toEqual([['Weeknight tacos', 'Chicken thighs']]);
  });

  test('no match gives no results', () => {
    expect(names('lasagne')).toEqual([]);
  });

  test("an ingredient of a recipe that isn't in the list doesn't match", () => {
    expect(searchRecipes(RECIPES, [{ recipeId: 'gone', displayName: 'saffron' }], 'saffron')).toEqual([]);
  });
});

describe('recipeSearchPlaceholder', () => {
  test('counts the recipes', () => {
    expect(recipeSearchPlaceholder(1)).toBe('Search 1 recipe');
    expect(recipeSearchPlaceholder(52)).toBe('Search 52 recipes');
    expect(recipeSearchPlaceholder(0)).toBe('Search 0 recipes');
  });
});
