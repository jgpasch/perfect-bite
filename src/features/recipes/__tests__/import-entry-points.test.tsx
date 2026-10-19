// Recipe import needs plus (spec 4.12): without `recipe_import`, the Recipes tab's empty-state "Import
// from link" is hidden; the header's round + opens the Add recipe sheet either way. The list menu no
// longer offers import at all; the Recipes tab is the way in.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { ensureStarterData, getDefaultListId } from '@/features/lists/lists';
import { setFeatures, type Feature } from '@/features/plans/features';
import { pressAddButton, takePendingListAdd } from '@/features/tabs/add-button';
import { resetDb } from '@/test/db';

import { ListScreen } from '@/features/lists/list-screen';
import RecipesScreen from '@/app/(tabs)/recipes/index';

import { createRecipe } from '../recipes';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('react-native-worklets', () => ({ scheduleOnRN: (fn: (...a: unknown[]) => void, ...args: unknown[]) => fn(...args) }));
// The card's swipe as a host element: these tests don't swipe.
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const { createElement } = require('react');
  return { __esModule: true, default: ({ children }: { children?: unknown }) => createElement('Swipeable', null, children) };
});
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
    useAnimatedRef: () => require('react').useRef(null),
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
jest.mock('@/features/lists/add-bar', () => ({ ItemAddBar: () => null }));
jest.mock('@/features/lists/item-row', () => ({ ItemRow: () => null }));
jest.mock('@/features/lists/reorderable-rows', () => ({ ReorderableRows: () => null }));

let listId: string;
const mockPush = jest.fn();
const mockNavigate = jest.fn();
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
    View: passThrough(),
    MenuAction: host('ToolbarMenuAction'),
  });
  const Link = Object.assign(passThrough(), { Trigger: passThrough(), Menu: () => null, MenuAction: () => null });
  return {
    Link,
    Stack: { Screen: () => null, Title: passThrough(), Toolbar, SearchBar: () => null },
    router: { push: (...args: unknown[]) => mockPush(...args), navigate: (...args: unknown[]) => mockNavigate(...args), back: () => {} },
    // The screen is focused while it's mounted.
    useFocusEffect: (effect: () => void | (() => void)) => require('react').useEffect(effect, [effect]),
    usePathname: () => '/lists',
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
  listId = getDefaultListId(USER)!;
  mockPush.mockClear();
  mockNavigate.mockClear();
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
    byType(root, 'ToolbarMenu')
      .find((n) => n.props.icon === 'ellipsis')!
      .findAll((n) => n.type === ('ToolbarMenuAction' as never))
      .map((n) => n.props.children as string);

  test('has no "Add recipe from link…", with or without plus', () => {
    for (const features of [PLUS, STANDARD]) {
      const root = render(() => <ListScreen id={listId} />, features);
      expect(menuTitles(root)).not.toContain('Add recipe from link…');
      expect(menuTitles(root)).toEqual(['Select items', 'Share list', 'Edit list…']);
      act(() => root.unmount());
      tree = null;
    }
  });
});

describe('the Recipes tab', () => {
  const importButtons = (root: ReactTestRenderer) =>
    [...byType(root, 'ToolbarButton'), ...root.root.findAll((n) => typeof n.type !== 'string' && !!n.props.label)]
      .filter((n) => label(n) === 'Import from link');
  // Add recipe is the tab bar's +, not a header button.
  const toolbarLabels = (root: ReactTestRenderer) => byType(root, 'ToolbarButton').map(label);

  test('plus with no recipes: the empty state imports through the Add recipe sheet, which takes a link in its one field', () => {
    const root = render(() => <RecipesScreen />, PLUS);
    expect(toolbarLabels(root)).toEqual([]);
    const buttons = importButtons(root);
    expect(buttons).toHaveLength(1);
    press(buttons[0]);
    expect(mockPush.mock.calls).toEqual([['/add-recipe']]);
  });

  test('without recipe_import no Import from link shows, and New recipe stays', () => {
    const root = render(() => <RecipesScreen />, STANDARD);
    expect(importButtons(root)).toEqual([]);
    expect(toolbarLabels(root)).toEqual([]);
    expect(root.root.findAll((n) => typeof n.type !== 'string' && n.props.label === 'New recipe')).not.toHaveLength(0);
  });

  test('the base plan hides it too', () => {
    const root = render(() => <RecipesScreen />, []);
    expect(importButtons(root)).toEqual([]);
  });

  test('with recipes the header has no buttons, with or without plus', () => {
    createRecipe('Tacos');
    let root = render(() => <RecipesScreen />, PLUS);
    expect(toolbarLabels(root)).toEqual([]);
    act(() => tree?.unmount());
    root = render(() => <RecipesScreen />, STANDARD);
    expect(toolbarLabels(root)).toEqual([]);
  });

  test("the header's round + and the empty New recipe open the same sheet", () => {
    const root = render(() => <RecipesScreen />, PLUS);
    press(root.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === 'Add recipe' && 'onPress' in n.props)[0]);
    press(root.root.findAll((n) => typeof n.type !== 'string' && n.props.label === 'New recipe')[0]);
    expect(mockPush.mock.calls).toEqual([['/add-recipe'], ['/add-recipe']]);
  });

  test("the tab bar's + on Recipes opens the List tab instead, with or without plus", () => {
    for (const features of [PLUS, STANDARD]) {
      render(() => <RecipesScreen />, features);
      act(() => pressAddButton());
      expect(mockPush).not.toHaveBeenCalled();
      expect(mockNavigate.mock.calls).toEqual([['/lists']]);
      expect(takePendingListAdd()).toBe(true);
      mockNavigate.mockClear();
      act(() => tree?.unmount());
      tree = null;
    }
  });

  test('gaining recipe_import shows it without leaving the tab', () => {
    const root = render(() => <RecipesScreen />, STANDARD);
    act(() => setFeatures(PLUS));
    expect(importButtons(root)).toHaveLength(1);
  });
});
