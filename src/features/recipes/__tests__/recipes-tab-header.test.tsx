// The Recipes tab's header (spec 4.5, 4.14, 4.16): the title that switches views, the round sort button whose
// menu holds the sort, the grouping and the photo size, and Filters at the end of the search field.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { listHeaderColors } from '@/components/appearance';
import { SegmentedControl } from '@/components/segmented-control';
import { Palette } from '@/constants/theme';
import { db, households, recipes } from '@/db';
import { ensureStarterData } from '@/features/lists/lists';
import { resetRecipesSegment } from '@/features/meal-plan/plan-tab';
import { getDeviceSetting, setDeviceSetting, setPlanTab } from '@/features/settings/device-settings';
import { emptyRecipeTags, type RecipeTags } from '@/shared/recipe-tags';
import { resetDb } from '@/test/db';

import RecipesScreen from '@/app/(tabs)/recipes/index';

import { resetFoldedMealSections } from '../recipe-fold-store';
import { getRecipeFilters, setRecipeFilters } from '../recipe-filter-store';
import { noRecipeFilters, toggleRecipeFilter } from '../recipe-filters';
import { RECIPE_PHOTO_SIZE_KEY } from '../recipe-photo-size';
import { RECIPE_GROUP_KEY, RECIPE_SORT_KEY } from '../recipe-sort';

const mockPush = jest.fn();
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
jest.mock('@/features/recipes/share-drain', () => ({ onShareImports: () => () => {}, removeQueuedShare: () => {} }));
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
  return {
    Link,
    Stack: { Screen: () => null, Toolbar: Object.assign(passThrough(), { Button: host('ToolbarButton') }) },
    router: { push: (...args: unknown[]) => mockPush(...args), back: () => {}, navigate: () => {} },
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
    useLocalSearchParams: () => ({}),
    usePathname: () => '/recipes',
  };
});
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
let tree: ReactTestRenderer | null = null;

function render(): ReactTestRenderer {
  act(() => {
    tree = create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <RecipesScreen />
      </SafeAreaProvider>,
    );
  });
  return tree!;
}

function addRecipe(name: string, minutesAgo: number, tags: Partial<RecipeTags> = {}) {
  db.insert(recipes)
    .values({
      id: name.toLowerCase().replace(/\W+/g, '-'),
      householdId: 'home',
      name,
      tags: { ...emptyRecipeTags(), ...tags } as RecipeTags,
      updatedAt: new Date(Date.now() - minutesAgo * 60_000),
    })
    .run();
}

/** A style (or a Pressable's style function, not pressed) as one object. */
const flat = (style: unknown): Record<string, unknown> =>
  Object.assign(
    {},
    ...[typeof style === 'function' ? style({ pressed: false }) : style].flat(Infinity).filter(Boolean),
  );
const hostByTestID = (root: ReactTestRenderer, id: string) =>
  root.root.findAll((n) => typeof n.type === 'string' && n.props.testID === id);
const texts = (node: ReactTestInstance) =>
  node.findAll((n) => n.type === ('Text' as never)).map((n) => [n.props.children].flat().join(''));
/** The SwiftMenu whose label holds the view with `testID`. */
const menuWith = (root: ReactTestRenderer, testID: string) =>
  root.root.findAll(
    (n) => n.type === ('SwiftMenu' as never) && n.findAll((c) => typeof c.type === 'string' && c.props.testID === testID).length > 0,
  );
const viewMenu = (root: ReactTestRenderer) => menuWith(root, 'recipes-view-title');
const sortMenu = (root: ReactTestRenderer) => menuWith(root, 'recipes-sort');
const items = (menu: ReactTestInstance) => menu.findAll((n) => n.type === ('SwiftToggle' as never));
const pick = (menu: ReactTestInstance, label: string) =>
  act(() => items(menu).find((t) => t.props.label === label)!.props.onIsOnChange(true));
const searchFields = (root: ReactTestRenderer) =>
  root.root.findAll((n) => n.type === ('TextInput' as never) && n.props.accessibilityLabel === 'Search recipes');
/** The Filters button's Pressable. */
const filtersButton = (root: ReactTestRenderer) =>
  root.root.find((n) => typeof n.type !== 'string' && n.props.testID === 'recipes-filters' && typeof n.props.onPress === 'function');
const filtersHost = (root: ReactTestRenderer) => hostByTestID(root, 'recipes-filters')[0];

beforeEach(() => {
  resetDb();
  ensureStarterData('user-1');
  resetFoldedMealSections();
  resetRecipesSegment();
  setPlanTab(false);
  setRecipeFilters(noRecipeFilters());
  mockPush.mockClear();
  db.insert(households).values({ id: 'home', name: 'Home' }).run();
  addRecipe('Tacos', 1, { meal: ['dinner'], cuisine: ['mexican'] });
  addRecipe('Pancakes', 2, { meal: ['breakfast'] });
  addRecipe('Curry', 3, { meal: ['dinner'], cuisine: ['indian'] });
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  setRecipeFilters(noRecipeFilters());
  resetRecipesSegment();
});

describe('the title, with the Plan tab off', () => {
  test('is the view switcher: "Recipes" and a chevron, no segmented control', () => {
    const root = render();
    expect(root.root.findAllByType(SegmentedControl)).toHaveLength(0);
    const [menu] = viewMenu(root);
    expect(viewMenu(root)).toHaveLength(1);
    const title = hostByTestID(root, 'recipes-view-title')[0];
    expect(texts(title)).toEqual(['Recipes']);
    const name = title.find((n) => n.type === ('Text' as never));
    expect(name.props.numberOfLines).toBe(1);
    expect(title.find((n) => n.type === ('Icon' as never)).props).toMatchObject({ name: 'chevron.down', color: 'onHeaderSecondary' });
    expect(flat(title.props.style).minHeight).toBe(44);
    expect(menu.props.modifiers).toEqual([{ accessibilityLabel: 'Recipes, switch view' }]);
    expect(items(menu).map((t) => [t.props.label, t.props.systemImage, t.props.isOn])).toEqual([
      ['All recipes', 'book', true],
      ['This week', 'calendar', false],
    ]);
  });

  test('This week from its menu: the title reads "This week", with no search and no sort button', () => {
    const root = render();
    expect(searchFields(root)).toHaveLength(1);
    expect(sortMenu(root)).toHaveLength(1);
    pick(viewMenu(root)[0], 'This week');
    expect(texts(hostByTestID(root, 'recipes-view-title')[0])).toEqual(['This week']);
    expect(viewMenu(root)[0].props.modifiers).toEqual([{ accessibilityLabel: 'This week, switch view' }]);
    expect(items(viewMenu(root)[0]).map((t) => t.props.isOn)).toEqual([false, true]);
    expect(searchFields(root)).toHaveLength(0);
    expect(sortMenu(root)).toHaveLength(0);
    expect(hostByTestID(root, 'recipes-filters')).toHaveLength(0);
    expect(hostByTestID(root, 'week-toolbar')).toHaveLength(1);
    // The + stays.
    expect(hostByTestID(root, 'recipes-add')).toHaveLength(1);

    pick(viewMenu(root)[0], 'All recipes');
    expect(texts(hostByTestID(root, 'recipes-view-title')[0])).toEqual(['Recipes']);
    expect(searchFields(root)).toHaveLength(1);
    expect(sortMenu(root)).toHaveLength(1);
  });
});

test('with the Plan tab on, the title is plain "Recipes": no chevron, no menu', () => {
  setPlanTab(true);
  const root = render();
  expect(viewMenu(root)).toHaveLength(0);
  const header = root.root.find((n) => n.type === ('Text' as never) && n.props.accessibilityRole === 'header');
  expect(header.props.children).toBe('Recipes');
  expect(root.root.findAll((n) => n.type === ('Icon' as never) && n.props.name === 'chevron.down')).toHaveLength(0);
  expect(root.root.findAllByType(SegmentedControl)).toHaveLength(0);
});

describe('the sort button', () => {
  test('a 44 pt round white-wash button with arrow.up.arrow.down, between the title and the +', () => {
    const root = render();
    const button = hostByTestID(root, 'recipes-sort')[0];
    const light = Palette.light;
    expect(flat(button.props.style)).toMatchObject({
      width: 44,
      height: 44,
      borderRadius: 999,
      backgroundColor: listHeaderColors(light).viewButton.fill,
    });
    expect(button.find((n) => n.type === ('Icon' as never)).props).toMatchObject({ name: 'arrow.up.arrow.down', tint: light.onHeader });
    // Title, then the sort button, then the +.
    const order = root.root
      .findAll((n) => typeof n.type === 'string' && /^recipes-(view-title|sort|add)$/.test(n.props.testID ?? ''))
      .map((n) => n.props.testID);
    expect(order).toEqual(['recipes-view-title', 'recipes-sort', 'recipes-add']);
  });

  test('Sort, Group by and Photo size sections ticked from the settings; VoiceOver reads all three', () => {
    setDeviceSetting(RECIPE_SORT_KEY, 'name');
    setDeviceSetting(RECIPE_GROUP_KEY, 'cuisine');
    setDeviceSetting(RECIPE_PHOTO_SIZE_KEY, 'large');
    const root = render();
    const [menu] = sortMenu(root);
    expect(
      menu.findAll((n) => n.type === ('SwiftSection' as never)).map((s) => [s.props.title, items(s).filter((t) => t.props.isOn).map((t) => t.props.label)]),
    ).toEqual([
      ['Sort', ['A–Z']],
      ['Group by', ['Cuisine']],
      ['Photo size', ['Large photos']],
    ]);
    expect(menu.props.modifiers).toEqual([
      { accessibilityLabel: 'Sort: A–Z, grouped by cuisine, large photos' },
      { accessibilityHint: 'Changes how recipes are sorted and grouped' },
    ]);
  });

  test('Large photos switches the layout to the grid and is saved; Small photos goes back to rows', () => {
    const root = render();
    expect(hostByTestID(root, 'recipe-grid')).toHaveLength(0);
    pick(sortMenu(root)[0], 'Large photos');
    expect(hostByTestID(root, 'recipe-grid')).toHaveLength(1);
    expect(getDeviceSetting(RECIPE_PHOTO_SIZE_KEY, null)).toBe('large');
    expect(sortMenu(root)[0].props.modifiers[0]).toEqual({ accessibilityLabel: 'Sort: Recently added, large photos' });
    pick(sortMenu(root)[0], 'Small photos');
    expect(hostByTestID(root, 'recipe-grid')).toHaveLength(0);
    expect(getDeviceSetting(RECIPE_PHOTO_SIZE_KEY, null)).toBe('small');
  });

  test('a photo size keeps the sort and grouping', () => {
    const root = render();
    pick(sortMenu(root)[0], 'A–Z');
    pick(sortMenu(root)[0], 'Meal');
    pick(sortMenu(root)[0], 'Large photos');
    expect(items(sortMenu(root)[0]).filter((t) => t.props.isOn).map((t) => t.props.label)).toEqual(['A–Z', 'Meal', 'Large photos']);
    expect(getDeviceSetting(RECIPE_SORT_KEY, null)).toBe('name');
    expect(getDeviceSetting(RECIPE_GROUP_KEY, null)).toBe('meal');
  });

  test('hidden with no recipes', () => {
    db.delete(recipes).run();
    const root = render();
    expect(sortMenu(root)).toHaveLength(0);
    expect(hostByTestID(root, 'recipes-filters')).toHaveLength(0);
    expect(hostByTestID(root, 'recipes-add')).toHaveLength(1);
  });
});

describe('Filters in the search field', () => {
  test('after a 1 pt hairline at the field’s end: a clear glyph, no count, while no filters are on', () => {
    const root = render();
    // In the field, after the text input: the hairline, then the button.
    const order = root.root
      .findAll(
        (n) =>
          typeof n.type === 'string' &&
          (n.props.testID === 'recipes-search-divider' || n.props.testID === 'recipes-filters' || n.props.accessibilityLabel === 'Search recipes'),
      )
      .map((n) => n.props.testID ?? n.props.accessibilityLabel);
    expect(order).toEqual(['Search recipes', 'recipes-search-divider', 'recipes-filters']);
    const divider = hostByTestID(root, 'recipes-search-divider')[0];
    expect(flat(divider.props.style)).toMatchObject({ width: 1, height: 22 });
    const button = filtersButton(root);
    expect(button.props.accessibilityLabel).toBe('Filters');
    expect(button.props.accessibilityHint).toBe('Opens the filters.');
    expect(flat(filtersHost(root).props.style)).toMatchObject({ minWidth: 44, minHeight: 44 });
    expect(texts(filtersHost(root))).toEqual([]);
    expect(filtersHost(root).find((n) => n.type === ('Icon' as never)).props).toMatchObject({
      name: 'line.3.horizontal.decrease',
      tint: Palette.light.onHeader,
    });
    const pill = filtersHost(root).children[0] as ReactTestInstance;
    expect(flat(pill.props.style).backgroundColor).toBeUndefined();
  });

  test('with two filters: a filled onHeader pill with "2", VoiceOver "Filters, 2 active"', () => {
    const root = render();
    act(() => setRecipeFilters(toggleRecipeFilter(toggleRecipeFilter(noRecipeFilters(), 'meal', 'dinner'), 'cuisine', 'indian')));
    expect(texts(filtersHost(root))).toEqual(['2']);
    expect(filtersButton(root).props.accessibilityLabel).toBe('Filters, 2 active');
    const light = Palette.light;
    const pill = filtersHost(root).children[0] as ReactTestInstance;
    expect(flat(pill.props.style)).toMatchObject({ backgroundColor: light.onHeader, borderRadius: 9, minHeight: 36 });
    expect(filtersHost(root).find((n) => n.type === ('Icon' as never)).props.tint).toBe(light.header);
    const count = filtersHost(root).find((n) => n.type === ('Text' as never));
    expect(flat(count.props.style)).toMatchObject({ color: light.header, fontWeight: '700' });
  });

  test('opens the Filters sheet with the search text', () => {
    const root = render();
    act(() => searchFields(root)[0].props.onChangeText('taco'));
    act(() => filtersButton(root).props.onPress());
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipes/filter', params: { q: 'taco' } });
  });

  test('no "N recipes" in the header, and no Filters pill beside the sort', () => {
    const root = render();
    const all = texts(root.root);
    expect(all).not.toContain('3 recipes');
    expect(all).not.toContain('Filters');
    expect(all).not.toContain('Recent');
    expect(searchFields(root)[0].props.placeholder).toBe('Search 3 recipes');
  });
});

describe('Clear after the chips', () => {
  const clear = (root: ReactTestRenderer) =>
    root.root.findAll((n) => typeof n.type !== 'string' && n.props.label === 'Clear' && typeof n.props.onPress === 'function');

  test('none without chips', () => {
    const root = render();
    expect(clear(root)).toHaveLength(0);
  });

  test('a plain primary Clear ends the chips, VoiceOver "Clear filters", and clears every filter', () => {
    const root = render();
    act(() => setRecipeFilters(toggleRecipeFilter(toggleRecipeFilter(noRecipeFilters(), 'meal', 'dinner'), 'cuisine', 'indian')));
    const [button] = clear(root);
    expect(button.props.variant).toBe('plain');
    const host = button.find((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'button');
    expect(host.props.accessibilityLabel).toBe('Clear filters');
    expect(button.find((n) => n.type === ('Text' as never)).props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ color: Palette.light.primary })]),
    );
    // Last in the chips' row.
    const row = button.parent!;
    expect(row.children.at(-1)).toBe(button);
    expect(
      row
        .findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'button')
        .map((n) => n.props.accessibilityLabel),
    ).toEqual(['Remove Dinner filter', 'Remove Indian filter', 'Clear filters']);

    act(() => button.props.onPress());
    expect(getRecipeFilters()).toEqual(noRecipeFilters());
    expect(clear(root)).toHaveLength(0);
    expect(texts(filtersHost(root))).toEqual([]);
  });
});
