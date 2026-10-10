import { expect, test } from '@jest/globals';

import { setRecipeAddResult, takeRecipeAddResult } from '../recipe-add-result';

const result = { listId: 'groceries', recipeId: 'tacos', recipeName: 'Tacos', count: 3 };

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
  expect(takeRecipeAddResult('groceries')).toEqual({ listId: 'groceries', recipeId: 'dal', recipeName: 'Dal', count: 1 });
});
