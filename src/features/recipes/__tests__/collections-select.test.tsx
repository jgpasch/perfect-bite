// Recipe collections, adding many at once (board D): the Recipes tab's Select mode (entering and leaving it,
// ticks, Select All, ticks kept through a search, the one-household rule, the bar), the Add to collection
// sheet for several recipes and its toast back on the tab, and a collection's Add recipes sheet, rendered
// against the in-memory database.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, households, recipes } from '@/db';
import { resetRecipesSegment } from '@/features/meal-plan/plan-tab';
import { setDeviceSetting, setPlanTab, setRecipeSortChoice } from '@/features/settings/device-settings';
import { emptyRecipeTags, type RecipeTags } from '@/shared/recipe-tags';
import { resetDb } from '@/test/db';

import AddRecipesToCollectionSheet from '@/app/add-to-collection';
import AddRecipesSheet from '@/app/collection/[id]/add-recipes';
import CollectionScreen from '@/app/collection/[id]/index';
import RecipesScreen from '@/app/(tabs)/recipes/index';

import {
  applyCollectionTicksToAll,
  createCollection,
  readCollectionsHoldingAll,
  readRecipeCollections,
  setRecipeInCollection,
} from '../collections';
import { collectionTicksToast, setCollectionTicksResult, takeCollectionTicksResult } from '../collection-ticks-result';
import { resetFoldedMealSections } from '../recipe-fold-store';
import { setRecipeFilters } from '../recipe-filter-store';
import { noRecipeFilters, toggleRecipeFilter } from '../recipe-filters';
import { RECIPE_PHOTO_SIZE_KEY } from '../recipe-photo-size';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => {
  const { createElement } = require('react');
  return { Icon: (props: object) => createElement('Icon', props) };
});
jest.mock('react-native-worklets', () => ({ scheduleOnRN: (fn: (...a: unknown[]) => void, ...args: unknown[]) => fn(...args) }));
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const { createElement } = require('react');
  return { __esModule: true, default: ({ children }: { children?: unknown }) => createElement('Swipeable', null, children) };
});
jest.mock('expo-image', () => {
  const { createElement } = require('react');
  return { Image: (props: object) => createElement('ExpoImage', props) };
});
jest.mock('react-native-reanimated', () => {
  const { Fragment, createElement } = require('react');
  const { View } = require('react-native');
  const builder: object = new Proxy({}, { get: () => () => builder });
  return {
    __esModule: true,
    default: { View, createAnimatedComponent: (c: unknown) => c },
    FadeIn: builder,
    FadeInDown: builder,
    FadeOut: builder,
    LinearTransition: builder,
    LayoutAnimationConfig: ({ children }: { children?: unknown }) => createElement(Fragment, null, children),
    ReduceMotion: { Never: 'never' },
    interpolate: () => 1,
    useReducedMotion: () => false,
    useAnimatedReaction: () => {},
    useAnimatedStyle: (fn: () => object) => fn(),
    useSharedValue: (value: unknown) => ({ value }),
    withSpring: (value: unknown) => value,
    withTiming: (value: unknown) => value,
  };
});
jest.mock('@expo/ui/swift-ui', () => {
  const { createElement } = require('react');
  const host = (type: string) =>
    function Host({ children, ...props }: { children?: unknown }) {
      return createElement(type, props, children);
    };
  return {
    Host: host('SwiftHost'),
    Menu: ({ label, children, ...props }: { label?: unknown; children?: unknown }) => createElement('SwiftMenu', props, label, children),
    RNHostView: host('RNHostView'),
    Section: host('SwiftSection'),
    Button: host('SwiftButton'),
    Toggle: host('SwiftToggle'),
  };
});
jest.mock('@expo/ui/swift-ui/modifiers', () => ({
  accessibilityLabel: (value: string) => ({ accessibilityLabel: value }),
  accessibilityHint: (value: string) => ({ accessibilityHint: value }),
}));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('expo-network', () => ({ addNetworkStateListener: () => ({ remove: () => {} }) }));
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
jest.mock('@/features/categories/categorization', () => ({ categorizePending: () => Promise.resolve() }));
jest.mock('@/features/recipes/share-reconcile', () => ({ removeQueuedShare: () => false, retryShareImport: async () => true }));
jest.mock('@/features/meal-plan/week-plan', () => {
  const { createElement } = require('react');
  return { WeekPlan: () => createElement('WeekPlan') };
});
const mockPush = jest.fn();
const mockBack = jest.fn();
const mockParams: Record<string, string | undefined> = {};
jest.mock('expo-router', () => {
  const { createElement, Fragment, useEffect } = require('react');
  const passThrough = () =>
    function PassThrough({ children }: { children?: unknown }) {
      return createElement(Fragment, null, children);
    };
  const host = (type: string) =>
    function Host({ children, ...props }: { children?: unknown }) {
      return createElement(type, props, children);
    };
  const Link = Object.assign(host('Link'), { Trigger: passThrough(), Menu: passThrough(), MenuAction: host('LinkMenuAction') });
  const Toolbar = Object.assign(passThrough(), {
    Button: host('ToolbarButton'),
    Menu: host('ToolbarMenu'),
    MenuAction: host('ToolbarMenuAction'),
  });
  return {
    Link,
    Stack: { Screen: host('StackScreen'), Toolbar },
    router: { push: (...args: unknown[]) => mockPush(...args), back: () => mockBack(), navigate: () => {} },
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
    useLocalSearchParams: () => mockParams,
    usePathname: () => '/recipes',
  };
});
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));

const NOW = new Date(2026, 9, 13, 9, 0);
const HOME = 'home';
const CABIN = 'cabin';
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
let tree: ReactTestRenderer | null = null;
let moms: string;
let kids: string;

function render(element: React.ReactElement): ReactTestRenderer {
  act(() => tree?.unmount());
  act(() => {
    tree = create(<SafeAreaProvider initialMetrics={METRICS}>{element}</SafeAreaProvider>);
  });
  return tree!;
}
const rerender = (element: React.ReactElement) =>
  act(() => tree!.update(<SafeAreaProvider initialMetrics={METRICS}>{element}</SafeAreaProvider>));

function addRecipe(id: string, name: string, meal: string[] = [], householdId = HOME) {
  const tags: RecipeTags | null = meal.length > 0 ? { ...emptyRecipeTags(), meal } : null;
  db.insert(recipes).values({ id, householdId, name, tags, totalMinutes: 35, updatedAt: NOW }).run();
}

const text = (node: ReactTestInstance) => [node.props.children].flat().join('');
const texts = (root: ReactTestRenderer) => root.root.findAll((n) => n.type === ('Text' as never)).map(text);
const byTestId = (root: ReactTestRenderer, testID: string) =>
  root.root.findAll((n) => n.props.testID === testID && typeof n.props.onPress === 'function');
/** The innermost pressable with this testID (a Button and its Pressable both carry it). */
const one = (root: ReactTestRenderer, testID: string) => byTestId(root, testID).at(-1)!;
const press = (n: ReactTestInstance) => act(() => n.props.onPress());
const linkLabel = (link: ReactTestInstance) =>
  link.findAll((n) => n.props.accessibilityRole === 'button')[0].props.accessibilityLabel as string;
const menuAction = (root: ReactTestRenderer, recipeName: string, title: string) => {
  const link = root.root.findAll((n) => n.type === ('Link' as never)).find((l) => linkLabel(l).startsWith(recipeName))!;
  return link.findAll((n) => n.type === ('LinkMenuAction' as never)).find((a) => a.props.title === title)!;
};
/** Select mode's rows (or tiles) as "Pot roast: true", the label's ", selected" left off. */
const ticks = (root: ReactTestRenderer, testID = 'recipe-select-row') =>
  byTestId(root, testID).map((n) => `${(n.props.accessibilityLabel as string).replace(/, selected$/, '')}: ${n.props.accessibilityState.selected}`);
const ticked = (root: ReactTestRenderer) => ticks(root).filter((s) => s.endsWith('true')).map((s) => s.replace(/: true$/, ''));
const selectRow = (root: ReactTestRenderer, name: string, testID = 'recipe-select-row') =>
  byTestId(root, testID).find((n) => (n.props.accessibilityLabel as string).replace(/, selected$/, '') === name)!;
const selectTitle = (root: ReactTestRenderer) =>
  text(root.root.find((n) => n.props.testID === 'recipes-select-title' && n.type === ('Text' as never)));
const toastMessage = (root: ReactTestRenderer) =>
  (root.root.findAll((n) => typeof n.props.message === 'string' && Array.isArray(n.props.actions))[0]?.props.message as string) ?? null;
const search = (root: ReactTestRenderer, q: string) =>
  act(() =>
    root.root.find((n) => n.props.accessibilityLabel === 'Search recipes' && typeof n.props.onChangeText === 'function').props.onChangeText(q),
  );
const collectionNames = (recipeId: string) => readRecipeCollections(recipeId).map((c) => c.name);
/** The tab in Select mode, entered through Pot roast's menu. */
function selecting(): ReactTestRenderer {
  const root = render(<RecipesScreen />);
  press(menuAction(root, 'Pot roast', 'Select'));
  return root;
}

beforeAll(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'setInterval', 'clearInterval', 'queueMicrotask', 'nextTick'] });
});

afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  resetDb();
  resetFoldedMealSections();
  resetRecipesSegment();
  setRecipeFilters(noRecipeFilters());
  setRecipeSortChoice({ sort: 'name', group: 'none' });
  setDeviceSetting(RECIPE_PHOTO_SIZE_KEY, 'small');
  setPlanTab(true);
  takeCollectionTicksResult();
  mockPush.mockClear();
  mockBack.mockClear();
  for (const k of Object.keys(mockParams)) delete mockParams[k];
  db.insert(households).values({ id: HOME, name: 'Home', createdAt: new Date(2026, 0, 1) }).run();
  addRecipe('roast', 'Pot roast', ['dinner']);
  addRecipe('bars', 'Lemon bars', ['dessert']);
  addRecipe('bread', 'Banana bread', ['dessert']);
  ['Tacos', 'Pho', 'Curry', 'Dal', 'Frittata', 'Gnocchi'].forEach((name) => addRecipe(name.toLowerCase(), name));
  moms = createCollection(HOME, "Mom's cookbook");
  kids = createCollection(HOME, 'Kid favorites');
  setRecipeInCollection('roast', moms, true);
  setRecipeInCollection('bars', moms, true);
  setRecipeInCollection('tacos', kids, true);
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  jest.restoreAllMocks();
});

const ALL_OFF = ['Banana bread', 'Curry', 'Dal', 'Frittata', 'Gnocchi', 'Lemon bars', 'Pho', 'Pot roast', 'Tacos'];

describe("the Recipes tab's Select mode", () => {
  test('Select in the card menu enters it with that recipe ticked: Cancel, "1 selected", Select All and the bar', () => {
    const root = render(<RecipesScreen />);
    const select = menuAction(root, 'Pot roast', 'Select');
    expect(select.props.icon).toBe('checkmark.circle');
    press(select);

    expect(selectTitle(root)).toBe('1 selected');
    expect(one(root, 'recipes-select-cancel').props.accessibilityLabel).toBe('Cancel');
    expect(one(root, 'recipes-select-all').props.accessibilityLabel).toBe('Select All');
    expect(ticked(root)).toEqual(['Pot roast']);
    expect(ticks(root).map((s) => s.split(':')[0])).toEqual(ALL_OFF);
    // VoiceOver: "Pot roast, selected".
    expect(selectRow(root, 'Pot roast').props.accessibilityLabel).toBe('Pot roast, selected');
    expect(selectRow(root, 'Tacos').props.accessibilityLabel).toBe('Tacos');
    // Rows tick instead of opening; the sort, +, shelves and All recipes heading give way.
    expect(root.root.findAll((n) => n.type === ('Link' as never))).toHaveLength(0);
    expect(byTestId(root, 'recipes-add')).toHaveLength(0);
    expect(root.root.findAll((n) => n.props.testID === 'recipes-all-heading')).toHaveLength(0);
    expect(byTestId(root, 'collection-shelf-tile')).toHaveLength(0);
    const add = one(root, 'recipes-add-to-collection');
    expect(add.props.accessibilityLabel).toBe('Add to collection');
    expect(add.props.disabled).toBe(false);
  });

  test('Cancel leaves it, ticking nothing, and the rows open recipes again', () => {
    const root = selecting();
    press(selectRow(root, 'Tacos'));
    press(one(root, 'recipes-select-cancel'));
    expect(byTestId(root, 'recipe-select-row')).toHaveLength(0);
    expect(byTestId(root, 'recipes-add-to-collection')).toHaveLength(0);
    expect(byTestId(root, 'recipes-add')).toHaveLength(1);
    expect(menuAction(root, 'Tacos', 'Select')).toBeDefined();
    expect(root.root.findAll((n) => n.props.testID === 'recipes-all-heading')).not.toHaveLength(0);
    expect(collectionNames('tacos')).toEqual(['Kid favorites']);
  });

  test('a tap ticks and unticks; with none ticked it says "Tap recipes to select them" and the bar is off', () => {
    const root = selecting();
    press(selectRow(root, 'Tacos'));
    press(selectRow(root, 'Dal'));
    expect(selectTitle(root)).toBe('3 selected');
    expect(ticked(root)).toEqual(['Dal', 'Pot roast', 'Tacos']);
    press(selectRow(root, 'Tacos'));
    press(selectRow(root, 'Dal'));
    press(selectRow(root, 'Pot roast'));
    expect(selectTitle(root)).toBe('Tap recipes to select them');
    expect(ticked(root)).toEqual([]);
    expect(one(root, 'recipes-add-to-collection').props.disabled).toBe(true);
  });

  test('Select All ticks every recipe shown after search and filters, then Deselect All unticks them', () => {
    const root = selecting();
    act(() => setRecipeFilters(toggleRecipeFilter(noRecipeFilters(), 'meal', 'dessert')));
    // Pot roast isn't a dessert, so it's hidden, but its tick stays.
    expect(ticks(root)).toEqual(['Banana bread: false', 'Lemon bars: false']);
    expect(selectTitle(root)).toBe('1 selected');
    press(one(root, 'recipes-select-all'));
    expect(ticked(root)).toEqual(['Banana bread', 'Lemon bars']);
    expect(selectTitle(root)).toBe('3 selected');
    expect(one(root, 'recipes-select-all').props.accessibilityLabel).toBe('Deselect All');
    press(one(root, 'recipes-select-all'));
    expect(ticked(root)).toEqual([]);
    expect(selectTitle(root)).toBe('1 selected');
    expect(one(root, 'recipes-select-all').props.accessibilityLabel).toBe('Select All');
  });

  test('ticks are kept through a search', () => {
    const root = selecting();
    search(root, 'taco');
    expect(ticks(root)).toEqual(['Tacos: false']);
    press(selectRow(root, 'Tacos'));
    expect(selectTitle(root)).toBe('2 selected');
    search(root, 'pho');
    expect(ticks(root)).toEqual(['Pho: false']);
    search(root, '');
    expect(ticked(root)).toEqual(['Pot roast', 'Tacos']);
  });

  test("a recipe of another household isn't ticked: \"Pick recipes from one household at a time.\"", () => {
    db.insert(households).values({ id: CABIN, name: 'Cabin', createdAt: new Date(2026, 5, 1) }).run();
    addRecipe('stew', 'Cabin stew', [], CABIN);
    const root = selecting();
    press(selectRow(root, 'Cabin stew'));
    expect(toastMessage(root)).toBe('Pick recipes from one household at a time.');
    expect(ticked(root)).toEqual(['Pot roast']);
    expect(selectTitle(root)).toBe('1 selected');
    // Select All stays in the selection's household.
    press(one(root, 'recipes-select-all'));
    expect(ticked(root)).toEqual(ALL_OFF);
    // With nothing ticked, the other household's recipes can be ticked.
    press(one(root, 'recipes-select-all'));
    press(selectRow(root, 'Cabin stew'));
    expect(ticked(root)).toEqual(['Cabin stew']);
  });

  test('with large photos the tiles tick', () => {
    setDeviceSetting(RECIPE_PHOTO_SIZE_KEY, 'large');
    const root = render(<RecipesScreen />);
    press(menuAction(root, 'Tacos', 'Select'));
    expect(ticks(root, 'recipe-select-tile').filter((s) => s.endsWith('true'))).toEqual(['Tacos: true']);
    press(selectRow(root, 'Dal', 'recipe-select-tile'));
    expect(selectRow(root, 'Dal', 'recipe-select-tile').props.accessibilityLabel).toBe('Dal, selected');
    expect(selectTitle(root)).toBe('2 selected');
  });

  test('Add to collection opens the sheet for the selected recipes', () => {
    const root = selecting();
    press(selectRow(root, 'Tacos'));
    press(one(root, 'recipes-add-to-collection'));
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/add-to-collection', params: { ids: 'roast,tacos' } });
  });

  test("the sheet's Done leaves Select mode with a toast", () => {
    const root = selecting();
    press(selectRow(root, 'Tacos'));
    act(() =>
      setCollectionTicksResult({ recipeCount: 4, added: [{ id: moms, name: "Mom's cookbook" }], removed: [] }),
    );
    expect(byTestId(root, 'recipe-select-row')).toHaveLength(0);
    expect(toastMessage(root)).toBe("Added 4 recipes to Mom's cookbook");
  });

  test('a Done that changed nothing still leaves Select mode, with no toast', () => {
    const root = selecting();
    act(() => setCollectionTicksResult({ recipeCount: 1, added: [], removed: [] }));
    expect(byTestId(root, 'recipe-select-row')).toHaveLength(0);
    expect(toastMessage(root)).toBeNull();
  });
});

describe('the Add to collection sheet for several recipes', () => {
  // The row and its frame both carry the role, so each is listed once.
  const sheetRows = (root: ReactTestRenderer) => [
    ...new Set(
      root.root
        .findAll((n) => n.props.accessibilityRole === 'checkbox' && typeof n.props.onPress === 'function')
        .map((n) => `${n.props.accessibilityLabel}: ${n.props.accessibilityState.checked}`),
    ),
  ];
  const sheetRow = (root: ReactTestRenderer, name: string) =>
    root.root.findAll(
      (n) => n.props.accessibilityRole === 'checkbox' && typeof n.props.onPress === 'function' && n.props.accessibilityLabel.startsWith(name),
    )[0];
  const done = (root: ReactTestRenderer) =>
    act(() =>
      root.root
        .findAll((n) => n.type === ('ToolbarButton' as never))
        .find((n) => text(n) === 'Done')!
        .props.onPress(),
    );

  test('"2 recipes" under the title; a collection is ticked only when every one of them is in it', () => {
    setRecipeInCollection('tacos', moms, true);
    mockParams.ids = 'roast,tacos';
    const root = render(<AddRecipesToCollectionSheet />);
    expect(texts(root)).toContain('2 recipes');
    // Both are in Mom's cookbook; only Tacos is in Kid favorites.
    expect(sheetRows(root)).toEqual(['Kid favorites, 1 recipe: false', "Mom's cookbook, 3 recipes: true"]);
  });

  test('Done adds all of them to a newly ticked collection, and hands the tab "Added 2 recipes to Kid favorites"', () => {
    mockParams.ids = 'roast,tacos';
    const root = render(<AddRecipesToCollectionSheet />);
    press(sheetRow(root, 'Kid favorites'));
    done(root);
    expect(collectionNames('roast')).toEqual(['Kid favorites', "Mom's cookbook"]);
    expect(collectionNames('tacos')).toEqual(['Kid favorites']);
    expect(mockBack).toHaveBeenCalledTimes(1);
    const result = takeCollectionTicksResult()!;
    expect(result).toEqual({ recipeCount: 2, added: [{ id: kids, name: 'Kid favorites' }], removed: [] });
    expect(collectionTicksToast(result)).toEqual({ message: 'Added 2 recipes to Kid favorites', emphasis: 'Kid favorites' });
  });

  test('unticking a collection holding all of them takes all of them out; a partial one left unticked is untouched', () => {
    setRecipeInCollection('tacos', moms, true);
    mockParams.ids = 'roast,tacos';
    const root = render(<AddRecipesToCollectionSheet />);
    press(sheetRow(root, "Mom's cookbook"));
    done(root);
    expect(collectionNames('roast')).toEqual([]);
    // Tacos keeps Kid favorites, which held only it.
    expect(collectionNames('tacos')).toEqual(['Kid favorites']);
    expect(collectionTicksToast(takeCollectionTicksResult()!)).toEqual({
      message: "Removed 2 recipes from Mom's cookbook",
      emphasis: "Mom's cookbook",
    });
  });

  test('Cancel writes nothing and hands the tab nothing', () => {
    mockParams.ids = 'roast,tacos';
    const root = render(<AddRecipesToCollectionSheet />);
    press(sheetRow(root, 'Kid favorites'));
    act(() =>
      root.root
        .findAll((n) => n.type === ('ToolbarButton' as never))
        .find((n) => text(n) === 'Cancel')!
        .props.onPress(),
    );
    expect(collectionNames('roast')).toEqual(["Mom's cookbook"]);
    expect(takeCollectionTicksResult()).toBeNull();
  });

  test('no recipes found: an empty screen', () => {
    mockParams.ids = 'gone';
    const root = render(<AddRecipesToCollectionSheet />);
    expect(texts(root)).toEqual([]);
  });
});

describe('collection ticks for several recipes', () => {
  test('readCollectionsHoldingAll: the collections every recipe is in', () => {
    setRecipeInCollection('tacos', moms, true);
    expect([...readCollectionsHoldingAll(['roast', 'tacos'])]).toEqual([moms]);
    expect([...readCollectionsHoldingAll(['tacos'])].sort()).toEqual([moms, kids].sort());
    expect([...readCollectionsHoldingAll(['roast', 'dal'])]).toEqual([]);
    expect([...readCollectionsHoldingAll(['roast', 'roast'])]).toEqual([moms]);
    expect([...readCollectionsHoldingAll([])]).toEqual([]);
  });

  test('applyCollectionTicksToAll adds to newly ticked, removes from unticked, and leaves the rest', () => {
    const changed = applyCollectionTicksToAll(['roast', 'dal'], new Set([moms]), new Set([kids]));
    expect(changed).toEqual({ added: [kids], removed: [moms] });
    expect(collectionNames('roast')).toEqual(['Kid favorites']);
    expect(collectionNames('dal')).toEqual(['Kid favorites']);
    // Lemon bars wasn't selected, so it stays in Mom's cookbook.
    expect(collectionNames('bars')).toEqual(["Mom's cookbook"]);
    expect(applyCollectionTicksToAll(['roast'], new Set([kids]), new Set([kids]))).toEqual({ added: [], removed: [] });
  });

  test('collectionTicksToast: one or several collections, added first, nothing for no change, and in Spanish', () => {
    const a = { id: 'a', name: "Mom's cookbook" };
    const b = { id: 'b', name: 'Kid favorites' };
    expect(collectionTicksToast({ recipeCount: 1, added: [a], removed: [] })?.message).toBe("Added 1 recipe to Mom's cookbook");
    expect(collectionTicksToast({ recipeCount: 3, added: [a, b], removed: [] })).toEqual({ message: 'Added 3 recipes to 2 collections' });
    expect(collectionTicksToast({ recipeCount: 3, added: [a], removed: [b] })?.message).toBe("Added 3 recipes to Mom's cookbook");
    expect(collectionTicksToast({ recipeCount: 3, added: [], removed: [a, b] })?.message).toBe('Removed 3 recipes from 2 collections');
    expect(collectionTicksToast({ recipeCount: 3, added: [], removed: [] })).toBeNull();
    const { i18n } = require('@/i18n');
    const was = i18n.language;
    act(() => void i18n.changeLanguage('es'));
    try {
      expect(collectionTicksToast({ recipeCount: 4, added: [a], removed: [] })?.message).toBe("Se agregaron 4 recetas a Mom's cookbook");
    } finally {
      act(() => void i18n.changeLanguage(was));
    }
  });
});

describe("a collection's Add recipes sheet", () => {
  const rows = (root: ReactTestRenderer) =>
    root.root
      .findAll((n) => n.props.testID === 'add-recipes-row' && typeof n.props.onPress === 'function')
      .map((n) => `${n.props.accessibilityLabel}${n.props.disabled ? ' (disabled)' : ''}`);
  const row = (root: ReactTestRenderer, name: string) =>
    byTestId(root, 'add-recipes-row').find((n) => (n.props.accessibilityLabel as string).startsWith(name))!;

  beforeEach(() => {
    mockParams.id = moms;
    db.insert(households).values({ id: CABIN, name: 'Cabin', createdAt: new Date(2026, 5, 1) }).run();
    addRecipe('stew', 'Cabin stew', [], CABIN);
  });

  test("the collection screen's Add recipes opens it", () => {
    const root = render(<CollectionScreen />);
    press(one(root, 'collection-add-recipes'));
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/collection/[id]/add-recipes', params: { id: moms } });
  });

  test("the household's recipes A–Z, the ones already in disabled \"Already in Mom's cookbook\", no bar yet", () => {
    const root = render(<AddRecipesSheet />);
    expect(texts(root)).toEqual(expect.arrayContaining(['Add recipes', "Mom's cookbook"]));
    expect(rows(root)).toEqual([
      'Banana bread, Dessert · 35 min',
      'Curry, 35 min',
      'Dal, 35 min',
      'Frittata, 35 min',
      'Gnocchi, 35 min',
      "Lemon bars, Already in Mom's cookbook (disabled)",
      'Pho, 35 min',
      "Pot roast, Already in Mom's cookbook (disabled)",
      'Tacos, 35 min',
    ]);
    expect(byTestId(root, 'add-recipes-add')).toHaveLength(0);
  });

  test('ticking shows "Add 2 to Mom\'s cookbook", which adds them and closes', () => {
    const root = render(<AddRecipesSheet />);
    press(row(root, 'Tacos'));
    expect(row(root, 'Tacos').props.accessibilityLabel).toBe('Tacos, selected, 35 min');
    press(row(root, 'Dal'));
    const add = one(root, 'add-recipes-add');
    expect(add.props.accessibilityLabel).toBe("Add 2 to Mom's cookbook");
    press(add);
    expect(collectionNames('tacos')).toEqual(['Kid favorites', "Mom's cookbook"]);
    expect(collectionNames('dal')).toEqual(["Mom's cookbook"]);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('unticking the last one hides the bar', () => {
    const root = render(<AddRecipesSheet />);
    press(row(root, 'Tacos'));
    press(row(root, 'Tacos'));
    expect(byTestId(root, 'add-recipes-add')).toHaveLength(0);
  });

  test('the search narrows the rows and the ticks outlast it', () => {
    const root = render(<AddRecipesSheet />);
    press(row(root, 'Tacos'));
    const field = () => root.root.find((n) => n.props.accessibilityLabel === 'Search recipes' && typeof n.props.onChangeText === 'function');
    act(() => field().props.onChangeText('ph'));
    expect(rows(root)).toEqual(['Pho, 35 min']);
    press(row(root, 'Pho'));
    act(() => field().props.onChangeText('zzz'));
    expect(rows(root)).toEqual([]);
    expect(texts(root)).toContain('No recipes match');
    act(() => field().props.onChangeText(''));
    expect(one(root, 'add-recipes-add').props.accessibilityLabel).toBe("Add 2 to Mom's cookbook");
  });

  test('a household with no recipes says so', () => {
    const cabin = createCollection(CABIN, 'Cabin meals');
    db.update(recipes).set({ deletedAt: NOW }).where(eq(recipes.id, 'stew')).run();
    mockParams.id = cabin;
    const root = render(<AddRecipesSheet />);
    expect(rows(root)).toEqual([]);
    expect(texts(root)).toContain('This household has no recipes yet');
  });

  test('a recipe added elsewhere since it opened shows as already in', () => {
    const root = render(<AddRecipesSheet />);
    press(row(root, 'Tacos'));
    setRecipeInCollection('tacos', moms, true);
    rerender(<AddRecipesSheet />);
    expect(row(root, 'Tacos').props.disabled).toBe(true);
    expect(byTestId(root, 'add-recipes-add')).toHaveLength(0);
  });
});
