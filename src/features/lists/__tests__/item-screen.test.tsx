// The item sheet (spec 4.2, 4.3.2, 4.4, board 04), against the real in-memory database: name, its check
// (Got it), amount stepper and unit, note, the amounts added, aisle, Move, Delete.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { ActionSheetIOS, Alert, Switch } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import ItemEditSheet from '@/app/list/[id]/item/[itemId]';
import { categories, db, householdCategoryOverrides, households, ingredients, listItems } from '@/db';
import { isStaple, setStaple } from '@/features/households/staples';
import { setFeatures } from '@/features/plans/features';
import { initI18n } from '@/i18n';
import { addRecipeIngredient, createRecipe } from '@/features/recipes/recipes';
import { addWholeRecipeToList } from '@/features/recipes/add-to-list';
import { SYSTEM_CATEGORIES } from '@/shared';
import { resetDb } from '@/test/db';

import { resolveCurrentListId } from '../current-list';
import { addItem, getItemEdit, listItemsQuery, setItemChecked } from '../items';
import { createList, ensureStarterData, getDefaultListId, getList, listsWithCountsQuery } from '../lists';
import { takeMoveResult } from '../move-result';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('@/components/icon-tile', () => ({ IconTile: () => null }));
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
jest.mock('@/features/categories/categorization', () => ({
  ...jest.requireActual<object>('@/features/categories/categorization'),
  categorizePending: jest.fn(() => Promise.resolve()),
}));
// SwiftUI views as host elements; modifiers as plain records.
jest.mock('@expo/ui/swift-ui', () => {
  const { createElement } = require('react');
  const host = (type: string) =>
    function Host({ children, ...props }: { children?: unknown }) {
      return createElement(type, props, children);
    };
  return {
    Host: host('SwiftHost'),
    Menu: ({ label, children, ...props }: { label?: unknown; children?: unknown }) =>
      createElement('SwiftMenu', props, label, children),
    RNHostView: host('RNHostView'),
    Section: host('SwiftSection'),
    Text: host('SwiftText'),
    Toggle: host('SwiftToggle'),
  };
});
jest.mock('@expo/ui/swift-ui/modifiers', () => ({
  accessibilityLabel: (value: string) => ({ accessibilityLabel: value }),
  accessibilityHint: (value: string) => ({ accessibilityHint: value }),
}));

const mockParams: { id?: string; itemId?: string } = {};
const mockPush = jest.fn();
const mockNavigate = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => {
  const { createElement, Fragment } = require('react');
  const host = (type: string) =>
    function Host({ children, ...props }: { children?: unknown }) {
      return createElement(type, props, children);
    };
  const Toolbar = Object.assign(
    function PassThrough({ children }: { children?: unknown }) {
      return createElement(Fragment, null, children);
    },
    { Button: host('ToolbarButton') },
  );
  return {
    Stack: { Toolbar },
    router: {
      push: (...args: unknown[]) => mockPush(...args),
      navigate: (...args: unknown[]) => mockNavigate(...args),
      back: () => mockBack(),
    },
    useLocalSearchParams: () => mockParams,
  };
});

const USER = 'user-1';
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));

const cat = (slug: string) => SYSTEM_CATEGORIES.find((c) => c.slug === slug)!.id;

let listId: string;
let tree: ReactTestRenderer | null = null;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  SYSTEM_CATEGORIES.forEach((c, rank) =>
    db.insert(categories).values({ id: c.id, slug: c.slug, name: c.name, householdId: null, defaultRank: rank }).run(),
  );
  db.insert(ingredients)
    .values({ normalizedName: 'milk', displayName: 'milk', defaultCategoryId: cat('dairy-eggs'), status: 'categorized' })
    .run();
  setFeatures(['categorize']);
  listId = getDefaultListId(USER)!;
  mockPush.mockClear();
  mockNavigate.mockClear();
  mockBack.mockClear();
});

afterEach(() => {
  const shown = tree;
  tree = null;
  act(() => shown?.unmount());
  jest.restoreAllMocks();
});

function open(itemId: string): ReactTestRenderer {
  mockParams.id = listId;
  mockParams.itemId = itemId;
  act(() => {
    tree = create(<ItemEditSheet />);
  });
  return tree!;
}
/** Re-reads the live queries, as a write would trigger. */
const refresh = () => act(() => tree!.update(<ItemEditSheet />));

const textOf = (n: ReactTestInstance): string =>
  n.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
const lines = () => tree!.root.findAll((n) => n.type === ('Text' as never)).map(textOf);
const text = () => lines().join('\n');
const inputs = (label: string) =>
  tree!.root.findAll((n) => n.type === ('TextInput' as never) && n.props.accessibilityLabel === label);
const input = (label: string) => inputs(label)[0];
const pressables = (label: string) =>
  tree!.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && 'onPress' in n.props);
const press = (label: string) => {
  const found = pressables(label);
  expect(found.length).toBeGreaterThan(0);
  act(() => {
    found[0].props.onPress();
  });
};
/** The title's check, as VoiceOver sees it. */
const gotIt = () => pressables('Got it').find((n) => n.props.accessibilityRole === 'checkbox')!;
const toolbar = (title: string) =>
  tree!.root.find((n) => n.type === ('ToolbarButton' as never) && n.props.children === title);
const tapToolbar = (title: string) =>
  act(() => {
    toolbar(title).props.onPress();
  });
const typeIn = (label: string, value: string) => act(() => input(label).props.onChangeText(value));
const item = (id: string) => db.select().from(listItems).all().find((i) => i.id === id)!;

describe('the item sheet', () => {
  test('a missing item renders an empty sheet', () => {
    open('gone');
    expect(inputs('Name')).toHaveLength(0);
  });

  test('shows the name capitalized, the amount and an unticked check', () => {
    const { itemId } = addItem(listId, '2 milk', USER)!;
    open(itemId);
    expect(input('Name').props.value).toBe('Milk');
    expect(lines()).toContain('2');
    expect(gotIt().props.accessibilityState).toEqual({ checked: false });
  });

  test('the name shows as typed while it is being edited', () => {
    const { itemId } = addItem(listId, 'milk', USER)!;
    open(itemId);
    act(() => input('Name').props.onFocus());
    expect(input('Name').props.value).toBe('milk');
    typeIn('Name', 'oat milk');
    act(() => input('Name').props.onBlur());
    expect(input('Name').props.value).toBe('Oat milk');
  });

  test('the check ticks the item off right away, and the sheet stays', () => {
    const { itemId } = addItem(listId, 'milk', USER)!;
    open(itemId);
    press('Got it');
    expect(item(itemId).checkedAt).not.toBeNull();
    expect(mockBack).not.toHaveBeenCalled();
    refresh();
    expect(text()).toMatch(/Checked .* by you/);
    expect(gotIt().props.accessibilityState).toEqual({ checked: true });
  });

  test('ticking keeps unsaved edits for Save, and Cancel still drops them', () => {
    const { itemId } = addItem(listId, 'milk', USER)!;
    open(itemId);
    typeIn('Note', 'the big one');
    press('Got it');
    expect(item(itemId).note).toBeNull();
    tapToolbar('Cancel');
    expect(item(itemId)).toMatchObject({ note: null });
    expect(item(itemId).checkedAt).not.toBeNull();
  });

  test('a checked item says when, and unticking puts it back without closing', () => {
    const { itemId } = addItem(listId, 'milk', USER)!;
    setItemChecked(itemId, true, USER);
    open(itemId);
    expect(text()).toMatch(/Checked .* by you/);
    press('Got it');
    expect(item(itemId).checkedAt).toBeNull();
    expect(mockBack).not.toHaveBeenCalled();
    refresh();
    expect(gotIt().props.accessibilityState).toEqual({ checked: false });
  });

  test('Save writes the name and note and closes; Cancel leaves them', () => {
    const { itemId } = addItem(listId, 'milk', USER)!;
    open(itemId);
    typeIn('Name', 'oat milk');
    typeIn('Note', 'the big one');
    tapToolbar('Cancel');
    expect(item(itemId).displayName).toBe('milk');
    expect(mockBack).toHaveBeenCalledTimes(1);
    tapToolbar('Save');
    expect(item(itemId)).toMatchObject({ displayName: 'oat milk', note: 'the big one' });
    expect(mockBack).toHaveBeenCalledTimes(2);
  });

  test('a rename onto another open item is refused with a message, and the sheet stays', () => {
    addItem(listId, 'eggs', USER);
    const { itemId } = addItem(listId, 'milk', USER)!;
    open(itemId);
    typeIn('Name', 'eggs');
    tapToolbar('Save');
    expect(mockBack).not.toHaveBeenCalled();
    expect(tree!.root.findAll((n) => n.type === ('Text' as never) && n.props.accessibilityRole === 'alert')).toHaveLength(1);
    expect(item(itemId).displayName).toBe('milk');
  });

  test('Delete item deletes it and closes', () => {
    const { itemId } = addItem(listId, 'milk', USER)!;
    open(itemId);
    press('Delete item');
    expect(item(itemId).deletedAt).not.toBeNull();
    expect(mockBack).toHaveBeenCalled();
  });
});

describe('the amount', () => {
  test('+ and − step the amount and save it right away', () => {
    const { itemId } = addItem(listId, '2 milk', USER)!;
    open(itemId);
    expect(input('Amount, in Count').props.value).toBe('2');
    press('Increase amount');
    refresh();
    expect(getItemEdit(itemId)!.amount).toBe('3');
    expect(input('Amount, in Count').props.value).toBe('3');
    press('Decrease amount');
    refresh();
    expect(getItemEdit(itemId)!.amount).toBe('2');
  });

  test('− is disabled at one', () => {
    const { itemId } = addItem(listId, '1 milk', USER)!;
    open(itemId);
    expect(pressables('Decrease amount')[0].props.disabled).toBe(true);
  });

  test('a typed number saves on blur; text that is not a number shows an error', () => {
    const { itemId } = addItem(listId, '2 milk', USER)!;
    open(itemId);
    typeIn('Amount, in Count', '5');
    act(() => input('Amount, in Count').props.onBlur());
    expect(getItemEdit(itemId)!.amount).toBe('5');
    typeIn('Amount, in Count', 'lots');
    act(() => input('Amount, in Count').props.onBlur());
    expect(text()).toContain('"lots" isn\'t a number, like 2 or 1.5');
    expect(getItemEdit(itemId)!.amount).toBe('5');
  });

  test('the unit menu ticks the unit and picking one keeps the number', () => {
    const { itemId } = addItem(listId, '2 lb milk', USER)!;
    open(itemId);
    const toggles = () => tree!.root.findAll((n) => n.type === ('SwiftToggle' as never));
    // The usual unit (lb, from this add) leads in its own section, its title a Text with "Usual" under it.
    const titleOf = (t: ReactTestInstance) => t.props.label ?? textOf(t.findAllByType('SwiftText' as never)[0]);
    const lb = toggles().filter((t) => titleOf(t) === 'lb');
    expect(lb).toHaveLength(1);
    expect(lb[0].props.isOn).toBe(true);
    expect(textOf(lb[0])).toBe('lbUsual');
    const kg = toggles().find((t) => titleOf(t) === 'kg')!;
    act(() => kg.props.onIsOnChange(true));
    expect(getItemEdit(itemId)!.amount).toBe('2 kg');
  });

  test('a total of mixed units is edited as text, with the stepper off', () => {
    const { itemId } = addItem(listId, '2 cans milk', USER)!;
    addItem(listId, '400 g milk', USER);
    open(itemId);
    expect(pressables('Increase amount')[0].props.disabled).toBe(true);
    expect(pressables('Unit')[0].props.disabled).toBe(true);
    typeIn('Amount', '1 gal');
    tapToolbar('Save');
    expect(getItemEdit(itemId)!.amount).toBe('1 gal');
  });

  test('an unreadable amount is not saved', () => {
    const { itemId } = addItem(listId, '2 cans milk', USER)!;
    addItem(listId, '400 g milk', USER);
    open(itemId);
    typeIn('Amount', 'some');
    tapToolbar('Save');
    expect(mockBack).not.toHaveBeenCalled();
    expect(text()).toContain('isn\'t an amount');
  });
});

describe('the amounts added', () => {
  test('several amounts are listed, each removable', () => {
    const { itemId } = addItem(listId, '2 milk', USER)!;
    addItem(listId, '1 milk', USER);
    open(itemId);
    expect(lines()).toContain('Added');
    press('Remove 1');
    refresh();
    expect(getItemEdit(itemId)!.amount).toBe('2');
    expect(lines()).not.toContain('Added');
  });

  test('an amount from a recipe opens the recipe', () => {
    const recipeId = createRecipe('Pancakes', getList(listId)!.householdId);
    addRecipeIngredient(recipeId, '1 cup milk');
    addWholeRecipeToList(listId, recipeId, USER);
    const itemId = listItemsQuery(listId).all()[0].id;
    open(itemId);
    const recipeRow = tree!.root.find(
      (n) => typeof n.type !== 'string' && n.props.accessibilityHint === 'Opens Pancakes' && 'onPress' in n.props,
    );
    act(() => {
      recipeRow.props.onPress();
    });
    expect(mockBack).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]', params: { id: recipeId } });
  });
});

describe('the aisle', () => {
  const pill = (label: string) => pressables(label)[0];

  test('the current aisle is selected; choosing another is saved for the household, with Reset', () => {
    const { itemId } = addItem(listId, 'milk', USER)!;
    open(itemId);
    expect(pill('Dairy & Eggs').props.accessibilityState).toMatchObject({ selected: true });
    // The aisle's own footnote line (Always have's footnote says it too, after its own sentence).
    expect(lines()).not.toContain('Changes it for everyone in Personal.');
    press('Show all');
    press('Frozen');
    expect(pill('Frozen').props.accessibilityState).toMatchObject({ selected: true });
    expect(lines()).toContain('Changes it for everyone in Personal.');
    tapToolbar('Save');
    expect(db.select().from(householdCategoryOverrides).all()).toEqual([
      expect.objectContaining({ ingredientName: 'milk', categoryId: cat('frozen') }),
    ]);
  });

  test('Reset to default clears an override', () => {
    const { itemId } = addItem(listId, 'milk', USER)!;
    open(itemId);
    press('Show all');
    press('Frozen');
    tapToolbar('Save');
    act(() => tree!.unmount());
    open(itemId);
    expect(pill('Frozen').props.accessibilityState).toMatchObject({ selected: true });
    press('Reset to default');
    expect(pill('Dairy & Eggs').props.accessibilityState).toMatchObject({ selected: true });
    tapToolbar('Save');
    // Cleared (kept as a null for sync).
    expect(db.select().from(householdCategoryOverrides).all().filter((o) => o.categoryId !== null)).toEqual([]);
  });

  test('a new ingredient waits in Sorting…', () => {
    const { itemId } = addItem(listId, 'kombucha', USER)!;
    open(itemId);
    expect(pill('Sorting...').props.accessibilityState).toMatchObject({ selected: true });
  });

  test('without categorize a new ingredient is in Other', () => {
    setFeatures([]);
    const { itemId } = addItem(listId, 'kombucha', USER)!;
    open(itemId);
    expect(pressables('Sorting...')).toHaveLength(0);
    press('Show all');
    expect(pill('Other').props.accessibilityState).toMatchObject({ selected: true });
  });

  test('+ New makes an aisle and picks it', () => {
    jest.spyOn(Alert, 'prompt').mockImplementation((_title, _message, callback) => {
      (callback as (name: string) => void)('Asian market');
    });
    const { itemId } = addItem(listId, 'milk', USER)!;
    open(itemId);
    press('Show all');
    press('New aisle');
    expect(pill('Asian market').props.accessibilityState).toMatchObject({ selected: true });
  });
});

describe('Always have', () => {
  const toggle = () => tree!.root.find((n) => n.type === Switch && n.props.accessibilityLabel === 'Always have');
  const householdId = () => getList(listId)!.householdId;

  test('a switch below the aisle with its hint and the household in the footnote', () => {
    const { itemId } = addItem(listId, 'salt', USER)!;
    open(itemId);
    expect(toggle().props.value).toBe(false);
    expect(toggle().props.accessibilityHint).toBe('Left off when you add a recipe');
    expect(text()).toContain('Left off when you add a recipe. Changes it for everyone in Personal.');
    // Below the aisle pills.
    const all = lines();
    expect(all.indexOf('Always have')).toBeGreaterThan(all.indexOf('Aisle'));
  });

  test('without a household name the footnote says "your household"', () => {
    db.update(households).set({ name: '' }).where(eq(households.id, householdId())).run();
    const { itemId } = addItem(listId, 'salt', USER)!;
    open(itemId);
    expect(text()).toContain('Left off when you add a recipe. Changes it for everyone in your household.');
  });

  test('switching it on marks the ingredient at once, without Save; off unmarks it', () => {
    const { itemId } = addItem(listId, '2 Salt', USER)!;
    open(itemId);
    act(() => toggle().props.onValueChange(true));
    expect(toggle().props.value).toBe(true);
    // Saved for the household by the ingredient's key, with nothing else saved and the sheet still open.
    expect(isStaple(householdId(), 'salt')).toBe(true);
    expect(mockBack).not.toHaveBeenCalled();
    act(() => toggle().props.onValueChange(false));
    expect(toggle().props.value).toBe(false);
    expect(isStaple(householdId(), 'salt')).toBe(false);
  });

  test('an ingredient already marked shows on; Cancel keeps the change', () => {
    setStaple(householdId(), 'salt', true, USER);
    const { itemId } = addItem(listId, 'salt', USER)!;
    open(itemId);
    expect(toggle().props.value).toBe(true);
    act(() => toggle().props.onValueChange(false));
    tapToolbar('Cancel');
    expect(isStaple(householdId(), 'salt')).toBe(false);
  });
});

describe('Move to another list', () => {
  test('is hidden when the household has one list', () => {
    const { itemId } = addItem(listId, 'milk', USER)!;
    open(itemId);
    expect(pressables('Move to another list')).toHaveLength(0);
  });

  test('moves the item and makes the other list current on the List tab, which then shows the toast', () => {
    const costco = createList('Costco');
    const { itemId } = addItem(listId, 'milk', USER)!;
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((options, callback) => {
      expect(options.options).toEqual(['Costco', 'Cancel']);
      callback(0);
    });
    open(itemId);
    press('Move to another list');
    expect(item(itemId).listId).toBe(costco);
    expect(mockBack).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/lists');
    // The sheet closes first, then the tab moves to the other list.
    expect(mockBack.mock.invocationCallOrder[0]).toBeLessThan(mockNavigate.mock.invocationCallOrder[0]);
    expect(mockPush).not.toHaveBeenCalled();
    expect(resolveCurrentListId(listsWithCountsQuery().all(), USER)).toBe(costco);
    expect(takeMoveResult(costco)).toMatchObject({ itemId, fromListName: 'Groceries' });
  });

  test('Cancel moves nothing', () => {
    createList('Costco');
    const { itemId } = addItem(listId, 'milk', USER)!;
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => callback(1));
    open(itemId);
    press('Move to another list');
    expect(item(itemId).listId).toBe(listId);
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

// Spec 4.15: the sheet's strings come from src/i18n/. The English above is unchanged.
describe('in Spanish', () => {
  beforeEach(() => initI18n('es'));
  afterEach(() => {
    act(() => tree?.unmount());
    tree = null;
    initI18n('en');
  });

  test('the toolbar, fields, labels and buttons', () => {
    const { itemId } = addItem(listId, '2 milk', USER)!;
    open(itemId);
    expect(toolbar('Cancelar')).toBeDefined();
    expect(toolbar('Guardar')).toBeDefined();
    expect(input('Nombre').props.accessibilityHint).toBe('Cambia el nombre del artículo en esta lista');
    expect(input('Cantidad, en Piezas').props.placeholder).toBe('Ninguna');
    expect(input('Cantidad, en Piezas').props.accessibilityHint).toBe(
      'Se guarda cuando terminas de escribir. Vacío borra la cantidad.',
    );
    expect(input('Nota').props.placeholder).toBe('p. ej. la bolsa grande');
    expect(lines()).toEqual(expect.arrayContaining(['Cantidad', 'Nota', 'Pasillo', 'Siempre tengo', 'Eliminar artículo']));
    expect(pressables('Ya lo tengo')).not.toHaveLength(0);
    expect(pressables('Aumentar cantidad')).not.toHaveLength(0);
    expect(pressables('Disminuir cantidad')).not.toHaveLength(0);
    expect(text()).not.toMatch(/Amount|Note|Aisle|Always have|Delete item/);
  });

  test('the unit menu and its groups', () => {
    const { itemId } = addItem(listId, '2 lb milk', USER)!;
    open(itemId);
    const menu = tree!.root.find((n) => n.type === ('SwiftMenu' as never));
    expect(menu.props.modifiers).toEqual([{ accessibilityLabel: 'Unidad, lb' }, { accessibilityHint: 'Muestra las unidades' }]);
    const titles = tree!.root.findAll((n) => n.type === ('SwiftSection' as never)).map((s) => s.props.title);
    expect(titles).toEqual([undefined, 'Piezas', 'Peso', 'Volumen', 'Paquetes']);
    const lb = tree!.root.findAll((n) => n.type === ('SwiftToggle' as never) && n.props.label === undefined)[0];
    expect(textOf(lb)).toBe('lbLa de siempre');
  });

  test('mixed units: the disabled controls say to edit the amount as text', () => {
    const { itemId } = addItem(listId, '2 cans milk', USER)!;
    addItem(listId, '400 g milk', USER);
    open(itemId);
    expect(pressables('Unidad')[0].props.accessibilityHint).toBe('Edita la cantidad como texto');
    expect(pressables('Aumentar cantidad')[0].props.accessibilityHint).toBe('Edita la cantidad como texto');
    expect(input('Cantidad').props.placeholder).toBe('p. ej. 2 lb');
  });

  test('a typed word that is not a number', () => {
    const { itemId } = addItem(listId, '2 milk', USER)!;
    open(itemId);
    typeIn('Cantidad, en Piezas', 'mucho');
    act(() => input('Cantidad, en Piezas').props.onBlur());
    expect(text()).toContain('“mucho” no es un número, como 2 o 1.5');
  });

  test('the amounts added say who and when, and each can be removed', () => {
    const { itemId } = addItem(listId, '2 milk', USER)!;
    addItem(listId, '1 milk', USER);
    open(itemId);
    expect(lines()).toEqual(expect.arrayContaining(['Agregado', 'Tú, justo ahora']));
    const remove = pressables('Quitar 1')[0];
    expect(remove.props.accessibilityHint).toBe('Quita esta cantidad');
    act(() => remove.props.onPress());
    expect(getItemEdit(itemId)!.amount).toBe('2');
  });

  test('a recipe’s amount names the recipe and opens it', () => {
    const recipeId = createRecipe('Hotcakes', getList(listId)!.householdId);
    addRecipeIngredient(recipeId, '1 cup milk');
    addWholeRecipeToList(listId, recipeId, USER);
    open(listItemsQuery(listId).all()[0].id);
    const row = pressables('1 cup, Hotcakes, justo ahora')[0];
    expect(row.props.accessibilityHint).toBe('Abre Hotcakes');
  });

  test('checking says when and by whom', () => {
    const { itemId } = addItem(listId, 'milk', USER)!;
    open(itemId);
    press('Ya lo tengo');
    refresh();
    expect(lines()).toContain('Marcado justo ahora por ti');
  });

  test('the aisle pills: Show all, New aisle, the shared footnote and Reset', () => {
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const { itemId } = addItem(listId, 'milk', USER)!;
    open(itemId);
    const showAll = pressables('Ver todos')[0];
    expect(showAll.props.accessibilityHint).toBe(`Muestra ${SYSTEM_CATEGORIES.length - 6} pasillos más`);
    press('Ver todos');
    press('Frozen');
    expect(lines()).toContain('Lo cambia para todos en Personal.');
    expect(pressables('Restablecer')[0].props.accessibilityHint).toBe('Usa el pasillo de siempre para todos');
    press('Nuevo pasillo');
    expect(prompt.mock.calls[0][0]).toBe('Nuevo pasillo');
    expect(lines()).toContain('+ Nuevo');
  });

  test('Always have: its switch and footnote', () => {
    const { itemId } = addItem(listId, 'salt', USER)!;
    open(itemId);
    const toggle = tree!.root.find((n) => n.type === Switch);
    expect(toggle.props.accessibilityLabel).toBe('Siempre tengo');
    expect(toggle.props.accessibilityHint).toBe('Se omite cuando agregas una receta');
    expect(text()).toContain('Se omite cuando agregas una receta. Lo cambia para todos en Personal.');
  });

  test('Move to another list', () => {
    createList('Costco');
    const { itemId } = addItem(listId, 'milk', USER)!;
    const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    open(itemId);
    expect(lines()).toContain('Mover a otra lista…');
    expect(pressables('Mover a otra lista')[0].props.accessibilityHint).toBe('Muestra las otras listas');
    press('Mover a otra lista');
    expect(sheet.mock.calls[0][0]).toMatchObject({ title: 'Mover a', options: ['Costco', 'Cancelar'], cancelButtonIndex: 1 });
  });
});
