import { expect, test } from '@jest/globals';

import { setRecipeAddResult, takeRecipeAddResult, type RecipeAddResult } from '../recipe-add-result';

const result: RecipeAddResult = { kind: 'toRecipe', listId: 'groceries', recipeId: 'tacos', recipeName: 'Tacos', count: 3 };

test('the list screen takes the result once', () => {
  setRecipeAddResult(result);
  expect(takeRecipeAddResult('groceries')).toEqual(result);
  expect(takeRecipeAddResult('groceries')).toBeNull();
});

test('another list does not take it, and nothing pending is null', () => {
  expect(takeRecipeAddResult('groceries')).toBeNull();
  setRecipeAddResult(result);
  expect(takeRecipeAddResult('costco')).toBeNull();
  expect(takeRecipeAddResult('groceries')).toEqual(result);
});

test('a newer result replaces one not yet taken', () => {
  setRecipeAddResult(result);
  setRecipeAddResult({ ...result, recipeId: 'dal', recipeName: 'Dal', count: 1 });
  expect(takeRecipeAddResult('groceries')).toEqual({ kind: 'toRecipe', listId: 'groceries', recipeId: 'dal', recipeName: 'Dal', count: 1 });
});

test('a recipe added to the list carries its adds, for Undo', () => {
  const added = { itemId: 'i1', contributionId: 'c1', kind: 'new' as const, pendingNames: [] };
  setRecipeAddResult(result);
  setRecipeAddResult({ kind: 'toList', listId: 'groceries', recipeId: 'tacos', recipeName: 'Tacos', count: 1, results: [added, null] });
  expect(takeRecipeAddResult('groceries')).toEqual({
    kind: 'toList',
    listId: 'groceries',
    recipeId: 'tacos',
    recipeName: 'Tacos',
    count: 1,
    results: [added, null],
  });
  expect(takeRecipeAddResult('groceries')).toBeNull();
});
