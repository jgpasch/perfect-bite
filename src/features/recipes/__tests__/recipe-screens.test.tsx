// The recipe screen and its "Add to a list" sheet (spec 4.5, boards 06 and 07), rendered against the
// in-memory database: ingredients, edit/delete/undo, the menu, and choosing list, servings and ingredients.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Alert, type AlertButton } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { eq } from 'drizzle-orm';

import { db, lists } from '@/db';
import { resolveCurrentListId } from '@/features/lists/current-list';
import { groupItems, listItemsQuery } from '@/features/lists/items';
import { createList, ensureStarterData, getDefaultListId, listsWithCountsQuery } from '@/features/lists/lists';
import { startAdjust, takeRecipeAddResult } from '@/features/lists/recipe-add-result';
import { resetDb } from '@/test/db';

import AddRecipeToListSheet from '@/app/recipe/[id]/add-to-list';
import RecipeScreen from '@/app/recipe/[id]/index';

import { addRecipeToList, buildRecipeAdds } from '../add-to-list';
import { RecipeIngredientRow } from '../recipe-ingredient-row';
import { addRecipeIngredient, createRecipe, getRecipe, recipeIngredientsQuery } from '../recipes';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const builder: object = new Proxy({}, { get: () => () => builder });
  return {
    __esModule: true,
    default: { View, createAnimatedComponent: (c: unknown) => c },
    FadeIn: builder,
    FadeInDown: builder,
    FadeOut: builder,
    LinearTransition: builder,
    useReducedMotion: () => false,
  };
});
// The swipe: a host element whose `onSwipeableOpen` the test calls, as a full swipe would.
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const { createElement } = require('react');
  return {
    __esModule: true,
    default: ({ children, onSwipeableOpen, renderRightActions }: Record<string, any>) =>
      createElement('Swipeable', { onSwipeableOpen, renderRightActions }, children),
  };
});
jest.mock('expo-network', () => ({ addNetworkStateListener: () => ({ remove: () => {} }) }));
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
const mockCategorize = jest.fn((_names?: readonly string[]) => Promise.resolve());
jest.mock('@/features/categories/categorization', () => ({
  categorizePending: (names?: readonly string[]) => mockCategorize(names),
}));
// The add bar is its own component; the screen only hands it `onAdd`.
jest.mock('@/features/lists/add-bar', () => {
  const { createElement } = require('react');
  return { ItemAddBar: (props: object) => createElement('ItemAddBar', props) };
});

const mockParams: Record<string, string | undefined> = {};
const mockPush = jest.fn();
const mockNavigate = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => {
  const { createElement, Fragment } = require('react');
  const passThrough = () =>
    function PassThrough({ children }: { children?: unknown }) {
      return createElement(Fragment, null, children);
    };
  const host = (type: string) =>
    function Host({ children, ...props }: { children?: unknown }) {
      return createElement(type, props, children);
    };
  const Toolbar = Object.assign(passThrough(), {
    Button: host('ToolbarButton'),
    Menu: host('ToolbarMenu'),
    MenuAction: host('ToolbarMenuAction'),
  });
  return {
    Stack: { Screen: () => null, Toolbar },
    router: {
      push: (...args: unknown[]) => mockPush(...args),
      navigate: (...args: unknown[]) => mockNavigate(...args),
      back: () => mockBack(),
    },
    useLocalSearchParams: () => mockParams,
  };
});
jest.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 0 }));
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));

const USER = 'user-1';
let tree: ReactTestRenderer | null = null;
let groceries: string;
let tacos: string;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  groceries = getDefaultListId(USER)!;
  tacos = createRecipe('Tacos');
  for (const k of Object.keys(mockParams)) delete mockParams[k];
  mockParams.id = tacos;
  mockPush.mockClear();
  mockNavigate.mockClear();
  mockBack.mockClear();
  mockCategorize.mockClear();
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  jest.restoreAllMocks();
});

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

function render(element: React.ReactElement): ReactTestRenderer {
  act(() => {
    tree = create(<SafeAreaProvider initialMetrics={METRICS}>{element}</SafeAreaProvider>);
  });
  return tree!;
}

/** Every host Text's full string (nested Text included), outermost only, in order. */
const texts = (root: ReactTestRenderer) => {
  const out: string[] = [];
  const flat = (node: unknown): string =>
    typeof node === 'string' ? node : node && typeof node === 'object' ? ((node as { children?: unknown[] }).children ?? []).map(flat).join('') : '';
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const n = node as { type: string; children?: unknown[] };
    if (n.type === 'Text') {
      const s = flat(n);
      if (s) out.push(s);
      return;
    }
    n.children?.forEach(walk);
  };
  walk(root.toJSON());
  return out;
};
const byType = (root: ReactTestRenderer, type: string) => root.root.findAll((n) => n.type === type);
/** The composite element with this `label` (Button, PrimaryButton, Pill). */
const byLabel = (root: ReactTestRenderer, label: string) =>
  root.root.find((n) => typeof n.type !== 'string' && n.props.label === label && typeof n.props.onPress === 'function');
/** The first composite pressable with this accessibility label. */
const byA11y = (root: ReactTestRenderer, label: string) =>
  root.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
const queryA11y = (root: ReactTestRenderer, label: string) =>
  root.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
const press = (n: ReactTestInstance) => act(() => n.props.onPress());
const menuAction = (root: ReactTestRenderer, title: string) =>
  byType(root, 'ToolbarMenuAction').find((n) => n.props.children === title)!;

const listRows = (listId: string) =>
  groupItems(listItemsQuery(listId).all()).unchecked.map((i) =>
    i.amountText ? `${i.amountText} ${i.displayName}` : i.displayName,
  );

describe('RecipeScreen', () => {
  test('a missing recipe renders an empty screen', () => {
    mockParams.id = 'nope';
    const root = render(<RecipeScreen />);
    expect(texts(root)).toEqual([]);
    expect(byType(root, 'ItemAddBar')).toHaveLength(0);
  });

  test('no ingredients: the empty line, and Add to a list is disabled', () => {
    const root = render(<RecipeScreen />);
    expect(texts(root)).toEqual(expect.arrayContaining(['Tacos', 'No ingredients yet. Add them below.']));
    expect(byLabel(root, 'Add to a list').props.disabled).toBe(true);
  });

  test('lists the ingredients with amounts in order, and Add to a list opens the sheet', () => {
    addRecipeIngredient(tacos, '1 lb ground beef');
    addRecipeIngredient(tacos, 'cilantro');
    const root = render(<RecipeScreen />);
    expect(texts(root)).not.toContain('No ingredients yet. Add them below.');
    const rows = root.root.findAll((n) => n.type === RecipeIngredientRow);
    expect(rows.map((r) => r.props.ingredient.displayName)).toEqual(['ground beef', 'cilantro']);
    expect(queryA11y(root, '1 lb Ground beef')).not.toHaveLength(0);
    const cta = byLabel(root, 'Add to a list');
    expect(cta.props.disabled).toBe(false);
    press(cta);
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]/add-to-list', params: { id: tacos } });
  });

  test('the add bar adds a parsed ingredient and categorizes its new name', () => {
    const root = render(<RecipeScreen />);
    const bar = byType(root, 'ItemAddBar')[0];
    expect(bar.props.placeholder).toBe('Add 2 cups flour…');
    expect(bar.props.householdId).toBe(getRecipe(tacos)!.householdId);
    act(() => bar.props.onAdd('2 cups flour'));
    const [row] = recipeIngredientsQuery(tacos).all();
    expect([row.quantity, row.unit, row.ingredientName]).toEqual([2, 'cup', 'flour']);
    expect(mockCategorize).toHaveBeenCalledWith(['flour']);
  });

  test('tapping an ingredient prompts with its text and saves the edit', () => {
    addRecipeIngredient(tacos, '2 limes');
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const root = render(<RecipeScreen />);
    press(byA11y(root, '2 Limes'));
    expect(prompt).toHaveBeenCalledTimes(1);
    const [title, , onSubmit, , defaultValue] = prompt.mock.calls[0];
    expect(title).toBe('Edit ingredient');
    expect(defaultValue).toBe('2 limes');
    // Empty text is ignored.
    act(() => (onSubmit as (t: string) => void)('   '));
    expect(recipeIngredientsQuery(tacos).all()[0].quantity).toBe(2);
    act(() => (onSubmit as (t: string) => void)('3 limes'));
    expect(recipeIngredientsQuery(tacos).all()[0].quantity).toBe(3);
  });

  test('an edit that leaves no name shows the error', () => {
    addRecipeIngredient(tacos, '2 limes');
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const root = render(<RecipeScreen />);
    press(byA11y(root, '2 Limes'));
    act(() => (prompt.mock.calls[0][2] as (t: string) => void)('-'));
    expect(alert).toHaveBeenCalledWith('An ingredient needs a name');
  });

  test('swiping an ingredient away deletes it with an Undo toast that restores it', () => {
    addRecipeIngredient(tacos, '2 limes');
    addRecipeIngredient(tacos, 'cilantro');
    const root = render(<RecipeScreen />);
    act(() => byType(root, 'Swipeable')[0].props.onSwipeableOpen());
    expect(recipeIngredientsQuery(tacos).all().map((i) => i.displayName)).toEqual(['cilantro']);
    expect(texts(root)).toContain('Removed Limes');
    press(byA11y(root, 'Undo'));
    expect(recipeIngredientsQuery(tacos).all().map((i) => i.displayName)).toEqual(['limes', 'cilantro']);
    expect(texts(root)).not.toContain('Removed Limes');
  });

  test('the VoiceOver delete action deletes too', () => {
    addRecipeIngredient(tacos, '2 limes');
    const root = render(<RecipeScreen />);
    const row = byA11y(root, '2 Limes');
    act(() => row.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } }));
    expect(recipeIngredientsQuery(tacos).all()).toHaveLength(1);
    act(() => row.props.onAccessibilityAction({ nativeEvent: { actionName: 'delete' } }));
    expect(recipeIngredientsQuery(tacos).all()).toHaveLength(0);
  });

  test('Rename in the menu prompts with the current name and saves it', () => {
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const root = render(<RecipeScreen />);
    act(() => menuAction(root, 'Rename').props.onPress());
    expect(prompt.mock.calls[0][0]).toBe('Rename recipe');
    expect(prompt.mock.calls[0][4]).toBe('Tacos');
    const save = (prompt.mock.calls[0][2] as AlertButton[]).find((b) => b.text === 'Save')!;
    act(() => (save.onPress as (name: string) => void)('Fish tacos'));
    expect(getRecipe(tacos)!.name).toBe('Fish tacos');
  });

  test('Delete recipe confirms, then deletes and goes back; Cancel keeps it', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const root = render(<RecipeScreen />);
    act(() => menuAction(root, 'Delete recipe').props.onPress());
    const [title, message, buttons] = alert.mock.calls[0];
    expect(title).toBe('Delete “Tacos”?');
    expect(message).toBe('Items already on your lists stay there.');
    expect((buttons as AlertButton[]).map((b) => b.text)).toEqual(['Cancel', 'Delete']);
    expect(getRecipe(tacos)).toBeDefined();
    act(() => (buttons as AlertButton[])[1].onPress!());
    expect(getRecipe(tacos)).toBeUndefined();
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('editing the link and notes saves them when the field loses focus', () => {
    const root = render(<RecipeScreen />);
    const link = root.root.find((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Link to the recipe');
    const notes = root.root.find((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Notes');
    act(() => link.props.onChangeText('https://example.com/tacos'));
    act(() => notes.props.onChangeText('  Double the salsa  '));
    act(() => notes.props.onEndEditing());
    expect(getRecipe(tacos)).toMatchObject({ sourceUrl: 'https://example.com/tacos', notes: 'Double the salsa', name: 'Tacos' });
  });
});

describe('RecipeIngredientRow', () => {
  test('shows the name, note and amount, and labels them together', () => {
    const id = addRecipeIngredient(tacos, '1 cup salsa')!.id;
    const ingredient = { ...recipeIngredientsQuery(tacos).all().find((i) => i.id === id)!, note: 'verde' };
    const onEdit = jest.fn();
    const onDelete = jest.fn();
    const root = render(<RecipeIngredientRow ingredient={ingredient} dotColor="#f00" onEdit={onEdit} onDelete={onDelete} />);
    expect(texts(root)).toEqual(['Salsa', 'verde', '1 cup']);
    const row = byA11y(root, '1 cup Salsa verde');
    press(row);
    expect(onEdit).toHaveBeenCalledTimes(1);
    act(() => byType(root, 'Swipeable')[0].props.onSwipeableOpen());
    expect(onDelete).toHaveBeenCalledTimes(1);
    // Swiping reveals the delete action behind the row.
    expect(byType(root, 'Swipeable')[0].props.renderRightActions()).toBeTruthy();
  });

  test('without an amount it shows the name alone', () => {
    addRecipeIngredient(tacos, 'cilantro');
    const [ingredient] = recipeIngredientsQuery(tacos).all();
    const root = render(<RecipeIngredientRow ingredient={ingredient} dotColor="#f00" onEdit={() => {}} onDelete={() => {}} />);
    expect(texts(root)).toEqual(['Cilantro']);
    expect(queryA11y(root, 'Cilantro')).toHaveLength(1);
  });
});

describe('AddRecipeToListSheet', () => {
  beforeEach(() => {
    for (const text of ['1 lb ground beef', '8 tortillas', 'cilantro']) addRecipeIngredient(tacos, text);
  });

  const checkboxes = (root: ReactTestRenderer) =>
    root.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'checkbox' && !!n.props.onPress);
  const selectedPills = (root: ReactTestRenderer) =>
    root.root.findAll((n) => typeof n.type !== 'string' && n.props.selected === true && !!n.props.label).map((n) => n.props.label);

  test('a missing recipe renders an empty screen', () => {
    mockParams.id = 'nope';
    const root = render(<AddRecipeToListSheet />);
    expect(texts(root)).toEqual([]);
  });

  test('starts on the default list at 1×, every ingredient ticked', () => {
    const root = render(<AddRecipeToListSheet />);
    expect(texts(root)).toEqual(expect.arrayContaining(['Add Tacos', 'To', 'Servings', 'Untick what you have', '3 of 3']));
    const groceriesName = db.select().from(lists).all().find((l) => l.id === groceries)!.name;
    expect(selectedPills(root)).toEqual([groceriesName, '1×']);
    expect(checkboxes(root).map((c) => [c.props.accessibilityLabel, c.props.accessibilityState.checked])).toEqual([
      ['Ground beef, 1 lb', true],
      ['Tortillas, 8', true],
      ['Cilantro', true],
    ]);
    expect(byLabel(root, `Add 3 to ${groceriesName}`).props.disabled).toBe(false);
  });

  test('servings scale the amounts; unticking drops an ingredient from the add', () => {
    const root = render(<AddRecipeToListSheet />);
    press(byLabel(root, '2×'));
    expect(checkboxes(root).map((c) => c.props.accessibilityLabel)).toEqual(['Ground beef, 2 lb', 'Tortillas, 16', 'Cilantro']);
    press(checkboxes(root)[2]);
    expect(texts(root)).toContain('2 of 3');
    expect(checkboxes(root)[2].props.accessibilityState.checked).toBe(false);
    const add = root.root.find((n) => typeof n.type !== 'string' && /^Add 2 to /.test(n.props.label ?? ''));
    press(add);
    expect(listRows(groceries)).toEqual(['2 lb ground beef', '16 tortillas']);
  });

  test('unticking everything disables the add', () => {
    const root = render(<AddRecipeToListSheet />);
    for (const c of checkboxes(root)) press(c);
    const add = root.root.find((n) => typeof n.type !== 'string' && n.props.label === 'Nothing selected' && n.props.onPress);
    expect(add.props.disabled).toBe(true);
    press(checkboxes(root)[1]);
    expect(texts(root)).toContain('1 of 3');
  });

  test('adding to another list hands the toast its result, closes, and shows that list on the List tab', () => {
    const party = createList('Party');
    const root = render(<AddRecipeToListSheet />);
    press(byLabel(root, 'Party'));
    expect(selectedPills(root)).toContain('Party');
    press(byLabel(root, 'Add 3 to Party'));
    expect(listRows(party)).toEqual(['1 lb ground beef', '8 tortillas', 'cilantro']);
    expect(listRows(groceries)).toEqual([]);
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/lists');
    expect(mockPush).not.toHaveBeenCalled();
    expect(resolveCurrentListId(listsWithCountsQuery().all(), USER)).toBe(party);
    expect(takeRecipeAddResult(party)).toMatchObject({ kind: 'toList', recipeId: tacos, recipeName: 'Tacos', count: 3 });
    expect(mockCategorize).toHaveBeenCalled();
  });

  test('opened from a list, it preselects that list and only goes back', () => {
    const party = createList('Party');
    mockParams.list = party;
    const root = render(<AddRecipeToListSheet />);
    expect(selectedPills(root)).toContain('Party');
    press(byLabel(root, 'Add 3 to Party'));
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test('archived lists are not offered', () => {
    const old = createList('Old');
    db.update(lists).set({ archivedAt: new Date() }).where(eq(lists.id, old)).run();
    const root = render(<AddRecipeToListSheet />);
    expect(root.root.findAll((n) => typeof n.type !== 'string' && n.props.label === 'Old')).toHaveLength(0);
  });

  test('from Adjust, the add replaces the earlier one', () => {
    const ingredients = recipeIngredientsQuery(tacos).all();
    const first = addRecipeToList(groceries, buildRecipeAdds(tacos, ingredients, new Set(ingredients.map((i) => i.id)), 1), USER);
    expect(listRows(groceries)).toEqual(['1 lb ground beef', '8 tortillas', 'cilantro']);
    mockParams.list = groceries;
    mockParams.adjust = startAdjust({ listId: groceries, recipeId: tacos, results: first.results });
    const root = render(<AddRecipeToListSheet />);
    press(byLabel(root, '2×'));
    press(root.root.find((n) => typeof n.type !== 'string' && /^Add 3 to /.test(n.props.label ?? '') && n.props.onPress));
    expect(listRows(groceries)).toEqual(['2 lb ground beef', '16 tortillas', 'cilantro']);
  });

  test('Cancel goes back without adding', () => {
    const root = render(<AddRecipeToListSheet />);
    const cancel = byType(root, 'ToolbarButton').find((n) => n.props.children === 'Cancel')!;
    act(() => cancel.props.onPress());
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(listRows(groceries)).toEqual([]);
  });
});
