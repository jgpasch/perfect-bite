import { describe, expect, test } from '@jest/globals';

import { emptyRecipeTags, type RecipeTags } from '@/shared/recipe-tags';

import {
  activeFilterCount,
  availableFilterFacets,
  filterRecipes,
  filtersPillAccessibilityLabel,
  filtersPillLabel,
  isFilterPicked,
  isUntaggedRecipe,
  matchesRecipeFilters,
  noRecipeFilters,
  recipeFilterChips,
  removeFilterChip,
  showRecipesLabel,
  toggleRecipeFilter,
  untaggedFootnote,
  untaggedOnlyFilters,
  type RecipeFilters,
} from '../recipe-filters';

const tags = (over: Partial<RecipeTags>): RecipeTags => ({ ...emptyRecipeTags(), ...over });
const recipe = (name: string, t: Partial<RecipeTags> | null, totalMinutes: number | null = null) => ({
  name,
  tags: t ? tags(t) : null,
  totalMinutes,
});
const pick = (...picks: [Parameters<typeof toggleRecipeFilter>[1], string][]): RecipeFilters =>
  picks.reduce((f, [facet, slug]) => toggleRecipeFilter(f, facet, slug), noRecipeFilters());
const names = (rs: { name: string }[]) => rs.map((r) => r.name);

const tacos = recipe('Tacos', { meal: ['dinner'], cuisine: ['mexican'], protein: ['chicken'] }, 25);
const pancakes = recipe('Pancakes', { meal: ['breakfast'], diet: ['vegetarian'] }, 30);
const curry = recipe('Curry', { meal: ['dinner', 'lunch'], cuisine: ['indian'], protein: ['chicken', 'beans-lentils'] }, 90);
const salad = recipe('Salad', { meal: ['lunch'], diet: ['vegan'], method: ['no-cook'] }, null);
const plain = recipe('Plain', null);
const empty = recipe('Empty import', {});
const ALL = [tacos, pancakes, curry, salad, plain, empty];

describe('matching', () => {
  test('no filters keeps every recipe, in order', () => {
    expect(names(filterRecipes(ALL, noRecipeFilters()))).toEqual(['Tacos', 'Pancakes', 'Curry', 'Salad', 'Plain', 'Empty import']);
  });

  test('OR within a facet', () => {
    expect(names(filterRecipes(ALL, pick(['meal', 'dinner'])))).toEqual(['Tacos', 'Curry']);
    expect(names(filterRecipes(ALL, pick(['meal', 'dinner'], ['meal', 'breakfast'])))).toEqual(['Tacos', 'Pancakes', 'Curry']);
  });

  test('AND across facets', () => {
    expect(names(filterRecipes(ALL, pick(['meal', 'dinner'], ['cuisine', 'indian'])))).toEqual(['Curry']);
    expect(names(filterRecipes(ALL, pick(['meal', 'lunch'], ['diet', 'vegan'])))).toEqual(['Salad']);
    expect(names(filterRecipes(ALL, pick(['meal', 'breakfast'], ['protein', 'chicken'])))).toEqual([]);
  });

  test('time buckets: under 30, 30 to 60, over 60; no time matches none', () => {
    expect(names(filterRecipes(ALL, pick(['time', 'under-30'])))).toEqual(['Tacos']);
    expect(names(filterRecipes(ALL, pick(['time', 'under-60'])))).toEqual(['Pancakes']);
    expect(names(filterRecipes(ALL, pick(['time', 'over-60'])))).toEqual(['Curry']);
    expect(names(filterRecipes(ALL, pick(['time', 'under-30'], ['time', 'over-60'])))).toEqual(['Tacos', 'Curry']);
    expect(names(filterRecipes(ALL, pick(['time', 'under-60'], ['meal', 'dinner'])))).toEqual([]);
  });

  test('an unknown stored slug never matches, and the recipe still matches on known ones', () => {
    const future = recipe('Future', { meal: ['brunch', 'dinner'] });
    expect(matchesRecipeFilters(future, pick(['meal', 'dinner']))).toBe(true);
    expect(matchesRecipeFilters(future, pick(['meal', 'lunch']))).toBe(false);
  });

  test('a stored value missing a facet (older row) is treated as empty', () => {
    const partial = { name: 'Partial', tags: { meal: ['dinner'] } as unknown as RecipeTags, totalMinutes: null };
    expect(matchesRecipeFilters(partial, pick(['cuisine', 'thai']))).toBe(false);
    expect(matchesRecipeFilters(partial, pick(['meal', 'dinner']))).toBe(true);
  });
});

describe('untagged', () => {
  test('null tags, empty facets or only unknown slugs, with no time, is untagged', () => {
    expect(isUntaggedRecipe(plain)).toBe(true);
    expect(isUntaggedRecipe(empty)).toBe(true);
    expect(isUntaggedRecipe(recipe('Unknown', { meal: ['brunch'] }))).toBe(true);
  });

  test('a tag or a time makes it tagged', () => {
    expect(isUntaggedRecipe(salad)).toBe(false);
    expect(isUntaggedRecipe(recipe('Timed', null, 45))).toBe(false);
  });

  test('the Untagged filter shows only untagged recipes', () => {
    expect(names(filterRecipes(ALL, untaggedOnlyFilters()))).toEqual(['Plain', 'Empty import']);
  });

  test('picking a value leaves Untagged', () => {
    const f = toggleRecipeFilter(untaggedOnlyFilters(), 'meal', 'dinner');
    expect(f.untagged).toBe(false);
    expect(f.tags.meal).toEqual(['dinner']);
    expect(toggleRecipeFilter(untaggedOnlyFilters(), 'time', 'over-60')).toEqual({ ...noRecipeFilters(), time: ['over-60'] });
  });

  test('the footer text', () => {
    expect(untaggedFootnote(1)).toBe("1 recipe without tags isn't shown");
    expect(untaggedFootnote(3)).toBe("3 recipes without tags aren't shown");
  });
});

describe('saved: Favorite and Want to try', () => {
  const loved = recipe('Loved', { saved: ['favorite'], meal: ['dinner'] });
  const someday = recipe('Someday', { saved: ['want-to-try'] });
  const both = recipe('Both', { saved: ['want-to-try', 'favorite'], meal: ['lunch'] });
  const SAVED = [tacos, loved, someday, both, plain];

  test('filtering by Favorite, by Want to try, and both (OR)', () => {
    expect(names(filterRecipes(SAVED, pick(['saved', 'favorite'])))).toEqual(['Loved', 'Both']);
    expect(names(filterRecipes(SAVED, pick(['saved', 'want-to-try'])))).toEqual(['Someday', 'Both']);
    expect(names(filterRecipes(SAVED, pick(['saved', 'favorite'], ['saved', 'want-to-try'])))).toEqual(['Loved', 'Someday', 'Both']);
  });

  test('AND with the other facets', () => {
    expect(names(filterRecipes(SAVED, pick(['saved', 'favorite'], ['meal', 'dinner'])))).toEqual(['Loved']);
    expect(names(filterRecipes(SAVED, pick(['saved', 'want-to-try'], ['meal', 'dinner'])))).toEqual([]);
  });

  test('older stored tags without saved never match a saved filter', () => {
    const older = { name: 'Older', tags: { meal: ['dinner'] } as unknown as RecipeTags, totalMinutes: null };
    expect(matchesRecipeFilters(older, pick(['saved', 'favorite']))).toBe(false);
  });

  test('only saved tags isn’t untagged', () => {
    expect(isUntaggedRecipe(someday)).toBe(false);
    expect(names(filterRecipes(SAVED, untaggedOnlyFilters()))).toEqual(['Plain']);
    expect(isUntaggedRecipe(recipe('Unknown saved', { saved: ['loved'] }))).toBe(true);
  });

  test('the group comes first, shown only when some recipe has a value', () => {
    expect(availableFilterFacets(SAVED, noRecipeFilters())[0]).toEqual({
      key: 'saved',
      label: 'Saved',
      values: [
        { slug: 'favorite', label: 'Favorite' },
        { slug: 'want-to-try', label: 'Want to try' },
      ],
    });
    expect(availableFilterFacets([tacos, someday], noRecipeFilters())[0]).toEqual({
      key: 'saved',
      label: 'Saved',
      values: [{ slug: 'want-to-try', label: 'Want to try' }],
    });
    expect(availableFilterFacets([tacos, plain], noRecipeFilters()).map((f) => f.key)).not.toContain('saved');
  });

  test('active chips, before the other facets', () => {
    const f = pick(['meal', 'dinner'], ['saved', 'want-to-try'], ['saved', 'favorite']);
    const chips = recipeFilterChips(f);
    expect(chips.map((c) => c.label)).toEqual(['Favorite', 'Want to try', 'Dinner']);
    expect(chips[0]).toMatchObject({ key: 'saved:favorite', facet: 'saved', slug: 'favorite', accessibilityLabel: 'Remove Favorite filter' });
    expect(removeFilterChip(f, chips[0]).tags.saved).toEqual(['want-to-try']);
    expect(activeFilterCount(f)).toBe(3);
  });
});

describe('availableFilterFacets', () => {
  test('only values some recipe has, in display order, then Time', () => {
    expect(availableFilterFacets(ALL, noRecipeFilters())).toEqual([
      { key: 'meal', label: 'Meal', values: [{ slug: 'breakfast', label: 'Breakfast' }, { slug: 'lunch', label: 'Lunch' }, { slug: 'dinner', label: 'Dinner' }] },
      { key: 'cuisine', label: 'Cuisine', values: [{ slug: 'mexican', label: 'Mexican' }, { slug: 'indian', label: 'Indian' }] },
      { key: 'protein', label: 'Protein', values: [{ slug: 'chicken', label: 'Chicken' }, { slug: 'beans-lentils', label: 'Beans & lentils' }] },
      { key: 'diet', label: 'Diet', values: [{ slug: 'vegetarian', label: 'Vegetarian' }, { slug: 'vegan', label: 'Vegan' }] },
      { key: 'method', label: 'Method', values: [{ slug: 'no-cook', label: 'No cook' }] },
      {
        key: 'time',
        label: 'Time',
        values: [{ slug: 'under-30', label: 'Under 30 min' }, { slug: 'under-60', label: 'Under 1 hour' }, { slug: 'over-60', label: 'Over 1 hour' }],
      },
    ]);
  });

  test('a facet with no values left is hidden; unknown slugs are not offered', () => {
    const facets = availableFilterFacets([tacos, recipe('Unknown', { method: ['smoker'] })], noRecipeFilters());
    expect(facets.map((f) => f.key)).toEqual(['meal', 'cuisine', 'protein', 'time']);
    expect(facets.find((f) => f.key === 'time')!.values).toEqual([{ slug: 'under-30', label: 'Under 30 min' }]);
  });

  test('no tagged recipes: no facets', () => {
    expect(availableFilterFacets([plain, empty], noRecipeFilters())).toEqual([]);
    expect(availableFilterFacets([], noRecipeFilters())).toEqual([]);
  });

  test('a picked value stays offered after its last recipe goes, so it can be turned off', () => {
    const facets = availableFilterFacets([pancakes], pick(['cuisine', 'thai']));
    expect(facets.find((f) => f.key === 'cuisine')).toEqual({ key: 'cuisine', label: 'Cuisine', values: [{ slug: 'thai', label: 'Thai' }] });
  });
});

describe('toggling and counting', () => {
  test('toggles a value on and off, without changing the input', () => {
    const start = noRecipeFilters();
    const on = toggleRecipeFilter(start, 'protein', 'chicken');
    expect(on.tags.protein).toEqual(['chicken']);
    expect(start.tags.protein).toEqual([]);
    expect(isFilterPicked(on, 'protein', 'chicken')).toBe(true);
    expect(toggleRecipeFilter(on, 'protein', 'chicken')).toEqual(noRecipeFilters());
  });

  test('no maximum when filtering', () => {
    const f = pick(['meal', 'breakfast'], ['meal', 'lunch'], ['meal', 'dinner'], ['meal', 'snack']);
    expect(f.tags.meal).toEqual(['breakfast', 'lunch', 'dinner', 'snack']);
  });

  test('activeFilterCount counts every value and Untagged', () => {
    expect(activeFilterCount(noRecipeFilters())).toBe(0);
    expect(activeFilterCount(pick(['meal', 'dinner'], ['meal', 'lunch'], ['time', 'over-60']))).toBe(3);
    expect(activeFilterCount(untaggedOnlyFilters())).toBe(1);
  });

  test('the Filters pill, its VoiceOver label, and the CTA', () => {
    expect(filtersPillLabel(0)).toBe('Filters');
    expect(filtersPillLabel(2)).toBe('Filters · 2');
    expect(filtersPillAccessibilityLabel(0)).toBe('Filters');
    expect(filtersPillAccessibilityLabel(2)).toBe('Filters, 2 active');
    expect(showRecipesLabel(0)).toBe('Show 0 recipes');
    expect(showRecipesLabel(1)).toBe('Show 1 recipe');
    expect(showRecipesLabel(12)).toBe('Show 12 recipes');
  });
});

describe('chips', () => {
  test('one per value in the sheet order, whatever order they were picked in', () => {
    const f = pick(['time', 'under-30'], ['protein', 'chicken'], ['meal', 'dinner'], ['meal', 'breakfast']);
    expect(recipeFilterChips(f)).toEqual([
      { key: 'meal:breakfast', facet: 'meal', slug: 'breakfast', label: 'Breakfast', accessibilityLabel: 'Remove Breakfast filter' },
      { key: 'meal:dinner', facet: 'meal', slug: 'dinner', label: 'Dinner', accessibilityLabel: 'Remove Dinner filter' },
      { key: 'protein:chicken', facet: 'protein', slug: 'chicken', label: 'Chicken', accessibilityLabel: 'Remove Chicken filter' },
      { key: 'time:under-30', facet: 'time', slug: 'under-30', label: 'Under 30 min', accessibilityLabel: 'Remove Under 30 min filter' },
    ]);
    expect(recipeFilterChips(noRecipeFilters())).toEqual([]);
  });

  test('removing a chip takes out only its value', () => {
    const f = pick(['meal', 'dinner'], ['meal', 'lunch'], ['time', 'over-60']);
    const [lunch, , overHour] = recipeFilterChips(f);
    expect(lunch.label).toBe('Lunch');
    expect(removeFilterChip(f, lunch)).toEqual({ ...noRecipeFilters(), tags: { ...emptyRecipeTags(), meal: ['dinner'] }, time: ['over-60'] });
    expect(removeFilterChip(f, overHour)).toEqual({ ...noRecipeFilters(), tags: { ...emptyRecipeTags(), meal: ['dinner', 'lunch'] } });
  });

  test('removing a chip that is no longer picked changes nothing', () => {
    const f = pick(['meal', 'dinner']);
    const [dinner] = recipeFilterChips(f);
    const without = removeFilterChip(f, dinner);
    expect(removeFilterChip(without, dinner)).toBe(without);
  });

  test('Untagged is one chip, and removing it clears it', () => {
    const [chip] = recipeFilterChips(untaggedOnlyFilters());
    expect(recipeFilterChips(untaggedOnlyFilters())).toEqual([
      { key: 'untagged:untagged', facet: 'untagged', slug: 'untagged', label: 'Untagged', accessibilityLabel: 'Remove Untagged filter' },
    ]);
    expect(removeFilterChip(untaggedOnlyFilters(), chip)).toEqual(noRecipeFilters());
  });
});
