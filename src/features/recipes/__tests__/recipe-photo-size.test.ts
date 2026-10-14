// The Recipes tab's photo size (spec 4.5): the stored choice, its labels, and the large photos' grid.
import { afterEach, describe, expect, test } from '@jest/globals';

import { initI18n } from '@/i18n';

import {
  DEFAULT_RECIPE_PHOTO_SIZE,
  gridRows,
  ONE_COLUMN_FONT_SCALE,
  readRecipePhotoSize,
  RECIPE_PHOTO_SIZE_KEY,
  RECIPE_PHOTO_SIZES,
  recipeGridColumns,
  recipePhotoSizeLabel,
} from '../recipe-photo-size';
import { RECIPE_SORT_KEY } from '../recipe-sort';

describe('the stored choice', () => {
  test('small and large read back as themselves', () => {
    expect(RECIPE_PHOTO_SIZES).toEqual(['small', 'large']);
    expect(readRecipePhotoSize('small')).toBe('small');
    expect(readRecipePhotoSize('large')).toBe('large');
  });

  test('anything else is the default, small', () => {
    expect(DEFAULT_RECIPE_PHOTO_SIZE).toBe('small');
    for (const value of [null, undefined, '', 'huge', 'Large', 2, true, {}, ['large']]) {
      expect(readRecipePhotoSize(value)).toBe('small');
    }
  });

  test('its own device setting, apart from the sort', () => {
    expect(RECIPE_PHOTO_SIZE_KEY).toBe('recipes.photoSize');
    expect(RECIPE_PHOTO_SIZE_KEY).not.toBe(RECIPE_SORT_KEY);
  });
});

describe('labels', () => {
  afterEach(() => initI18n('en'));

  test('in English', () => {
    expect(RECIPE_PHOTO_SIZES.map(recipePhotoSizeLabel)).toEqual(['Small photos', 'Large photos']);
  });

  test('in Spanish', () => {
    initI18n('es');
    expect(RECIPE_PHOTO_SIZES.map(recipePhotoSizeLabel)).toEqual(['Fotos pequeñas', 'Fotos grandes']);
  });
});

describe('the grid', () => {
  test('two columns up to the largest accessibility sizes, then one', () => {
    expect(recipeGridColumns(0.82)).toBe(2);
    expect(recipeGridColumns(1)).toBe(2);
    // xxxLarge, AX1 and AX2 still fit two.
    expect(recipeGridColumns(1.35)).toBe(2);
    expect(recipeGridColumns(1.64)).toBe(2);
    expect(recipeGridColumns(1.95)).toBe(2);
    // AX3 and up: one.
    expect(recipeGridColumns(ONE_COLUMN_FONT_SCALE)).toBe(1);
    expect(recipeGridColumns(2.35)).toBe(1);
    expect(recipeGridColumns(3.12)).toBe(1);
  });

  test('rows of two, the last short when the count is odd', () => {
    expect(gridRows(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(gridRows(['a', 'b', 'c', 'd'], 2)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(gridRows(['a'], 2)).toEqual([['a']]);
  });

  test('one per row with one column', () => {
    expect(gridRows(['a', 'b', 'c'], 1)).toEqual([['a'], ['b'], ['c']]);
  });

  test('nothing gives no rows', () => {
    expect(gridRows([], 2)).toEqual([]);
  });

  test('a column count below one, or fractional, still makes whole rows', () => {
    expect(gridRows(['a', 'b'], 0)).toEqual([['a'], ['b']]);
    expect(gridRows(['a', 'b', 'c'], 2.7)).toEqual([['a', 'b'], ['c']]);
  });

  test('keeps the items themselves, in order', () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const rows = gridRows(items, 2);
    expect(rows.flat()).toEqual(items);
    expect(rows[0][0]).toBe(items[0]);
  });
});
