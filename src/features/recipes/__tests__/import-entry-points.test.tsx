// Recipe import needs plus (spec 4.12): without `recipe_import`, the list menu's "Add recipe from
// link…" and both of the Recipes tab's "Import from link" buttons are hidden.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { ensureStarterData, getDefaultListId } from '@/features/lists/lists';
import { setFeatures, type Feature } from '@/features/plans/features';
import { resetDb } from '@/test/db';

import ListScreen from '@/app/list/[id]/index';
import RecipesScreen from '@/app/(tabs)/recipes/index';

import { createRecipe } from '../recipes';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
// Reanimated's own mock needs the native worklets module; the screens only need views and no-ops.
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  // Any chain of layout-animation builders (`FadeIn.duration(…)`) gives itself back.
  const builder: object = new Proxy({}, { get: () => () => builder });
  return {
    __esModule: true,
    default: { View, createAnimatedComponent: (c: unknown) => c },
    FadeIn: builder,
    FadeInDown: builder,
    FadeOut: builder,
    LinearTransition: builder,
    useReducedMotion: () => false,
    useAnimatedStyle: (fn: () => object) => fn(),
    useSharedValue: (value: unknown) => ({ value }),
    withSpring: (value: unknown) => value,
    withTiming: (value: unknown) => value,
  };
});
jest.mock('expo-network', () => ({ addNetworkStateListener: () => ({ remove: () => {} }) }));
// The screens' live queries, read once from the test database.
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
// Native views the menus don't depend on.
jest.mock('@/features/lists/view-menu-button', () => ({ ViewMenuButton: () => null }));
jest.mock('@/features/lists/add-bar', () => ({ ItemAddBar: () => null }));
jest.mock('@/features/lists/item-row', () => ({ ItemRow: () => null }));

const mockParams: { id?: string } = {};
const mockPush = jest.fn();
// Toolbar items render as host elements so the test can find them by type.
jest.mock('expo-router', () => {
  const { createElement, Fragment } = require('react');
  // A new component each call: `Object.assign` below gives each its own statics.
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
    Label: host('ToolbarLabel'),
    Menu: host('ToolbarMenu'),
    MenuAction: host('ToolbarMenuAction'),
  });
  const Link = Object.assign(passThrough(), { Trigger: passThrough(), Menu: () => null, MenuAction: () => null });
  return {
    Link,
    Stack: { Screen: () => null, Title: passThrough(), Toolbar },
    router: { push: (...args: unknown[]) => mockPush(...args), back: () => {} },
    useFocusEffect: () => {},
    useLocalSearchParams: () => mockParams,
    usePathname: () => `/list/${mockParams.id}`,
  };
});
jest.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 0 }));

const USER = 'user-1';
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));

const PLUS: Feature[] = ['categorize', 'recipe_import', 'recipe_import_photo'];
const STANDARD: Feature[] = ['categorize'];

let tree: ReactTestRenderer | null = null;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  mockParams.id = getDefaultListId(USER)!;
  mockPush.mockClear();
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  setFeatures(STANDARD);
});

function render(screen: () => React.ReactElement, features: Feature[]): ReactTestRenderer {
  setFeatures(features);
  act(() => {
    tree = create(screen());
  });
  return tree!;
}

const byType = (root: ReactTestRenderer, type: string) => root.root.findAll((n) => n.type === type);
const label = (n: ReactTestInstance) => n.props.accessibilityLabel ?? n.props.label;
const press = (n: ReactTestInstance) => act(() => n.props.onPress());

describe('the list menu', () => {
  const menuTitles = (root: ReactTestRenderer) =>
    byType(root, 'ToolbarMenuAction').map((n) => n.props.children as string);

  test('plus offers "Add recipe from link…", which opens the sheet for this list', () => {
    const root = render(() => <ListScreen />, PLUS);
    expect(menuTitles(root)).toContain('Add recipe from link…');
    const action = byType(root, 'ToolbarMenuAction').find((n) => n.props.children === 'Add recipe from link…')!;
    press(action);
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/import-recipe', params: { list: mockParams.id } });
  });

  test('without recipe_import it is hidden and the rest of the menu stays', () => {
    const root = render(() => <ListScreen />, STANDARD);
    expect(menuTitles(root)).not.toContain('Add recipe from link…');
    expect(menuTitles(root)).toEqual(expect.arrayContaining(['Select items', 'Share as text', 'Uncheck all']));
  });

  test('losing recipe_import while the list shows hides it', () => {
    const root = render(() => <ListScreen />, PLUS);
    expect(menuTitles(root)).toContain('Add recipe from link…');
    act(() => setFeatures(STANDARD));
    expect(menuTitles(root)).not.toContain('Add recipe from link…');
  });
});

describe('the Recipes tab', () => {
  const importButtons = (root: ReactTestRenderer) =>
    [...byType(root, 'ToolbarButton'), ...root.root.findAll((n) => typeof n.type !== 'string' && !!n.props.label)]
      .filter((n) => label(n) === 'Import from link');
  const toolbarLabels = (root: ReactTestRenderer) => byType(root, 'ToolbarButton').map(label);

  test('plus with no recipes shows both: the empty-state button and the toolbar button', () => {
    const root = render(() => <RecipesScreen />, PLUS);
    expect(toolbarLabels(root)).toEqual(['Import from link', 'New recipe']);
    const buttons = importButtons(root);
    expect(buttons).toHaveLength(2);
    for (const button of buttons) press(button);
    expect(mockPush.mock.calls).toEqual([['/import-recipe'], ['/import-recipe']]);
  });

  test('without recipe_import neither shows, and New recipe stays', () => {
    const root = render(() => <RecipesScreen />, STANDARD);
    expect(importButtons(root)).toEqual([]);
    expect(toolbarLabels(root)).toEqual(['New recipe']);
    expect(root.root.findAll((n) => typeof n.type !== 'string' && n.props.label === 'New recipe')).not.toHaveLength(0);
  });

  test('the base plan hides them too', () => {
    const root = render(() => <RecipesScreen />, []);
    expect(importButtons(root)).toEqual([]);
  });

  test('with recipes, plus keeps the toolbar button; without it, it is gone', () => {
    createRecipe('Tacos');
    let root = render(() => <RecipesScreen />, PLUS);
    expect(toolbarLabels(root)).toEqual(['Import from link', 'New recipe']);
    act(() => tree?.unmount());
    root = render(() => <RecipesScreen />, STANDARD);
    expect(toolbarLabels(root)).toEqual(['New recipe']);
  });

  test('gaining recipe_import shows them without leaving the tab', () => {
    const root = render(() => <RecipesScreen />, STANDARD);
    act(() => setFeatures(PLUS));
    expect(importButtons(root)).toHaveLength(2);
  });
});
