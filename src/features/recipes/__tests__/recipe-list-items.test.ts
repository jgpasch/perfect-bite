// The Recipes tab's virtualized list items (spec 4.5): a row (or row of tiles) per item ungrouped, a folding
// card per item grouped, each household's first item carrying its gap and name.
import { describe, expect, test } from '@jest/globals';

import { recipeListItems, type RecipeListItem } from '../recipe-list-items';
import type { RecipeSection } from '../recipe-sort';

type R = { id: string };
const r = (id: string): R => ({ id });
const section = (key: string, ids: string[]): RecipeSection<R> => ({ key, title: key, hue: 'green' as never, recipes: ids.map(r) });

const home = { householdId: 'home', name: 'Home', recipes: ['a', 'b', 'c'].map(r), sections: [section('dinner', ['a', 'c']), section('dessert', ['b'])] };
const cabin = { householdId: 'cabin', name: 'Cabin', recipes: [r('d')], sections: [section('none', ['d'])] };

/** Each item as a short line: kind, its recipes or section, first/last, and the household it starts. */
const summary = (items: RecipeListItem<R>[]) =>
  items.map((item) => {
    const start = item.household ? ` <${item.household.name}${item.household.first ? ' first' : ''}${item.household.label ? ' labelled' : ''}>` : '';
    if (item.kind === 'row') return `row ${item.recipe.id}${item.first ? ' first' : ''}${item.last ? ' last' : ''}${start}`;
    if (item.kind === 'tiles') return `tiles ${item.recipes.map((x) => x.id).join('')}${item.first ? ' first' : ''}${start}`;
    return `section ${item.householdId}:${item.section.key}${start}`;
  });

describe('recipeListItems', () => {
  test('ungrouped small photos: a row per recipe, the household starting on its first', () => {
    const items = recipeListItems({ groups: [home], grouped: false, large: false, columns: 2, labelHouseholds: false });
    expect(summary(items)).toEqual(['row a first <Home first>', 'row b', 'row c last']);
    expect(items.map((i) => i.key)).toEqual(['row:home:a', 'row:home:b', 'row:home:c']);
  });

  test('two households: each card starts and ends once, and both are labelled', () => {
    const items = recipeListItems({ groups: [home, cabin], grouped: false, large: false, columns: 2, labelHouseholds: true });
    expect(summary(items)).toEqual([
      'row a first <Home first labelled>',
      'row b',
      'row c last',
      'row d first last <Cabin labelled>',
    ]);
  });

  test('ungrouped large photos: rows of tiles by the column count, a short last row', () => {
    const items = recipeListItems({ groups: [home], grouped: false, large: true, columns: 2, labelHouseholds: false });
    expect(summary(items)).toEqual(['tiles ab first <Home first>', 'tiles c']);
    expect(items.map((i) => i.key)).toEqual(['tiles:home:a', 'tiles:home:c']);
  });

  test('one column at the largest text sizes: a row of tiles per recipe', () => {
    const items = recipeListItems({ groups: [home], grouped: false, large: true, columns: 1, labelHouseholds: false });
    expect(summary(items)).toEqual(['tiles a first <Home first>', 'tiles b', 'tiles c']);
  });

  test('grouped: a folding card per section whatever the photo size, keyed by household and section', () => {
    for (const large of [false, true]) {
      const items = recipeListItems({ groups: [home, cabin], grouped: true, large, columns: 2, labelHouseholds: true });
      expect(summary(items)).toEqual([
        'section home:dinner <Home first labelled>',
        'section home:dessert',
        'section cabin:none <Cabin labelled>',
      ]);
      expect(items.map((i) => i.key)).toEqual(['section:home:dinner', 'section:home:dessert', 'section:cabin:none']);
    }
  });

  test('a recipe in two sections of one household keeps unique keys', () => {
    const both = { ...home, sections: [section('dinner', ['a']), section('lunch', ['a'])] };
    const items = recipeListItems({ groups: [both], grouped: true, large: false, columns: 2, labelHouseholds: false });
    expect(new Set(items.map((i) => i.key)).size).toBe(2);
  });

  test('the same recipe id in two households keeps unique keys', () => {
    const items = recipeListItems({
      groups: [home, { ...cabin, recipes: [r('a')] }],
      grouped: false,
      large: false,
      columns: 2,
      labelHouseholds: true,
    });
    expect(items.map((i) => i.key)).toEqual(['row:home:a', 'row:home:b', 'row:home:c', 'row:cabin:a']);
  });

  test('nothing shown: no items', () => {
    expect(recipeListItems({ groups: [], grouped: false, large: false, columns: 2, labelHouseholds: false })).toEqual([]);
    expect(recipeListItems({ groups: [], grouped: true, large: true, columns: 2, labelHouseholds: true })).toEqual([]);
  });
});
