import { describe, expect, test } from '@jest/globals';

import {
  setRecipeAddResult,
  startAdjust,
  takeAdjust,
  takeRecipeAddResult,
  type AdjustableAdd,
  type RecipeAddResult,
} from '../recipe-add-result';

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

test('an imported recipe carries its undo, and only its list takes it', () => {
  let undone = 0;
  const undo = () => {
    undone += 1;
  };
  setRecipeAddResult({ kind: 'imported', listId: 'costco', recipeId: 'tikka', recipeName: 'Chicken tikka masala', count: 12, undo });
  expect(takeRecipeAddResult('groceries')).toBeNull();
  const taken = takeRecipeAddResult('costco');
  expect(taken).toEqual({ kind: 'imported', listId: 'costco', recipeId: 'tikka', recipeName: 'Chicken tikka masala', count: 12, undo });
  if (taken?.kind !== 'imported') throw new Error('expected an import');
  taken.undo();
  expect(undone).toBe(1);
  expect(takeRecipeAddResult('costco')).toBeNull();
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

describe('Adjust (spec 4.2)', () => {
  const added = { itemId: 'i1', contributionId: 'c1', kind: 'new' as const, pendingNames: [] };
  const tacosAdd: AdjustableAdd = { listId: 'groceries', recipeId: 'tacos', results: [added] };

  test('the sheet takes the add its token names, once', () => {
    const token = startAdjust(tacosAdd);
    expect(takeAdjust(token, 'tacos')).toEqual(tacosAdd);
    expect(takeAdjust(token, 'tacos')).toBeNull();
  });

  test('no token (the sheet opened from the recipe screen) replaces nothing, and keeps the pending add', () => {
    const token = startAdjust(tacosAdd);
    expect(takeAdjust(undefined, 'tacos')).toBeNull();
    expect(takeAdjust('', 'tacos')).toBeNull();
    expect(takeAdjust(token, 'tacos')).toEqual(tacosAdd);
  });

  test('another recipe, or a stale token, replaces nothing', () => {
    const stale = startAdjust(tacosAdd);
    const dalAdd = { ...tacosAdd, recipeId: 'dal' };
    const token = startAdjust(dalAdd);
    expect(token).not.toBe(stale);
    expect(takeAdjust(stale, 'tacos')).toBeNull();
    expect(takeAdjust(token, 'tacos')).toBeNull();
    expect(takeAdjust(token, 'dal')).toEqual(dalAdd);
  });
});
