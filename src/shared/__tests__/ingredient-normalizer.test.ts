import { describe, expect, it } from '@jest/globals';

import { normalizeIngredientName, singularize } from '../ingredient-normalizer';

describe('normalizeIngredientName', () => {
  it.each([
    ['Milk', 'milk'],
    ['  Chicken   Thighs ', 'chicken thigh'],
    ['Cherry Tomatoes!', 'cherry tomato'],
    ["Za'atar", 'zaatar'],
    ['half-and-half', 'half and half'],
    ['Jalapeños', 'jalapeño'],
    ['2% milk', '2 milk'],
    ['', ''],
    ['!!!', ''],
  ])('%s → %s', (input, expected) => {
    expect(normalizeIngredientName(input)).toBe(expected);
  });

  it('only singularizes the last word', () => {
    expect(normalizeIngredientName('Brussels sprouts')).toBe('brussels sprout');
    expect(normalizeIngredientName('peas and carrots')).toBe('peas and carrot');
  });
});

describe('singularize', () => {
  it.each([
    ['tomatoes', 'tomato'],
    ['potatoes', 'potato'],
    ['berries', 'berry'],
    ['anchovies', 'anchovy'],
    ['peaches', 'peach'],
    ['radishes', 'radish'],
    ['boxes', 'box'],
    ['glasses', 'glass'],
    ['eggs', 'egg'],
    ['limes', 'lime'],
    ['olives', 'olive'],
    ['cheeses', 'cheese'],
    ['avocados', 'avocado'],
    ['leaves', 'leaf'],
    ['cookies', 'cookie'],
    ['pies', 'pie'],
  ])('%s → %s', (plural, singular) => {
    expect(singularize(plural)).toBe(singular);
  });

  it.each(['hummus', 'asparagus', 'molasses', 'grits', 'couscous', 'watercress', 'citrus', 'egg', 'is'])(
    'leaves %s alone',
    (word) => {
      expect(singularize(word)).toBe(word);
    },
  );
});
