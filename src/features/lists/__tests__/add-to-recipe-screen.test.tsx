// "Add to recipe" (spec 4.5): the selected items go into a new recipe or an existing one, and the list
// screen is handed the result for its toast.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import AddToRecipeSheet from '@/app/list/[id]/add-to-recipe';
import { db, households } from '@/db';
import { categorizePending } from '@/features/categories/categorization';
import { addRecipeIngredient, createRecipe, recipeIngredientsQuery, recipesQuery } from '@/features/recipes/recipes';
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
    (n) => typeof n.type !== 'string' && 'onPress' in n.props && /ingredients?$/.test(n.props.accessibilityLabel ?? ''),
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
