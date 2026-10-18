// The Recipes tab's shelves (spec 4.5, 4.16): This week, Recently added and Favorites, and when they show.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { getRecipeSortChoice, setDeviceSetting } from '@/features/settings/device-settings';
import { initI18n } from '@/i18n';
import { emptyRecipeTags, type RecipeTags } from '@/shared/recipe-tags';
import { resetDb } from '@/test/db';

import { noRecipeFilters, toggleRecipeFilter } from '../recipe-filters';
import { recipeShelves, SHELF_MAX_ITEMS, SHELVES_MIN_RECIPES, shelvesShown } from '../recipe-shelves';
import { RECIPE_GROUP_KEY, RECIPE_SORT_KEY } from '../recipe-sort';

jest.mock('@/db/client', () => require('@/test/db'));

type TestRecipe = { id: string; name: string; tags: RecipeTags | null; totalMinutes: number | null };
type TestEntry = Parameters<typeof recipeShelves>[0]['entries'][number];

const recipe = (id: string, name: string, totalMinutes: number | null = null, saved: string[] = []): TestRecipe => ({
  id,
  name,
  tags: saved.length > 0 ? { ...emptyRecipeTags(), saved } : null,
  totalMinutes,
});

/** Newest change first, as `recipesQuery` gives them. */
const RECIPES: TestRecipe[] = [
  recipe('r1', 'Tacos', 35),
  recipe('r2', 'Pad thai', 30, ['favorite']),
  recipe('r3', 'Curry', 80),
  recipe('r4', 'Banana bread', 60, ['favorite', 'want-to-try']),
  recipe('r5', 'Frittata', null),
  recipe('r6', 'Apple crumble', 45, ['want-to-try']),
  recipe('r7', 'Miso soup', 15),
  recipe('r8', 'Enchiladas', 50, ['favorite']),
];

const entry = (planDate: string, meal: TestEntry['meal'], recipeId: string | null, extra: Partial<TestEntry> = {}): TestEntry => ({
  planDate,
  meal,
  kind: 'recipe',
  recipeId,
  position: 0,
  ...extra,
});

// Thursday; its week runs Sun Oct 11 to Sat Oct 17.
const TODAY = '2026-10-15';

const shelves = (recipes: readonly TestRecipe[] = RECIPES, entries: readonly TestEntry[] = []) =>
  recipeShelves({ recipes, entries, today: TODAY, language: 'en' });
const view = (rs: ReturnType<typeof shelves>) =>
  rs.map((s) => [s.key, s.title, s.count, s.items.map((i) => [i.recipe.name, i.caption])]);

afterEach(() => initI18n('en'));

describe('recipeShelves', () => {
  test('This week, Recently added and Favorites in order, with their captions and counts', () => {
    const entries = [
      // Out of order on purpose: by day, then meal.
      entry('2026-10-16', 'dinner', 'r3'),
      entry('2026-10-15', 'dinner', 'r1'),
      entry('2026-10-15', 'breakfast', 'r5'),
    ];
    expect(view(shelves(RECIPES, entries))).toEqual([
      [
        'thisWeek',
        'This week',
        3,
        [
          ['Frittata', 'Thu breakfast'],
          ['Tacos', 'Thu dinner'],
          ['Curry', 'Fri dinner'],
        ],
      ],
      [
        'recent',
        'Recently added',
        8,
        [
          ['Tacos', '35 min'],
          ['Pad thai', '30 min'],
          ['Curry', '1 hr 20 min'],
          ['Banana bread', '1 hr'],
          ['Frittata', null],
          ['Apple crumble', '45 min'],
          ['Miso soup', '15 min'],
          ['Enchiladas', '50 min'],
        ],
      ],
      [
        'favorites',
        'Favorites',
        3,
        [
          ['Banana bread', '1 hr'],
          ['Enchiladas', '50 min'],
          ['Pad thai', '30 min'],
        ],
      ],
    ]);
  });

  test('items are the recipes passed in, not copies', () => {
    const [week] = shelves(RECIPES, [entry('2026-10-17', 'lunch', 'r7')]);
    expect(week.items[0].recipe).toBe(RECIPES[6]);
  });

  test('Recently added and Favorites show 10 at most, but count them all', () => {
    const many = Array.from({ length: 14 }, (_, i) => recipe(`m${i}`, `Dish ${String(i).padStart(2, '0')}`, null, ['favorite']));
    const [recent, favorites] = shelves(many);
    expect(SHELF_MAX_ITEMS).toBe(10);
    expect(recent.count).toBe(14);
    expect(recent.items.map((i) => i.recipe.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9']);
    expect(favorites.key).toBe('favorites');
    expect(favorites.count).toBe(14);
    expect(favorites.items).toHaveLength(10);
    expect(favorites.items.at(-1)!.recipe.name).toBe('Dish 09');
  });

  test('past days this week and other weeks are left out of This week', () => {
    const entries = [
      entry('2026-10-14', 'dinner', 'r2'), // yesterday
      entry('2026-10-11', 'lunch', 'r3'), // this Sunday
      entry('2026-10-10', 'dinner', 'r4'), // last week
      entry('2026-10-18', 'dinner', 'r6'), // next Sunday
      entry('2026-10-15', 'lunch', 'r1'), // today
      entry('2026-10-17', 'dinner', 'r7'), // Saturday, the week's last day
    ];
    const [week] = shelves(RECIPES, entries);
    expect(week.count).toBe(2);
    expect(week.items.map((i) => [i.recipe.name, i.caption])).toEqual([
      ['Tacos', 'Thu lunch'],
      ['Miso soup', 'Sat dinner'],
    ]);
  });

  test('a recipe planned more than once shows once, at its first slot, and each entry counts', () => {
    const entries = [entry('2026-10-17', 'dinner', 'r1'), entry('2026-10-16', 'lunch', 'r1'), entry('2026-10-16', 'dinner', 'r3')];
    const [week] = shelves(RECIPES, entries);
    expect(week.count).toBe(3);
    expect(week.items.map((i) => [i.recipe.name, i.caption])).toEqual([
      ['Tacos', 'Fri lunch'],
      ['Curry', 'Fri dinner'],
    ]);
  });

  test('two entries in one slot keep their position order', () => {
    const entries = [entry('2026-10-16', 'dinner', 'r3', { position: 1 }), entry('2026-10-16', 'dinner', 'r1', { position: 0 })];
    expect(shelves(RECIPES, entries)[0].items.map((i) => i.recipe.name)).toEqual(['Tacos', 'Curry']);
  });

  test('notes, leftovers, eating out and recipes no longer in the list are left out', () => {
    const entries = [
      entry('2026-10-15', 'dinner', null, { kind: 'note' }),
      entry('2026-10-16', 'dinner', null, { kind: 'leftovers' }),
      entry('2026-10-16', 'lunch', null, { kind: 'eating-out' }),
      entry('2026-10-17', 'dinner', 'gone'),
      entry('2026-10-17', 'lunch', 'r8'),
    ];
    const [week] = shelves(RECIPES, entries);
    expect(week.count).toBe(1);
    expect(week.items.map((i) => i.recipe.name)).toEqual(['Enchiladas']);
  });

  test('empty shelves are left out', () => {
    const noFavorites = RECIPES.map((r) => ({ ...r, tags: null }));
    expect(shelves(noFavorites).map((s) => s.key)).toEqual(['recent']);
    // Want to try isn't a favorite.
    expect(shelves([...noFavorites.slice(1), recipe('w', 'Waffles', null, ['want-to-try'])]).map((s) => s.key)).toEqual(['recent']);
    expect(shelves(RECIPES, [entry('2026-10-10', 'dinner', 'r1')]).map((s) => s.key)).toEqual(['recent', 'favorites']);
  });

  test('shelves span households', () => {
    const mixed = RECIPES.map((r, i) => ({ ...r, householdId: i % 2 ? 'home' : 'cabin' }));
    const [week, recent] = recipeShelves({
      recipes: mixed,
      entries: [entry('2026-10-15', 'dinner', 'r1'), entry('2026-10-15', 'lunch', 'r2')],
      today: TODAY,
      language: 'en',
    });
    expect(week.items.map((i) => i.recipe.householdId)).toEqual(['home', 'cabin']);
    expect(recent.count).toBe(8);
  });

  test('fewer than 8 recipes gives no shelves', () => {
    expect(SHELVES_MIN_RECIPES).toBe(8);
    expect(shelves(RECIPES.slice(0, 7), [entry('2026-10-15', 'dinner', 'r1')])).toEqual([]);
    expect(shelves([])).toEqual([]);
    expect(shelves(RECIPES.slice(0, 8)).length).toBeGreaterThan(0);
  });

  test('Spanish titles and captions', () => {
    initI18n('es');
    const result = recipeShelves({ recipes: RECIPES, entries: [entry('2026-10-15', 'dinner', 'r1')], today: TODAY, language: 'es' });
    expect(result.map((s) => s.title)).toEqual(['Esta semana', 'Agregadas recientemente', 'Favoritas']);
    expect(result[0].items[0].caption).toBe('cena del jue');
  });
});

describe('shelvesShown', () => {
  const filters = noRecipeFilters();

  test('8 or more recipes, no search and no filters: shown', () => {
    expect(shelvesShown({ query: '', filters, recipeCount: 8 })).toBe(true);
    expect(shelvesShown({ query: '', filters, recipeCount: 120 })).toBe(true);
  });

  test('fewer than 8 recipes: none', () => {
    expect(shelvesShown({ query: '', filters, recipeCount: 7 })).toBe(false);
    expect(shelvesShown({ query: '', filters, recipeCount: 0 })).toBe(false);
  });

  test('a search hides them; blank space doesn’t count as one', () => {
    expect(shelvesShown({ query: 'taco', filters, recipeCount: 20 })).toBe(false);
    expect(shelvesShown({ query: '   ', filters, recipeCount: 20 })).toBe(true);
  });

  test('a filter hides them, Untagged too', () => {
    expect(shelvesShown({ query: '', filters: toggleRecipeFilter(filters, 'saved', 'favorite'), recipeCount: 20 })).toBe(false);
    expect(shelvesShown({ query: '', filters: toggleRecipeFilter(filters, 'time', 'under-30'), recipeCount: 20 })).toBe(false);
    expect(shelvesShown({ query: '', filters: { ...filters, untagged: true }, recipeCount: 20 })).toBe(false);
  });
});

describe('the default sort', () => {
  beforeEach(() => resetDb());

  test('with no stored sort the tab reads A–Z, ungrouped', () => {
    expect(getRecipeSortChoice()).toEqual({ sort: 'name', group: 'none' });
  });

  test('a stored sort is kept', () => {
    setDeviceSetting(RECIPE_SORT_KEY, 'recent');
    setDeviceSetting(RECIPE_GROUP_KEY, 'cuisine');
    expect(getRecipeSortChoice()).toEqual({ sort: 'recent', group: 'cuisine' });
  });
});
