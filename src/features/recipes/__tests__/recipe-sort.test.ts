// The Recipes tab's sort and group (spec 4.5): Recently added, A–Z and By meal.
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import { initI18n } from '@/i18n';
import { emptyRecipeTags, type RecipeTags } from '@/shared/recipe-tags';

import {
  getFoldedMealSections,
  resetFoldedMealSections,
  toggleMealSection,
} from '../recipe-fold-store';
import {
  compareRecipeNames,
  DEFAULT_RECIPE_SORT,
  groupRecipesByMeal,
  MEAL_HUES,
  MEAL_SECTIONS,
  mealSectionKey,
  mealSectionTitle,
  mealSectionUnit,
  readRecipeSort,
  RECIPE_SORTS,
  recipeSortButtonLabel,
  recipeSortLabel,
  recipeSortPillLabel,
  sortRecipes,
  sortRecipesByName,
} from '../recipe-sort';

const recipe = (id: string, name: string, meal: string[] = []) => ({
  id,
  name,
  tags: (meal.length > 0 ? { ...emptyRecipeTags(), meal } : null) as RecipeTags | null,
});
const names = (rs: readonly { name: string }[]) => rs.map((r) => r.name);

describe('readRecipeSort', () => {
  test('reads each stored choice', () => {
    expect(RECIPE_SORTS).toEqual(['recent', 'name', 'meal']);
    for (const sort of RECIPE_SORTS) expect(readRecipeSort(sort)).toBe(sort);
  });

  test('anything else is Recently added', () => {
    expect(DEFAULT_RECIPE_SORT).toBe('recent');
    for (const value of [null, undefined, '', 'cuisine', 'Meal', 3, { sort: 'meal' }]) expect(readRecipeSort(value)).toBe('recent');
  });
});

describe('labels', () => {
  afterEach(() => initI18n('en'));

  test('the menu, the pill and VoiceOver', () => {
    expect(RECIPE_SORTS.map(recipeSortLabel)).toEqual(['Recently added', 'A–Z', 'By meal']);
    expect(RECIPE_SORTS.map(recipeSortPillLabel)).toEqual(['Recent', 'A–Z', 'By meal']);
    expect(recipeSortButtonLabel('recent')).toBe('Sort: Recently added');
    expect(recipeSortButtonLabel('meal')).toBe('Sort: By meal');
    expect(mealSectionUnit()).toEqual(['recipe', 'recipes']);
  });

  test('section titles: meal labels, then No meal', () => {
    expect(MEAL_SECTIONS.map(mealSectionTitle)).toEqual(['Breakfast', 'Lunch', 'Dinner', 'Side', 'Dessert', 'Snack', 'Drink', 'No meal']);
  });

  test('in Spanish', () => {
    initI18n('es');
    expect(RECIPE_SORTS.map(recipeSortPillLabel)).toEqual(['Recientes', 'A–Z', 'Por comida']);
    expect(recipeSortButtonLabel('recent')).toBe('Ordenar: Agregadas recientemente');
    expect(mealSectionTitle('none')).toBe('Sin comida');
    expect(mealSectionUnit()).toEqual(['receta', 'recetas']);
  });
});

describe('sorting', () => {
  afterEach(() => initI18n('en'));

  test('A–Z ignores case and accents and orders numbers by value', () => {
    const rs = [recipe('1', 'zucchini bread'), recipe('2', 'Éclairs'), recipe('3', 'apple pie'), recipe('4', 'Soup 10'), recipe('5', 'Soup 9')];
    expect(names(sortRecipesByName(rs))).toEqual(['apple pie', 'Éclairs', 'Soup 9', 'Soup 10', 'zucchini bread']);
  });

  test('same names keep a stable order by id', () => {
    const rs = [recipe('b', 'Tacos'), recipe('a', 'tacos'), recipe('c', 'Tacos')];
    expect(sortRecipesByName(rs).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  test('follows the language: ñ after n in Spanish', () => {
    initI18n('es');
    expect(compareRecipeNames('ñoquis', 'nachos')).toBeGreaterThan(0);
    expect(compareRecipeNames('ñoquis', 'omelet')).toBeLessThan(0);
    expect(names(sortRecipesByName([recipe('1', 'Ñoquis'), recipe('2', 'Omelet'), recipe('3', 'Nachos')]))).toEqual([
      'Nachos',
      'Ñoquis',
      'Omelet',
    ]);
  });

  test('Recently added keeps the given order; A–Z and By meal sort by name; neither changes the input', () => {
    const rs = [recipe('1', 'Tacos'), recipe('2', 'Apple pie'), recipe('3', 'Miso soup')];
    expect(names(sortRecipes(rs, 'recent'))).toEqual(['Tacos', 'Apple pie', 'Miso soup']);
    expect(names(sortRecipes(rs, 'name'))).toEqual(['Apple pie', 'Miso soup', 'Tacos']);
    expect(names(sortRecipes(rs, 'meal'))).toEqual(['Apple pie', 'Miso soup', 'Tacos']);
    expect(names(rs)).toEqual(['Tacos', 'Apple pie', 'Miso soup']);
    expect(sortRecipes([], 'name')).toEqual([]);
  });
});

describe('groupRecipesByMeal', () => {
  test('a section per meal in facet order, then No meal; empty ones hidden; A–Z inside', () => {
    const sections = groupRecipesByMeal([
      recipe('1', 'Tacos', ['dinner']),
      recipe('2', 'Toast', []),
      recipe('3', 'Pancakes', ['breakfast']),
      recipe('4', 'Curry', ['dinner']),
      recipe('5', 'Lemonade', ['drink']),
      recipe('6', 'Applesauce', []),
    ]);
    expect(sections.map((s) => [s.meal, s.title, s.hue, names(s.recipes)])).toEqual([
      ['breakfast', 'Breakfast', 'amber', ['Pancakes']],
      ['dinner', 'Dinner', 'rose', ['Curry', 'Tacos']],
      ['drink', 'Drink', 'blue', ['Lemonade']],
      ['none', 'No meal', 'grey', ['Applesauce', 'Toast']],
    ]);
  });

  test('a recipe with two meals is in both', () => {
    const sections = groupRecipesByMeal([recipe('1', 'Frittata', ['lunch', 'breakfast']), recipe('2', 'Salad', ['lunch'])]);
    expect(sections.map((s) => [s.meal, names(s.recipes)])).toEqual([
      ['breakfast', ['Frittata']],
      ['lunch', ['Frittata', 'Salad']],
    ]);
  });

  test('tags with no meal, or only unknown meals, are No meal', () => {
    const sections = groupRecipesByMeal([
      { id: '1', name: 'Mystery', tags: { ...emptyRecipeTags(), meal: ['brunch'] } as RecipeTags },
      { id: '2', name: 'Chili', tags: { ...emptyRecipeTags(), cuisine: ['mexican'] } },
      recipe('3', 'Plain', []),
    ]);
    expect(sections.map((s) => [s.meal, names(s.recipes)])).toEqual([['none', ['Chili', 'Mystery', 'Plain']]]);
  });

  test('nothing gives no sections', () => {
    expect(groupRecipesByMeal([])).toEqual([]);
  });

  test('keeps extra fields, e.g. a search match', () => {
    const [section] = groupRecipesByMeal([{ ...recipe('1', 'Tacos', ['dinner']), ingredientMatch: 'tortillas' }]);
    expect(section.recipes[0].ingredientMatch).toBe('tortillas');
  });

  test('every section has its own hue, No meal grey', () => {
    expect(MEAL_SECTIONS).toEqual(['breakfast', 'lunch', 'dinner', 'side', 'dessert', 'snack', 'drink', 'none']);
    const hues = MEAL_SECTIONS.map((m) => MEAL_HUES[m]);
    expect(new Set(hues).size).toBe(MEAL_SECTIONS.length);
    expect(MEAL_HUES.none).toBe('grey');
  });

  test('section keys are per household', () => {
    expect(mealSectionKey('home', 'dinner')).toBe('home:dinner');
    expect(mealSectionKey('lake', 'dinner')).not.toBe(mealSectionKey('home', 'dinner'));
    expect(mealSectionKey('home', 'none')).toBe('home:none');
  });
});

describe('folded sections', () => {
  beforeEach(() => resetFoldedMealSections());

  test('a toggle folds, a second opens; others are untouched', () => {
    toggleMealSection('home:dinner');
    toggleMealSection('home:lunch');
    expect([...getFoldedMealSections()].sort()).toEqual(['home:dinner', 'home:lunch']);
    toggleMealSection('home:dinner');
    expect([...getFoldedMealSections()]).toEqual(['home:lunch']);
  });

  test('each change is a new set, so a screen re-renders', () => {
    const before = getFoldedMealSections();
    toggleMealSection('home:dinner');
    expect(getFoldedMealSections()).not.toBe(before);
    expect(before.size).toBe(0);
  });

  test('reset opens everything', () => {
    toggleMealSection('home:dinner');
    resetFoldedMealSections();
    expect(getFoldedMealSections().size).toBe(0);
  });
});
