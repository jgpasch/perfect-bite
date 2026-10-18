// The Recipes tab's sort and group (spec 4.5): Recently added or A–Z, grouped by none or a facet.
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
  DEFAULT_RECIPE_GROUP,
  DEFAULT_RECIPE_SORT,
  groupRecipes,
  readRecipeGroup,
  readRecipeSort,
  readRecipeSortChoice,
  RECIPE_GROUP_SECTIONS,
  RECIPE_GROUPS,
  RECIPE_SORTS,
  recipeGroupSectionTitle,
  recipeSectionKey,
  recipeSectionUnit,
  recipeSortButtonLabel,
  recipeSortLabel,
  recipeSortPillLabel,
  sortRecipes,
  sortRecipesByName,
  type RecipeGroup,
} from '../recipe-sort';
import { recipeMetaLine, recipeMetaParts, recipeRowLabel } from '../recipe-view';

type TestRecipe = { id: string; name: string; tags: RecipeTags | null; totalMinutes: number | null };

const recipe = (id: string, name: string, meal: string[] = []): TestRecipe => ({
  id,
  name,
  tags: (meal.length > 0 ? { ...emptyRecipeTags(), meal } : null) as RecipeTags | null,
  totalMinutes: null,
});
/** A recipe with these tags (facets left out are empty) and time. */
const tagged = (id: string, name: string, tags: Partial<RecipeTags> = {}, totalMinutes: number | null = null): TestRecipe => ({
  id,
  name,
  tags: { ...emptyRecipeTags(), ...tags },
  totalMinutes,
});
const names = (rs: readonly { name: string }[]) => rs.map((r) => r.name);
/** Each section as [key, title, hue, names]. */
const layout = (rs: readonly TestRecipe[], group: RecipeGroup, sort: 'recent' | 'name' = 'name') =>
  groupRecipes(rs, group, sort).map((s) => [s.key, s.title, s.hue, names(s.recipes)]);

describe('reading the stored choices', () => {
  test('each stored sort and group', () => {
    expect(RECIPE_SORTS).toEqual(['recent', 'name']);
    for (const sort of RECIPE_SORTS) expect(readRecipeSort(sort)).toBe(sort);
    expect(RECIPE_GROUPS).toEqual(['none', 'meal', 'cuisine', 'protein', 'method', 'time', 'saved']);
    for (const group of RECIPE_GROUPS) expect(readRecipeGroup(group)).toBe(group);
  });

  test('anything else is Recently added and no grouping', () => {
    expect(DEFAULT_RECIPE_SORT).toBe('recent');
    expect(DEFAULT_RECIPE_GROUP).toBe('none');
    for (const value of [null, undefined, '', 'cuisine', 'Meal', 3, { sort: 'meal' }]) expect(readRecipeSort(value)).toBe('recent');
    for (const value of [null, undefined, '', 'diet', 'Meal', 'region', 2, ['meal']]) expect(readRecipeGroup(value)).toBe('none');
  });

  test('an old By meal sort reads as A–Z grouped by meal, to be written back', () => {
    expect(readRecipeSortChoice('meal', null)).toEqual({ sort: 'name', group: 'meal', legacy: true });
    // Whatever the group setting says: an old app never wrote one.
    expect(readRecipeSortChoice('meal', 'cuisine')).toEqual({ sort: 'name', group: 'meal', legacy: true });
  });

  test('new values read as they are, with nothing to write back', () => {
    expect(readRecipeSortChoice('recent', 'cuisine')).toEqual({ sort: 'recent', group: 'cuisine', legacy: false });
    expect(readRecipeSortChoice('name', null)).toEqual({ sort: 'name', group: 'none', legacy: false });
    expect(readRecipeSortChoice(null, null)).toEqual({ sort: 'recent', group: 'none', legacy: false });
    expect(readRecipeSortChoice('cuisine', 'diet')).toEqual({ sort: 'recent', group: 'none', legacy: false });
  });
});

describe('labels', () => {
  afterEach(() => initI18n('en'));

  test('the sorts in the menu', () => {
    expect(RECIPE_SORTS.map(recipeSortLabel)).toEqual(['Recently added', 'A–Z']);
    expect(recipeSectionUnit()).toEqual(['recipe', 'recipes']);
  });

  test('the pill reads the grouping when there is one, else the sort', () => {
    expect(recipeSortPillLabel('recent', 'none')).toBe('Recent');
    expect(recipeSortPillLabel('name', 'none')).toBe('A–Z');
    expect(RECIPE_GROUPS.filter((g) => g !== 'none').map((g) => recipeSortPillLabel('recent', g))).toEqual([
      'By meal',
      'By cuisine',
      'By protein',
      'By method',
      'By time',
      'Saved',
    ]);
    expect(recipeSortPillLabel('name', 'cuisine')).toBe('By cuisine');
  });

  test('VoiceOver reads the sort, then the grouping', () => {
    expect(recipeSortButtonLabel('recent', 'none')).toBe('Sort: Recently added');
    expect(recipeSortButtonLabel('name', 'none')).toBe('Sort: A–Z');
    expect(recipeSortButtonLabel('name', 'cuisine')).toBe('Sort: A–Z, grouped by cuisine');
    expect(recipeSortButtonLabel('recent', 'meal')).toBe('Sort: Recently added, grouped by meal');
    expect(recipeSortButtonLabel('name', 'saved')).toBe('Sort: A–Z, grouped by saved');
  });

  test('every section title, "No …" last', () => {
    const titles = (group: Exclude<RecipeGroup, 'none'>) =>
      RECIPE_GROUP_SECTIONS[group].map((s) => recipeGroupSectionTitle(group, s.key));
    expect(titles('meal')).toEqual(['Breakfast', 'Lunch', 'Dinner', 'Side', 'Dessert', 'Snack', 'Drink', 'No meal']);
    expect(titles('cuisine')).toEqual(['American', 'Latin', 'European', 'Middle Eastern', 'Asian', 'African', 'No cuisine']);
    expect(titles('protein')).toEqual([
      'Chicken',
      'Turkey',
      'Beef',
      'Pork',
      'Lamb',
      'Fish',
      'Shellfish',
      'Eggs',
      'Tofu & tempeh',
      'Beans & lentils',
      'No protein',
    ]);
    expect(titles('method')).toEqual(['Instant Pot', 'Slow cooker', 'Sheet pan', 'One pot', 'Grill', 'Air fryer', 'No cook', 'No method']);
    expect(titles('time')).toEqual(['Under 30 min', 'Under 1 hour', 'Over 1 hour', 'No time']);
    expect(titles('saved')).toEqual(['Favorite', 'Want to try', 'Not saved']);
  });

  test('in Spanish', () => {
    initI18n('es');
    expect(recipeSortPillLabel('recent', 'none')).toBe('Recientes');
    expect(recipeSortPillLabel('name', 'meal')).toBe('Por comida');
    expect(recipeSortPillLabel('name', 'cuisine')).toBe('Por cocina');
    expect(recipeSortButtonLabel('recent', 'none')).toBe('Ordenar: Agregadas recientemente');
    expect(recipeSortButtonLabel('name', 'cuisine')).toBe('Ordenar: A–Z, agrupadas por cocina');
    expect(recipeGroupSectionTitle('meal', 'none')).toBe('Sin comida');
    expect(recipeGroupSectionTitle('cuisine', 'asian')).toBe('Asiática');
    expect(recipeGroupSectionTitle('cuisine', 'none')).toBe('Sin cocina');
    expect(recipeGroupSectionTitle('protein', 'none')).toBe('Sin proteína');
    expect(recipeGroupSectionTitle('method', 'none')).toBe('Sin método');
    expect(recipeGroupSectionTitle('time', 'none')).toBe('Sin tiempo');
    expect(recipeGroupSectionTitle('saved', 'none')).toBe('Sin guardar');
    expect(recipeSectionUnit()).toEqual(['receta', 'recetas']);
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

  test('Recently added keeps the given order; A–Z sorts by name; neither changes the input', () => {
    const rs = [recipe('1', 'Tacos'), recipe('2', 'Apple pie'), recipe('3', 'Miso soup')];
    expect(names(sortRecipes(rs, 'recent'))).toEqual(['Tacos', 'Apple pie', 'Miso soup']);
    expect(names(sortRecipes(rs, 'name'))).toEqual(['Apple pie', 'Miso soup', 'Tacos']);
    expect(names(rs)).toEqual(['Tacos', 'Apple pie', 'Miso soup']);
    expect(sortRecipes([], 'name')).toEqual([]);
  });
});

describe('groupRecipes', () => {
  test('no grouping gives no sections', () => {
    expect(groupRecipes([recipe('1', 'Tacos', ['dinner'])], 'none', 'name')).toEqual([]);
  });

  test('nothing gives no sections', () => {
    for (const group of RECIPE_GROUPS) expect(groupRecipes([], group, 'name')).toEqual([]);
  });

  test('meal: a section per meal in facet order, then No meal; empty ones hidden', () => {
    expect(
      layout(
        [
          recipe('1', 'Tacos', ['dinner']),
          recipe('2', 'Toast', []),
          recipe('3', 'Pancakes', ['breakfast']),
          recipe('4', 'Curry', ['dinner']),
          recipe('5', 'Lemonade', ['drink']),
          recipe('6', 'Applesauce', []),
        ],
        'meal',
      ),
    ).toEqual([
      ['breakfast', 'Breakfast', 'amber', ['Pancakes']],
      ['dinner', 'Dinner', 'rose', ['Curry', 'Tacos']],
      ['drink', 'Drink', 'blue', ['Lemonade']],
      ['none', 'No meal', 'grey', ['Applesauce', 'Toast']],
    ]);
  });

  test('meal: a recipe with two meals is in both; tags with no or only unknown meals are No meal', () => {
    expect(layout([recipe('1', 'Frittata', ['lunch', 'breakfast']), recipe('2', 'Salad', ['lunch'])], 'meal')).toEqual([
      ['breakfast', 'Breakfast', 'amber', ['Frittata']],
      ['lunch', 'Lunch', 'teal', ['Frittata', 'Salad']],
    ]);
    expect(
      layout([tagged('1', 'Mystery', { meal: ['brunch'] }), tagged('2', 'Chili', { cuisine: ['mexican'] }), recipe('3', 'Plain')], 'meal'),
    ).toEqual([['none', 'No meal', 'grey', ['Chili', 'Mystery', 'Plain']]]);
  });

  test('cuisine: by region in order, then No cuisine; two cuisines in one region once, in two regions in both', () => {
    expect(
      layout(
        [
          tagged('1', 'Pad thai', { cuisine: ['thai'] }),
          tagged('2', 'Ramen', { cuisine: ['japanese', 'chinese'] }),
          tagged('3', 'Tacos', { cuisine: ['mexican'] }),
          tagged('4', 'Burger', { cuisine: ['american'] }),
          tagged('5', 'Hummus', { cuisine: ['middle-eastern', 'greek'] }),
          tagged('6', 'Jollof', { cuisine: ['african'] }),
          tagged('7', 'Toast', { meal: ['breakfast'] }),
          tagged('8', 'Mystery', { cuisine: ['martian'] }),
          recipe('9', 'Plain'),
        ],
        'cuisine',
      ),
    ).toEqual([
      ['american', 'American', 'blue', ['Burger']],
      ['latin', 'Latin', 'orange', ['Tacos']],
      ['european', 'European', 'green', ['Hummus']],
      ['middle-eastern', 'Middle Eastern', 'amber', ['Hummus']],
      ['asian', 'Asian', 'teal', ['Pad thai', 'Ramen']],
      ['african', 'African', 'plum', ['Jollof']],
      ['none', 'No cuisine', 'grey', ['Mystery', 'Plain', 'Toast']],
    ]);
  });

  test('protein: each value in facet order; a recipe with two proteins in both', () => {
    expect(
      layout(
        [
          tagged('1', 'Surf and turf', { protein: ['shellfish', 'beef'] }),
          tagged('2', 'Roast chicken', { protein: ['chicken'] }),
          tagged('3', 'Dal', { protein: ['beans-lentils'] }),
          tagged('4', 'Salad', {}),
          tagged('5', 'Lamb curry', { protein: ['lamb'] }),
          tagged('6', 'Omelet', { protein: ['eggs'] }),
          tagged('7', 'Stir fry', { protein: ['tofu-tempeh', 'seitan'] }),
        ],
        'protein',
      ),
    ).toEqual([
      ['chicken', 'Chicken', 'amber', ['Roast chicken']],
      ['beef', 'Beef', 'rose', ['Surf and turf']],
      ['lamb', 'Lamb', 'rose', ['Lamb curry']],
      ['shellfish', 'Shellfish', 'teal', ['Surf and turf']],
      ['eggs', 'Eggs', 'amber', ['Omelet']],
      ['tofu-tempeh', 'Tofu & tempeh', 'green', ['Stir fry']],
      ['beans-lentils', 'Beans & lentils', 'orange', ['Dal']],
      ['none', 'No protein', 'grey', ['Salad']],
    ]);
  });

  test('method: each value in facet order, then No method', () => {
    expect(
      layout(
        [
          tagged('1', 'Ribs', { method: ['grill', 'slow-cooker'] }),
          tagged('2', 'Chili', { method: ['pressure-cooker'] }),
          tagged('3', 'Gazpacho', { method: ['no-cook'] }),
          tagged('4', 'Wings', { method: ['air-fryer'] }),
          tagged('5', 'Soup', {}),
        ],
        'method',
      ),
    ).toEqual([
      ['pressure-cooker', 'Instant Pot', 'blue', ['Chili']],
      ['slow-cooker', 'Slow cooker', 'orange', ['Ribs']],
      ['grill', 'Grill', 'rose', ['Ribs']],
      ['air-fryer', 'Air fryer', 'plum', ['Wings']],
      ['no-cook', 'No cook', 'green', ['Gazpacho']],
      ['none', 'No method', 'grey', ['Soup']],
    ]);
  });

  test('time: each recipe in exactly one bucket, with the bucket edges, then No time', () => {
    expect(
      layout(
        [
          tagged('1', 'Toast', {}, 5),
          tagged('2', 'Salad', {}, 29),
          tagged('3', 'Pasta', {}, 30),
          tagged('4', 'Curry', {}, 60),
          tagged('5', 'Roast', {}, 61),
          tagged('6', 'Mystery', {}, null),
          recipe('7', 'Untagged'),
        ],
        'time',
      ),
    ).toEqual([
      ['under-30', 'Under 30 min', 'green', ['Salad', 'Toast']],
      ['under-60', 'Under 1 hour', 'amber', ['Curry', 'Pasta']],
      ['over-60', 'Over 1 hour', 'rose', ['Roast']],
      ['none', 'No time', 'grey', ['Mystery', 'Untagged']],
    ]);
  });

  test('time works for recipes without a totalMinutes field (No time)', () => {
    expect(groupRecipes([{ id: '1', name: 'Tacos', tags: null }], 'time', 'name').map((s) => s.key)).toEqual(['none']);
  });

  test('saved: Favorite, Want to try, then Not saved; both marks in both', () => {
    expect(
      layout(
        [
          tagged('1', 'Tacos', { saved: ['favorite', 'want-to-try'] }),
          tagged('2', 'Pho', { saved: ['want-to-try'] }),
          tagged('3', 'Curry', { saved: ['favorite'] }),
          tagged('4', 'Soup', {}),
          recipe('5', 'Plain'),
        ],
        'saved',
      ),
    ).toEqual([
      ['favorite', 'Favorite', 'rose', ['Curry', 'Tacos']],
      ['want-to-try', 'Want to try', 'blue', ['Pho', 'Tacos']],
      ['none', 'Not saved', 'grey', ['Plain', 'Soup']],
    ]);
  });

  test('sections follow the sort: Recently added keeps the given order, A–Z sorts each', () => {
    const rs = [
      tagged('1', 'Tacos', { cuisine: ['mexican'] }),
      tagged('2', 'Ramen', { cuisine: ['japanese'] }),
      tagged('3', 'Arepas', { cuisine: ['latin-american'] }),
      tagged('4', 'Bibimbap', { cuisine: ['korean'] }),
    ];
    expect(layout(rs, 'cuisine', 'recent').map(([key, , , ns]) => [key, ns])).toEqual([
      ['latin', ['Tacos', 'Arepas']],
      ['asian', ['Ramen', 'Bibimbap']],
    ]);
    expect(layout(rs, 'cuisine', 'name').map(([key, , , ns]) => [key, ns])).toEqual([
      ['latin', ['Arepas', 'Tacos']],
      ['asian', ['Bibimbap', 'Ramen']],
    ]);
  });

  test('keeps extra fields, e.g. a search match', () => {
    const [section] = groupRecipes([{ ...recipe('1', 'Tacos', ['dinner']), ingredientMatch: 'tortillas' }], 'meal', 'name');
    expect(section.recipes[0].ingredientMatch).toBe('tortillas');
  });

  test('titles follow the language', () => {
    initI18n('es');
    try {
      expect(layout([tagged('1', 'Pho', { cuisine: ['vietnamese'] }), recipe('2', 'Pan')], 'cuisine')).toEqual([
        ['asian', 'Asiática', 'teal', ['Pho']],
        ['none', 'Sin cocina', 'grey', ['Pan']],
      ]);
    } finally {
      initI18n('en');
    }
  });

  test('each grouping lists every value once and ends with a grey "No …"', () => {
    expect(RECIPE_GROUP_SECTIONS.meal.map((s) => s.key)).toEqual(['breakfast', 'lunch', 'dinner', 'side', 'dessert', 'snack', 'drink', 'none']);
    // The meal hues are unchanged from By meal as a sort.
    expect(RECIPE_GROUP_SECTIONS.meal.map((s) => s.hue)).toEqual(['amber', 'teal', 'rose', 'green', 'plum', 'orange', 'blue', 'grey']);
    for (const sections of Object.values(RECIPE_GROUP_SECTIONS)) {
      const keys = sections.map((s) => s.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(sections.at(-1)).toEqual({ key: 'none', hue: 'grey' });
      expect(sections.slice(0, -1).map((s) => s.hue)).not.toContain('grey');
    }
  });

  test('section keys are per household and grouping', () => {
    expect(recipeSectionKey('home', 'meal', 'dinner')).toBe('home:meal:dinner');
    expect(recipeSectionKey('lake', 'meal', 'dinner')).not.toBe(recipeSectionKey('home', 'meal', 'dinner'));
    expect(recipeSectionKey('home', 'cuisine', 'none')).not.toBe(recipeSectionKey('home', 'meal', 'none'));
    expect(recipeSectionKey('home', 'cuisine', 'none')).toBe('home:cuisine:none');
  });
});

describe('the meta line by grouping', () => {
  const thai = { tags: { ...emptyRecipeTags(), meal: ['dinner'], cuisine: ['thai', 'american'] }, totalMinutes: 30 };

  test('grouped by cuisine, the first known cuisine in facet order replaces the meal', () => {
    expect(recipeMetaParts(thai, 'cuisine')).toEqual(['American', '30 min']);
    expect(recipeMetaLine({ ...thai, tags: { ...thai.tags, cuisine: ['martian', 'thai'] } }, 'cuisine')).toBe('Thai · 30 min');
    expect(recipeMetaLine({ ...thai, tags: { ...thai.tags, cuisine: [] } }, 'cuisine')).toBe('30 min');
    expect(recipeMetaLine({ tags: null, totalMinutes: null }, 'cuisine')).toBeNull();
    expect(recipeRowLabel({ name: 'Pad thai', ...thai }, null, null, 'cuisine')).toBe('Pad thai, American, 30 min');
  });

  test('every other grouping, and none, keeps the meal', () => {
    for (const group of RECIPE_GROUPS.filter((g) => g !== 'cuisine')) expect(recipeMetaLine(thai, group)).toBe('Dinner · 30 min');
    expect(recipeMetaLine(thai)).toBe('Dinner · 30 min');
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
