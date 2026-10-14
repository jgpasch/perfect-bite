// "Add to recipe" (spec 4.5): the selected items go into a new recipe or an existing one, and the list
// screen is handed the result for its toast.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { eq } from 'drizzle-orm';

import AddToRecipeSheet from '@/app/list/[id]/add-to-recipe';
import { db, households, lists, recipes } from '@/db';
import { categorizePending } from '@/features/categories/categorization';
import { getRecipeFilters, setRecipeFilters } from '@/features/recipes/recipe-filter-store';
import { noRecipeFilters, toggleRecipeFilter } from '@/features/recipes/recipe-filters';
import {
  addRecipeIngredient,
  createRecipe,
  recipeIngredientsQuery,
  recipesQuery,
  updateRecipeTags,
} from '@/features/recipes/recipes';
import { emptyRecipeTags } from '@/shared/recipe-tags';
import { resetDb } from '@/test/db';

import { addItem } from '../items';
import { ensureStarterData, getDefaultListId, getList } from '../lists';
import { takeRecipeAddResult } from '../recipe-add-result';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('@/components/icon-tile', () => ({ IconTile: () => null }));
jest.mock('@/features/categories/categorization', () => ({
  ...jest.requireActual<object>('@/features/categories/categorization'),
  categorizePending: jest.fn(() => Promise.resolve()),
}));

const mockParams: { id?: string; items?: string } = {};
const mockBack = jest.fn();
jest.mock('expo-router', () => {
  const { createElement, Fragment } = require('react');
  const Toolbar = Object.assign(
    function PassThrough({ children }: { children?: unknown }) {
      return createElement(Fragment, null, children);
    },
    {
      Button: function Host({ children, ...props }: { children?: unknown }) {
        return createElement('ToolbarButton', props, children);
      },
    },
  );
  return {
    Stack: { Toolbar },
    router: { push: jest.fn(), back: () => mockBack() },
    useLocalSearchParams: () => mockParams,
  };
});

const USER = 'user-1';
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));

let listId: string;
let householdId: string;
let tree: ReactTestRenderer | null = null;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  listId = getDefaultListId(USER)!;
  householdId = getList(listId)!.householdId;
  mockBack.mockClear();
  jest.mocked(categorizePending).mockClear();
});

afterEach(() => {
  const shown = tree;
  tree = null;
  act(() => shown?.unmount());
  takeRecipeAddResult(listId);
});

function open(items: string[], id = listId) {
  mockParams.id = id;
  mockParams.items = items.join(',');
  act(() => {
    tree = create(<AddToRecipeSheet />);
  });
}

const textOf = (n: ReactTestInstance): string =>
  n.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
const lines = () => tree!.root.findAll((n) => n.type === ('Text' as never)).map(textOf);
const nameField = () =>
  tree!.root.find((n) => n.type === ('TextInput' as never) && n.props.accessibilityLabel === 'New recipe name');
const recipeRows = () =>
  tree!.root.findAll(
    (n) => typeof n.type !== 'string' && 'onPress' in n.props && /(ingredients?|, has .+)$/.test(n.props.accessibilityLabel ?? ''),
  );

describe('Add to recipe', () => {
  test('with no items (or no list) the sheet is empty', () => {
    open([]);
    expect(lines()).toEqual([]);
    act(() => tree!.unmount());
    open(['x'], 'gone');
    expect(lines()).toEqual([]);
  });

  test('the title counts the items', () => {
    const a = addItem(listId, 'milk', USER)!;
    const b = addItem(listId, 'eggs', USER)!;
    open([a.itemId, b.itemId]);
    expect(lines()).toContain('Add 2 items to…');
    act(() => tree!.unmount());
    open([a.itemId]);
    expect(lines()).toContain('Add 1 item to…');
  });

  test('typing a name and Return makes a recipe from the items, and hands the list its toast', () => {
    const a = addItem(listId, '2 milk', USER)!;
    const b = addItem(listId, 'eggs', USER)!;
    open([a.itemId, b.itemId]);
    act(() => nameField().props.onChangeText('  Sunday   pancakes '));
    act(() => nameField().props.onSubmitEditing());
    const recipe = recipesQuery().all().find((r) => r.name === 'Sunday pancakes')!;
    expect(recipe).toBeDefined();
    expect(recipeIngredientsQuery(recipe.id).all()).toHaveLength(2);
    expect(mockBack).toHaveBeenCalled();
    expect(categorizePending).toHaveBeenCalled();
    expect(takeRecipeAddResult(listId)).toEqual({
      kind: 'toRecipe',
      listId,
      recipeId: recipe.id,
      recipeName: 'Sunday pancakes',
      count: 2,
    });
  });

  test('Return on a blank name does nothing', () => {
    const a = addItem(listId, 'milk', USER)!;
    open([a.itemId]);
    act(() => nameField().props.onChangeText('   '));
    act(() => nameField().props.onSubmitEditing());
    expect(recipesQuery().all()).toHaveLength(0);
    expect(mockBack).not.toHaveBeenCalled();
  });

  test("the household's recipes are offered; picking one adds the items to it", () => {
    const tacos = createRecipe('Tacos', householdId);
    addRecipeIngredient(tacos, 'tortillas');
    const a = addItem(listId, 'limes', USER)!;
    open([a.itemId]);
    expect(recipeRows().map((r) => r.props.accessibilityLabel)).toEqual(['Tacos, 1 ingredient']);
    act(() => {
      recipeRows()[0].props.onPress();
    });
    expect(recipeIngredientsQuery(tacos).all().map((i) => i.displayName).sort()).toEqual(['limes', 'tortillas']);
    expect(takeRecipeAddResult(listId)).toMatchObject({ kind: 'toRecipe', recipeId: tacos, recipeName: 'Tacos', count: 1 });
    expect(mockBack).toHaveBeenCalled();
  });

  test("another household's recipes are not offered", () => {
    createRecipe('Tacos', householdId);
    db.insert(households).values({ id: 'h-other', name: 'Friends' }).run();
    createRecipe('Chili', 'h-other');
    const a = addItem(listId, 'limes', USER)!;
    open([a.itemId]);
    expect(recipeRows().map((r) => r.props.accessibilityLabel)).toEqual(['Tacos, 0 ingredients']);
  });

  test('Cancel closes without adding', () => {
    const a = addItem(listId, 'milk', USER)!;
    open([a.itemId]);
    act(() => {
      tree!.root.find((n) => n.type === ('ToolbarButton' as never)).props.onPress();
    });
    expect(mockBack).toHaveBeenCalled();
    expect(takeRecipeAddResult(listId)).toBeNull();
  });
});

describe('Add to recipe: search and filters', () => {
  /** Tacos (dinner, chicken thighs), Pancakes (breakfast, flour), Grandma soup (untagged), most recently used in that order. */
  function seed() {
    const tacos = createRecipe('Tacos', householdId);
    addRecipeIngredient(tacos, '2 lb chicken thighs');
    updateRecipeTags(tacos, { ...emptyRecipeTags(), meal: ['dinner'], protein: ['chicken'] }, 25);
    const pancakes = createRecipe('Pancakes', householdId);
    addRecipeIngredient(pancakes, 'flour');
    updateRecipeTags(pancakes, { ...emptyRecipeTags(), meal: ['breakfast'] }, 40);
    const soup = createRecipe('Grandma soup', householdId);
    for (const [recipeId, day] of [[tacos, 3], [pancakes, 2], [soup, 1]] as const) {
      db.update(recipes).set({ updatedAt: new Date(2026, 0, day) }).where(eq(recipes.id, recipeId)).run();
    }
    return { tacos, pancakes, soup };
  }

  const isSearchField = (n: ReactTestInstance) => n.type === ('TextInput' as never) && n.props.accessibilityLabel === 'Search recipes';
  const searchField = () => tree!.root.find(isSearchField);
  const search = (text: string) => act(() => searchField().props.onChangeText(text));
  const names = () => recipeRows().map((r) => (r.props.accessibilityLabel as string).split(',')[0]);
  const isFiltersPill = (n: ReactTestInstance) => typeof n.type !== 'string' && n.props.accessibilityHint === 'Opens the filters.';
  const filtersPill = () => tree!.root.find(isFiltersPill);
  const pressNode = (n: ReactTestInstance) => act(() => n.props.onPress());
  const toggle = (label: string) =>
    pressNode(tree!.root.find((n) => typeof n.type !== 'string' && n.props.label === label && n.props.accessibilityRole === 'togglebutton'));
  const showButton = () =>
    tree!.root.find((n) => typeof n.type !== 'string' && /^Show \d+ recipes?$/.test(n.props.label ?? '') && n.props.onPress);
  const clearFiltersButtons = () =>
    tree!.root.findAll((n) => typeof n.type !== 'string' && n.props.label === 'Clear filters' && n.props.onPress);
  const chips = () =>
    tree!.root.findAll(
      (n) => typeof n.type !== 'string' && /^Remove .* filter$/.test(n.props.accessibilityLabel ?? '') && n.props.onPress,
    );
  const nameFields = () =>
    tree!.root.findAll((n) => n.type === ('TextInput' as never) && n.props.accessibilityLabel === 'New recipe name');
  function filterBy(label: string) {
    pressNode(filtersPill());
    toggle(label);
    pressNode(showButton());
  }

  beforeEach(() => setRecipeFilters(noRecipeFilters()));
  afterEach(() => setRecipeFilters(noRecipeFilters()));

  test('the search field counts the recipes; without recipes there is no search or Filters', () => {
    seed();
    const a = addItem(listId, 'limes', USER)!;
    open([a.itemId]);
    expect(searchField().props.placeholder).toBe('Search 3 recipes');
    expect(filtersPill().props.label).toBe('Filters');
    expect(names()).toEqual(['Tacos', 'Pancakes', 'Grandma soup']);
    act(() => tree!.unmount());
    db.insert(households).values({ id: 'h-empty', name: 'Empty' }).run();
    // A list in a household with no recipes.
    const other = getList(listId)!;
    db.update(lists).set({ householdId: 'h-empty' }).where(eq(lists.id, other.id)).run();
    open([a.itemId]);
    expect(tree!.root.findAll(isSearchField)).toHaveLength(0);
    expect(tree!.root.findAll(isFiltersPill)).toHaveLength(0);
    expect(nameFields()).toHaveLength(1);
  });

  test('searches by name, ignoring case, keeping most-recently-used order', () => {
    seed();
    const a = addItem(listId, 'limes', USER)!;
    open([a.itemId]);
    search('TAC');
    expect(names()).toEqual(['Tacos']);
    search('a');
    expect(names()).toEqual(['Tacos', 'Pancakes', 'Grandma soup']);
    search('soup');
    expect(recipeRows().map((r) => r.props.accessibilityLabel)).toEqual(['Grandma soup, 0 ingredients']);
    search('');
    expect(names()).toEqual(['Tacos', 'Pancakes', 'Grandma soup']);
  });

  test('searches by ingredient, with a "Has …" line in place of the count', () => {
    seed();
    const a = addItem(listId, 'limes', USER)!;
    open([a.itemId]);
    search('thigh');
    expect(recipeRows().map((r) => r.props.accessibilityLabel)).toEqual(['Tacos, has chicken thighs']);
    expect(lines()).toContain('Has chicken thighs');
    expect(lines()).not.toContain('1 ingredient');
  });

  test('picking a searched recipe adds the items to it as before', () => {
    const { pancakes } = seed();
    const a = addItem(listId, 'eggs', USER)!;
    open([a.itemId]);
    search('flour');
    expect(names()).toEqual(['Pancakes']);
    act(() => {
      recipeRows()[0].props.onPress();
    });
    expect(recipeIngredientsQuery(pancakes).all().map((i) => i.displayName).sort()).toEqual(['eggs', 'flour']);
    expect(takeRecipeAddResult(listId)).toMatchObject({ kind: 'toRecipe', recipeId: pancakes, recipeName: 'Pancakes', count: 1 });
    expect(mockBack).toHaveBeenCalled();
  });

  test('the New recipe row stays whatever the search, and a name that matches nothing can still be made', () => {
    seed();
    const a = addItem(listId, 'limes', USER)!;
    open([a.itemId]);
    search('lasagna');
    expect(names()).toEqual([]);
    expect(lines()).toContain('No recipes match');
    expect(clearFiltersButtons()).toHaveLength(0);
    expect(nameFields()).toHaveLength(1);
    act(() => nameFields()[0].props.onChangeText('Lasagna'));
    act(() => nameFields()[0].props.onSubmitEditing());
    const made = recipesQuery().all().find((r) => r.name === 'Lasagna')!;
    expect(made).toBeDefined();
    expect(recipeIngredientsQuery(made.id).all().map((i) => i.displayName)).toEqual(['limes']);
    expect(takeRecipeAddResult(listId)).toMatchObject({ recipeId: made.id, recipeName: 'Lasagna' });
  });

  test('a filter narrows the list and shows as a chip that removes it', () => {
    seed();
    const a = addItem(listId, 'limes', USER)!;
    open([a.itemId]);
    pressNode(filtersPill());
    // The filter sheet's body takes the sheet's place.
    expect(nameFields()).toHaveLength(0);
    expect(showButton().props.label).toBe('Show 3 recipes');
    toggle('Dinner');
    expect(showButton().props.label).toBe('Show 1 recipe');
    pressNode(showButton());
    expect(names()).toEqual(['Tacos']);
    expect(nameFields()).toHaveLength(1);
    expect(filtersPill().props.label).toBe('Filters · 1');
    expect(chips().map((c) => c.props.accessibilityLabel)).toEqual(['Remove Dinner filter']);
    pressNode(chips()[0]);
    expect(names()).toEqual(['Tacos', 'Pancakes', 'Grandma soup']);
    expect(filtersPill().props.label).toBe('Filters');
  });

  test('filters AND with the search; no results offers Clear filters', () => {
    seed();
    const a = addItem(listId, 'limes', USER)!;
    open([a.itemId]);
    filterBy('Breakfast');
    expect(names()).toEqual(['Pancakes']);
    search('tacos');
    expect(names()).toEqual([]);
    expect(lines()).toContain('No recipes match');
    expect(nameFields()).toHaveLength(1);
    expect(clearFiltersButtons()).toHaveLength(1);
    pressNode(clearFiltersButtons()[0]);
    expect(names()).toEqual(['Tacos']);
    expect(chips()).toHaveLength(0);
  });

  test("the filter body's Clear clears the sheet's filters", () => {
    seed();
    const a = addItem(listId, 'limes', USER)!;
    open([a.itemId]);
    pressNode(filtersPill());
    const clear = () =>
      tree!.root.find((n) => n.type === ('ToolbarButton' as never) && n.props.accessibilityLabel === 'Clear filters');
    expect(clear().props.disabled).toBe(true);
    toggle('Dinner');
    expect(clear().props.disabled).toBe(false);
    pressNode(clear());
    expect(showButton().props.label).toBe('Show 3 recipes');
  });

  test("the Recipes tab's filters are untouched and not used, and the sheet's reset when it closes", () => {
    seed();
    const tabFilters = toggleRecipeFilter(noRecipeFilters(), 'meal', 'breakfast');
    setRecipeFilters(tabFilters);
    const a = addItem(listId, 'limes', USER)!;
    open([a.itemId]);
    // Doesn't start from the tab's.
    expect(filtersPill().props.label).toBe('Filters');
    expect(names()).toEqual(['Tacos', 'Pancakes', 'Grandma soup']);
    filterBy('Dinner');
    search('ta');
    expect(names()).toEqual(['Tacos']);
    // Doesn't change the tab's.
    expect(getRecipeFilters()).toBe(tabFilters);
    // Closed and opened again: no search, no filters.
    act(() => tree!.unmount());
    open([a.itemId]);
    expect(searchField().props.value).toBe('');
    expect(filtersPill().props.label).toBe('Filters');
    expect(names()).toEqual(['Tacos', 'Pancakes', 'Grandma soup']);
    expect(getRecipeFilters()).toBe(tabFilters);
  });
});
