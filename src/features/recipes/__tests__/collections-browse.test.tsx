// Recipe collections, browsing (boards A and B): the Recipes tab's Collections shelf (shown, hidden, its place
// among the shelves, its tiles, New collection and See all), the Collections list, and a collection's screen
// (its rows, Filter, Rename, Select recipes, Remove from, Delete with Undo and the empty state), rendered
// against the in-memory database.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Alert, type AlertButton } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, households, mealPlanEntries, recipeCollections, recipeFavorites, recipes } from '@/db';
import { resetRecipesSegment } from '@/features/meal-plan/plan-tab';
import { setDeviceSetting, setPlanTab, setRecipeSortChoice } from '@/features/settings/device-settings';
import { emptyRecipeTags, type RecipeTags } from '@/shared/recipe-tags';
import { resetDb } from '@/test/db';

import CollectionScreen from '@/app/collection/[id]/index';
import CollectionFilterSheet from '@/app/collection/[id]/filter';
import CollectionsScreen from '@/app/collections';
import RecipesScreen from '@/app/(tabs)/recipes/index';

import { getCollectionFilters, setCollectionFilters } from '../collection-filter-store';
import { createCollection, readCollections, readHouseholdCollections, setRecipeInCollection } from '../collections';
import { setDeletedCollectionResult, takeDeletedCollectionResult } from '../deleted-collection-result';
import { resetFoldedMealSections } from '../recipe-fold-store';
import { getRecipeFilters, setRecipeFilters } from '../recipe-filter-store';
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
/** The live queries are read at render, so a write shows after rendering again. */
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
const press = (n: ReactTestInstance) => act(() => n.props.onPress());
const shelfKeys = (root: ReactTestRenderer) =>
  root.root
    .findAll((n) => typeof n.type === 'string' && /^recipe-shelf-(thisWeek|collections|recent|favorites)$/.test(String(n.props.testID ?? '')))
    .map((n) => String(n.props.testID).replace('recipe-shelf-', ''));
const collectionTiles = (root: ReactTestRenderer) => byTestId(root, 'collection-shelf-tile');
/** The outermost pressable thing with this VoiceOver label (a Button and its inner Pressable both match). */
const pressable = (root: ReactTestRenderer, label: string) =>
  root.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
/** A collection screen's recipe rows, by name, in order. */
const linkLabel = (link: ReactTestInstance) =>
  link.findAll((n) => n.props.accessibilityRole === 'button')[0].props.accessibilityLabel as string;
const rowNames = (root: ReactTestRenderer) =>
  root.root.findAll((n) => n.type === ('Link' as never)).map((l) => linkLabel(l).split(',')[0]);
const menuAction = (root: ReactTestRenderer, recipeName: string, title: string) => {
  const link = root.root.findAll((n) => n.type === ('Link' as never)).find((l) => linkLabel(l).startsWith(recipeName))!;
  return link.findAll((n) => n.type === ('LinkMenuAction' as never)).find((a) => a.props.title === title);
};
const toolbarMenuTitles = (root: ReactTestRenderer) =>
  root.root.findAll((n) => n.type === ('ToolbarMenuAction' as never)).map(text);
const toolbarMenuAction = (root: ReactTestRenderer, title: string) =>
  root.root.findAll((n) => n.type === ('ToolbarMenuAction' as never)).find((n) => text(n) === title)!;
const toolbarButtons = (root: ReactTestRenderer) => root.root.findAll((n) => n.type === ('ToolbarButton' as never));
const toolbarButton = (root: ReactTestRenderer, title: string) => toolbarButtons(root).find((n) => text(n) === title)!;
const title = (root: ReactTestRenderer) => text(root.root.find((n) => n.props.testID === 'collection-title' && n.type === ('Text' as never)));
const selectRows = (root: ReactTestRenderer) =>
  root.root
    .findAll((n) => n.props.testID === 'recipe-select-row' && typeof n.props.onPress === 'function')
    .map((n) => `${(n.props.accessibilityLabel as string).replace(/, selected$/, '')}: ${n.props.accessibilityState.selected}`);
const selectRow = (root: ReactTestRenderer, name: string) =>
  root.root.find(
    (n) =>
      n.props.testID === 'recipe-select-row' &&
      typeof n.props.onPress === 'function' &&
      (n.props.accessibilityLabel === name || n.props.accessibilityLabel === `${name}, selected`),
  );
/** The toast's message, or null with none. */
const toastMessage = (root: ReactTestRenderer) =>
  (root.root.findAll((n) => typeof n.props.message === 'string' && Array.isArray(n.props.actions))[0]?.props.message as string) ?? null;
const membershipNames =(collectionId: string) =>
  readCollections()
    .find((c) => c.id === collectionId)
    ?.cover.map((r) => r.name);

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
  takeDeletedCollectionResult();
  mockPush.mockClear();
  mockBack.mockClear();
  for (const k of Object.keys(mockParams)) delete mockParams[k];
  db.insert(households).values({ id: HOME, name: 'Home', createdAt: new Date(2026, 0, 1) }).run();
  // Nine recipes, so the tab shows shelves.
  addRecipe('roast', 'Pot roast', ['dinner']);
  addRecipe('bars', 'Lemon bars', ['dessert']);
  addRecipe('bread', 'Banana bread', ['dessert']);
  ['Tacos', 'Pho', 'Curry', 'Dal', 'Frittata', 'Gnocchi'].forEach((name) => addRecipe(name.toLowerCase(), name));
  moms = createCollection(HOME, "Mom's cookbook");
  kids = createCollection(HOME, 'Kid favorites');
  setRecipeInCollection('roast', moms, true);
  setRecipeInCollection('bars', moms, true);
  setRecipeInCollection('bread', moms, true);
  setRecipeInCollection('tacos', kids, true);
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  jest.restoreAllMocks();
});

describe('the Collections shelf', () => {
  test('comes after This week and before Recently added and Favorites', () => {
    db.insert(mealPlanEntries)
      .values({ id: 'thu', householdId: HOME, planDate: '2026-10-15', meal: 'dinner', kind: 'recipe', recipeId: 'tacos' })
      .run();
    db.insert(recipeFavorites).values({ recipeId: 'pho', userId: 'user-1', householdId: HOME }).run();
    const root = render(<RecipesScreen />);
    expect(shelfKeys(root)).toEqual(['thisWeek', 'collections', 'recent', 'favorites']);
    expect(texts(root)).toContain('Collections');
  });

  test('with nothing planned it comes first', () => {
    const root = render(<RecipesScreen />);
    expect(shelfKeys(root)).toEqual(['collections', 'recent']);
  });

  test('is hidden while the households have no collection', () => {
    db.update(recipeCollections).set({ deletedAt: NOW }).run();
    const root = render(<RecipesScreen />);
    expect(shelfKeys(root)).toEqual(['recent']);
    expect(byTestId(root, 'collection-shelf-new')).toHaveLength(0);
  });

  test('is hidden while searching or filtering, like the other shelves', () => {
    setRecipeFilters(toggleRecipeFilter(noRecipeFilters(), 'meal', 'dessert'));
    const root = render(<RecipesScreen />);
    expect(shelfKeys(root)).toEqual([]);
  });

  test("its tiles are the collections A–Z, read as \"Mom's cookbook, 3 recipes\", then New collection", () => {
    const root = render(<RecipesScreen />);
    expect(collectionTiles(root).map((n) => n.props.accessibilityLabel)).toEqual(['Kid favorites, 1 recipe', "Mom's cookbook, 3 recipes"]);
    const tile = collectionTiles(root)[1];
    expect(tile.findAll((n) => n.type === ('Text' as never)).map(text)).toEqual(["Mom's cookbook", '3 recipes']);
    expect(tile.findAll((n) => n.props.testID === 'collection-cover' && typeof n.type === 'string')).toHaveLength(1);
    expect(byTestId(root, 'collection-shelf-new').map((n) => n.props.accessibilityLabel)).toEqual(['New collection']);
    expect(root.root.find((n) => n.props.testID === 'recipe-shelf-collections-see-all' && typeof n.props.label === 'string').props.label).toBe('See all 2');
  });

  test('a tile opens the collection, See all the list of every collection', () => {
    const root = render(<RecipesScreen />);
    press(collectionTiles(root)[1]);
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/collection/[id]', params: { id: moms } });
    press(byTestId(root, 'recipe-shelf-collections-see-all')[0]);
    expect(mockPush).toHaveBeenLastCalledWith('/collections');
  });

  test('New collection asks for a name, makes it in the household and opens it', () => {
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const root = render(<RecipesScreen />);
    press(byTestId(root, 'collection-shelf-new')[0]);
    act(() => {
      const buttons = prompt.mock.calls.at(-1)![2] as AlertButton[];
      (buttons.find((b) => b.text === 'Create')!.onPress as (name: string) => void)('Weeknights');
    });
    const made = readHouseholdCollections(HOME).find((c) => c.name === 'Weeknights')!;
    expect(made).toBeDefined();
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/collection/[id]', params: { id: made.id } });
  });

  test('with several households, New collection first asks which one', () => {
    db.insert(households).values({ id: CABIN, name: 'Cabin', createdAt: new Date(2026, 5, 1) }).run();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const root = render(<RecipesScreen />);
    press(byTestId(root, 'collection-shelf-new')[0]);
    expect(alert.mock.calls[0][0]).toBe('New collection in…');
    const choices = alert.mock.calls[0][2] as AlertButton[];
    expect(choices.map((b) => b.text)).toEqual(['Home', 'Cabin', 'Cancel']);
    act(() => choices[1].onPress!());
    act(() => {
      const buttons = prompt.mock.calls.at(-1)![2] as AlertButton[];
      (buttons.find((b) => b.text === 'Create')!.onPress as (name: string) => void)("Mom's cookbook");
    });
    // The Cabin can have its own Mom's cookbook.
    expect(readHouseholdCollections(CABIN).map((c) => c.name)).toEqual(["Mom's cookbook"]);
  });

  test('a collection deleted on its screen shows "Deleted Mom\'s cookbook" with Undo here', () => {
    db.update(recipeCollections).set({ deletedAt: NOW }).run();
    setDeletedCollectionResult({ id: moms, name: "Mom's cookbook" });
    const root = render(<RecipesScreen />);
    expect(toastMessage(root)).toBe("Deleted Mom's cookbook");
    press(pressable(root, 'Undo'));
    expect(readHouseholdCollections(HOME).map((c) => c.name)).toEqual(["Mom's cookbook"]);
  });
});

describe('the Collections list', () => {
  test("one household: the title, then the collections' rows A–Z, each opening its collection", () => {
    const root = render(<CollectionsScreen />);
    expect(texts(root)).toEqual(['Collections', 'Kid favorites', '1 recipe', "Mom's cookbook", '3 recipes']);
    const row = pressable(root, "Mom's cookbook, 3 recipes");
    expect(row.props.accessibilityRole).toBe('button');
    expect(row.props.accessibilityHint).toBe('Opens the collection');
    press(row);
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/collection/[id]', params: { id: moms } });
  });

  test("several households: a card per household that has any, under its name, oldest first", () => {
    db.insert(households).values([
      { id: CABIN, name: 'Cabin', createdAt: new Date(2026, 5, 1) },
      { id: 'beach', name: 'Beach', createdAt: new Date(2026, 6, 1) },
    ]).run();
    createCollection(CABIN, 'Cabin meals');
    const root = render(<CollectionsScreen />);
    expect(texts(root)).toEqual(['Collections', 'Home', 'Kid favorites', '1 recipe', "Mom's cookbook", '3 recipes', 'Cabin', 'Cabin meals', '0 recipes']);
  });
});

describe("a collection's screen", () => {
  beforeEach(() => {
    mockParams.id = moms;
  });

  test('shows the name, "N recipes", Add recipes and Filter, then its recipes A–Z', () => {
    const root = render(<CollectionScreen />);
    expect(title(root)).toBe("Mom's cookbook");
    expect(texts(root).slice(0, 2)).toEqual(["Mom's cookbook", '3 recipes']);
    expect(byTestId(root, 'collection-add-recipes').map((n) => n.props.label)).toEqual(['Add recipes']);
    expect(byTestId(root, 'collection-filter').map((n) => n.props.label)).toEqual(['Filter']);
    expect(rowNames(root)).toEqual(['Banana bread', 'Lemon bars', 'Pot roast']);
  });

  test('its ⋯ menu holds Rename, Select recipes and Delete collection (danger)', () => {
    const root = render(<CollectionScreen />);
    expect(toolbarMenuTitles(root)).toEqual(['Rename', 'Select recipes', 'Delete collection']);
    expect(toolbarMenuAction(root, 'Delete collection').props.destructive).toBe(true);
  });

  test("a recipe's long-press menu adds Remove from Mom's cookbook, which takes it out", () => {
    const root = render(<CollectionScreen />);
    const titles = menuAction(root, 'Pot roast', "Remove from Mom's cookbook");
    expect(titles).toBeDefined();
    press(titles!);
    rerender(<CollectionScreen />);
    expect(rowNames(root)).toEqual(['Banana bread', 'Lemon bars']);
    expect(texts(root)).toContain('2 recipes');
  });

  test('Rename asks with the current name; a duplicate (ignoring case) is refused, a new name is kept', () => {
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const root = render(<CollectionScreen />);
    press(toolbarMenuAction(root, 'Rename'));
    const [heading, , buttons, , value] = prompt.mock.calls.at(-1)!;
    expect(heading).toBe('Rename collection');
    expect(value).toBe("Mom's cookbook");
    const save = (name: string) => act(() => ((buttons as AlertButton[]).find((b) => b.text === 'Save')!.onPress as (n: string) => void)(name));

    save('kid FAVORITES');
    expect(alert).toHaveBeenLastCalledWith("There's already a collection called kid FAVORITES.");
    save('   ');
    expect(readHouseholdCollections(HOME).map((c) => c.name)).toEqual(['Kid favorites', "Mom's cookbook"]);

    save("Grandma's cookbook");
    rerender(<CollectionScreen />);
    expect(title(root)).toBe("Grandma's cookbook");
  });

  test('Delete collection asks, then deletes it (the recipes stay), pops back and hands over the toast with Undo', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const root = render(<CollectionScreen />);
    press(toolbarMenuAction(root, 'Delete collection'));
    const [heading, message, buttons] = alert.mock.calls.at(-1)!;
    expect(heading).toBe("Delete Mom's cookbook?");
    expect(message).toBe('The recipes stay.');
    const choices = buttons as AlertButton[];
    expect(choices.map((b) => [b.text, b.style])).toEqual([
      ['Cancel', 'cancel'],
      ['Delete', 'destructive'],
    ]);
    act(() => choices[1].onPress!());

    expect(readHouseholdCollections(HOME).map((c) => c.name)).toEqual(['Kid favorites']);
    expect(db.select().from(recipes).all()).toHaveLength(9);
    expect(mockBack).toHaveBeenCalledTimes(1);

    // The list it pops back to shows the toast; Undo brings the collection and its recipes back.
    const list = render(<CollectionsScreen />);
    expect(toastMessage(list)).toBe("Deleted Mom's cookbook");
    press(pressable(list, 'Undo'));
    expect(readHouseholdCollections(HOME).map((c) => [c.name, c.recipeCount])).toEqual([
      ['Kid favorites', 1],
      ["Mom's cookbook", 3],
    ]);
  });

  test('Select recipes: rows tick, Select All and Deselect All, and Remove from collection takes the ticked out', () => {
    const root = render(<CollectionScreen />);
    press(toolbarMenuAction(root, 'Select recipes'));
    expect(title(root)).toBe('Tap recipes to select them');
    expect(toolbarButtons(root).map(text)).toEqual(['Cancel', 'Select All']);
    expect(rowNames(root)).toEqual([]);
    expect(selectRows(root)).toEqual(['Banana bread: false', 'Lemon bars: false', 'Pot roast: false']);
    const remove = () => root.root.find((n) => n.props.testID === 'collection-remove-selected' && typeof n.props.onPress === 'function');
    expect(remove().props.disabled).toBe(true);

    press(selectRow(root, 'Pot roast'));
    expect(title(root)).toBe('1 selected');
    expect(selectRows(root)).toEqual(['Banana bread: false', 'Lemon bars: false', 'Pot roast: true']);

    press(toolbarButton(root, 'Select All'));
    expect(title(root)).toBe('3 selected');
    press(toolbarButton(root, 'Deselect All'));
    expect(title(root)).toBe('Tap recipes to select them');

    press(selectRow(root, 'Pot roast'));
    press(selectRow(root, 'Lemon bars'));
    expect(remove().props.label).toBe('Remove from collection');
    press(remove());
    rerender(<CollectionScreen />);

    expect(membershipNames(moms)).toEqual(['Banana bread']);
    expect(title(root)).toBe("Mom's cookbook");
    expect(rowNames(root)).toEqual(['Banana bread']);
  });

  test('Cancel leaves Select mode without removing anything', () => {
    const root = render(<CollectionScreen />);
    press(toolbarMenuAction(root, 'Select recipes'));
    press(selectRow(root, 'Pot roast'));
    press(toolbarButton(root, 'Cancel'));
    expect(title(root)).toBe("Mom's cookbook");
    expect(rowNames(root)).toEqual(['Banana bread', 'Lemon bars', 'Pot roast']);
    expect(toolbarMenuTitles(root)).toEqual(['Rename', 'Select recipes', 'Delete collection']);
  });

  test('an empty collection shows "No recipes yet" and Add recipes, without Filter', () => {
    mockParams.id = createCollection(HOME, 'Someday');
    const root = render(<CollectionScreen />);
    expect(texts(root)).toEqual(['Someday', '0 recipes', 'No recipes yet', 'Add recipes']);
    expect(byTestId(root, 'collection-empty-add')[0].props.label).toBe('Add recipes');
    expect(byTestId(root, 'collection-filter')).toHaveLength(0);
  });

  test("Filter opens the collection's own filter sheet", () => {
    const root = render(<CollectionScreen />);
    press(byTestId(root, 'collection-filter')[0]);
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/collection/[id]/filter', params: { id: moms } });
  });

  test("its picks filter only this screen, show on the Filter button, and go when the screen closes", () => {
    setCollectionFilters(moms, toggleRecipeFilter(noRecipeFilters(), 'meal', 'dessert'));
    const root = render(<CollectionScreen />);
    expect(rowNames(root)).toEqual(['Banana bread', 'Lemon bars']);
    expect(byTestId(root, 'collection-filter')[0].props.label).toBe('Filter · 1');
    // "N recipes" still counts the whole collection; the tab's filters are untouched.
    expect(texts(root)).toContain('3 recipes');
    expect(getRecipeFilters()).toEqual(noRecipeFilters());

    act(() => tree!.unmount());
    tree = null;
    expect(getCollectionFilters(moms)).toEqual(noRecipeFilters());
  });

  test('picks that match none say so, with Clear filters', () => {
    setCollectionFilters(moms, toggleRecipeFilter(noRecipeFilters(), 'meal', 'breakfast'));
    const root = render(<CollectionScreen />);
    expect(rowNames(root)).toEqual([]);
    press(pressable(root, 'Clear filters'));
    rerender(<CollectionScreen />);
    expect(rowNames(root)).toEqual(['Banana bread', 'Lemon bars', 'Pot roast']);
  });

  test('a deleted or unknown collection shows nothing', () => {
    mockParams.id = 'missing';
    const root = render(<CollectionScreen />);
    expect(texts(root)).toEqual([]);
  });
});

describe("a collection's filter sheet", () => {
  beforeEach(() => {
    mockParams.id = moms;
  });

  test("offers only its recipes' values, counts them, and keeps the picks for the collection, not the tab", () => {
    const root = render(<CollectionFilterSheet />);
    const all = texts(root);
    expect(all).toContain('Dessert');
    expect(all).toContain('Dinner');
    expect(all).toContain('Show 3 recipes');
    press(pressable(root, 'Dessert'));
    rerender(<CollectionFilterSheet />);
    expect(texts(root)).toContain('Show 2 recipes');
    expect(getCollectionFilters(moms).tags.meal).toEqual(['dessert']);
    expect(getRecipeFilters()).toEqual(noRecipeFilters());
  });
});
