// Edit list (spec 4.1): name, colour and Siri default, saved on Done and dropped on Cancel, and
// Delete list, which asks first.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Alert } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import EditListSheet from '@/app/list/[id]/edit';
import { initI18n } from '@/i18n';
import { resetDb } from '@/test/db';

import { createList, ensureStarterData, getDefaultListId, getList } from '../lists';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('@/components/icon-tile', () => ({ IconTile: () => null }));

const mockParams: { id?: string } = {};
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
let tree: ReactTestRenderer | null = null;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  listId = getDefaultListId(USER)!;
  mockBack.mockClear();
});

afterEach(() => {
  const shown = tree;
  tree = null;
  act(() => shown?.unmount());
  jest.restoreAllMocks();
});

function open(id = listId) {
  mockParams.id = id;
  act(() => {
    tree = create(<EditListSheet />);
  });
}

const toolbar = (label: string) =>
  tree!.root.find((n) => n.type === ('ToolbarButton' as never) && n.props.children === label);
const byLabel = (label: string) =>
  tree!.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && ('onPress' in n.props || 'onChangeText' in n.props || 'onValueChange' in n.props));
const swatches = () =>
  tree!.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'radio' && 'onPress' in n.props);
const textOf = (n: ReactTestInstance): string =>
  n.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
const lines = () => tree!.root.findAll((n) => n.type === ('Text' as never)).map(textOf);

describe('Edit list', () => {
  test('shows the name, the colours with Default chosen, the Siri switch and Delete list', () => {
    open();
    expect(byLabel('Name').props.value).toBe('Groceries');
    expect(swatches().map((s) => [s.props.accessibilityLabel, s.props.accessibilityState.selected])).toEqual([
      ['Default', true],
      ['Green', false],
      ['Blue', false],
      ['Rose', false],
      ['Amber', false],
      ['Grey', false],
    ]);
    expect(lines()).toEqual(expect.arrayContaining(['Name', 'Colour', 'Default list for Siri', 'Delete list']));
    // The default list: its switch is on, and is moved by turning it on for another list.
    expect(byLabel('Default list for Siri').props.value).toBe(true);
    expect(byLabel('Default list for Siri').props.disabled).toBe(true);
  });

  test('Done saves the name, colour and Siri default', () => {
    const other = createList('Groceries 2');
    open(other);
    expect(byLabel('Default list for Siri').props.value).toBe(false);
    act(() => byLabel('Name').props.onChangeText('Costco'));
    act(() => swatches()[2].props.onPress());
    act(() => byLabel('Default list for Siri').props.onValueChange(true));
    expect(getList(other)!.name).toBe('Groceries 2');
    act(() => toolbar('Done').props.onPress());
    expect(getList(other)).toMatchObject({ name: 'Costco', color: 'blue' });
    expect(getDefaultListId(USER)).toBe(other);
    expect(mockBack).toHaveBeenCalled();
  });

  test('Cancel drops the changes', () => {
    open();
    act(() => byLabel('Name').props.onChangeText('Costco'));
    act(() => swatches()[3].props.onPress());
    act(() => toolbar('Cancel').props.onPress());
    expect(getList(listId)).toMatchObject({ name: 'Groceries', color: null });
    expect(mockBack).toHaveBeenCalled();
  });

  test('Done is off with an empty name', () => {
    open();
    act(() => byLabel('Name').props.onChangeText('  '));
    expect(toolbar('Done').props.disabled).toBe(true);
  });

  test('Delete list asks first, then deletes and closes', () => {
    let buttons: { text: string; onPress?: () => void }[] = [];
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, b) => {
      buttons = b as typeof buttons;
    });
    open();
    act(() => tree!.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityHint === 'Asks first').props.onPress());
    expect(alert.mock.calls[0][0]).toBe('Delete “Groceries”?');
    expect(getList(listId)).toBeDefined();
    act(() => buttons.find((b) => b.text === 'Delete')!.onPress!());
    expect(getList(listId)).toBeUndefined();
    expect(mockBack).toHaveBeenCalled();
  });
});

describe('Edit list in Spanish', () => {
  afterEach(() => {
    act(() => tree?.unmount());
    tree = null;
    initI18n('en');
  });

  test('shows its labels, colours and hints in Spanish', () => {
    initI18n('es');
    open();
    expect(byLabel('Nombre').props.value).toBe('Groceries');
    expect(swatches().map((s) => s.props.accessibilityLabel)).toEqual(['Predeterminado', 'Verde', 'Azul', 'Rosa', 'Ámbar', 'Gris']);
    expect(lines()).toEqual(expect.arrayContaining(['Nombre', 'Color', 'Lista predeterminada para Siri', 'Eliminar lista']));
    expect(byLabel('Lista predeterminada para Siri').props.accessibilityHint).toBe('Para cambiarla, actívala en otra lista');
    expect(toolbar('Cancelar')).toBeDefined();
    expect(toolbar('Listo')).toBeDefined();
  });

  test('a list that isn’t Siri’s says what turning it on does', () => {
    initI18n('es');
    open(createList('Costco'));
    expect(byLabel('Lista predeterminada para Siri').props.accessibilityHint).toBe(
      'Siri agrega a esta lista si no mencionas otra',
    );
  });

  test('Delete list asks first, in Spanish', () => {
    let buttons: { text: string; onPress?: () => void }[] = [];
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, b) => {
      buttons = b as typeof buttons;
    });
    initI18n('es');
    open();
    act(() =>
      tree!.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityHint === 'Pregunta antes').props.onPress(),
    );
    expect(alert.mock.calls[0].slice(0, 2)).toEqual(['¿Eliminar “Groceries”?', 'También se eliminan sus artículos.']);
    expect(buttons.map((b) => b.text)).toEqual(['Cancelar', 'Eliminar']);
    act(() => buttons[1].onPress!());
    expect(getList(listId)).toBeUndefined();
  });
});
