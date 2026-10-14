import { describe, expect, it } from '@jest/globals';

import { foldAccents, normalizeIngredientName, singularize } from '../ingredient-normalizer';

describe('normalizeIngredientName', () => {
  it.each([
    ['Milk', 'milk'],
    ['  Chicken   Thighs ', 'chicken thigh'],
    ['Cherry Tomatoes!', 'cherry tomato'],
    ["Za'atar", 'zaatar'],
    ['half-and-half', 'half and half'],
    ['Jalapeños', 'jalapeno'],
    ['2% milk', '2 milk'],
    ['', ''],
    ['!!!', ''],
  ])('%s → %s', (input, expected) => {
    expect(normalizeIngredientName(input)).toBe(expected);
  });

  it.each([
    ['limón', 'limon'],
    ['Limón', 'limon'],
    ['jalapeño', 'jalapeno'],
    ['crème fraîche', 'creme fraiche'],
    ['Crème brûlée', 'creme brulee'],
    ['piñas', 'pina'],
    ['café bustelo', 'cafe bustelo'],
    ['Gruyère', 'gruyere'],
    ['açaí', 'acai'],
    // Decomposed input (o + U+0301) folds the same as the precomposed letter.
    ['limón', 'limon'],
  ])('folds accents: %s → %s', (input, expected) => {
    expect(normalizeIngredientName(input)).toBe(expected);
  });

  it('gives accented and plain spellings one key', () => {
    expect(normalizeIngredientName('Jalapeños')).toBe(normalizeIngredientName('jalapenos'));
    expect(normalizeIngredientName('tajín')).toBe(normalizeIngredientName('Tajin'));
  });
});

describe('foldAccents', () => {
  it.each([
    ['limón', 'limon'],
    ['ÑANDÚ', 'NANDU'],
    ['crème fraîche', 'creme fraiche'],
    ['plain', 'plain'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(foldAccents(input)).toBe(expected);
  });

  it('keeps letters with no decomposition and other scripts', () => {
    expect(foldAccents('straße')).toBe('straße');
    expect(foldAccents('smørrebrød')).toBe('smørrebrød');
    // Japanese voiced kana decompose to a mark outside U+0300–U+036F and recompose.
    expect(foldAccents('が')).toBe('が');
    expect(foldAccents('हिंदी')).toBe('हिंदी');
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
