// The Recipes tab's sort pill (spec 4.5): Recently added, A–Z and By meal's folding sections, rendered
// against the in-memory database.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, households, recipes } from '@/db';
import { ensureStarterData } from '@/features/lists/lists';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { emptyRecipeTags, type RecipeTags } from '@/shared/recipe-tags';
import { resetDb } from '@/test/db';

import RecipesScreen from '@/app/(tabs)/recipes/index';
import { AisleColors } from '@/constants/theme';
import { FoldingSection } from '@/components/section-header';

import { getFoldedMealSections, resetFoldedMealSections } from '../recipe-fold-store';
import { setRecipeFilters } from '../recipe-filter-store';
import { noRecipeFilters, toggleRecipeFilter } from '../recipe-filters';
import { RECIPE_SORT_KEY } from '../recipe-sort';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('react-native-worklets', () => ({ scheduleOnRN: (fn: (...a: unknown[]) => void, ...args: unknown[]) => fn(...args) }));
// The row's swipe as a host element: these tests don't swipe.
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const { createElement } = require('react');
  return { __esModule: true, default: ({ children }: { children?: unknown }) => createElement('Swipeable', null, children) };
});
jest.mock('expo-image', () => {
  const { createElement } = require('react');
  return { Image: (props: object) => createElement('ExpoImage', props) };
});
// Reanimated's own mock needs the native worklets module; folding only needs views and plain values.
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
// SwiftUI views as host elements; modifiers as plain records.
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
    router: { push: () => {}, back: () => {}, navigate: () => {} },
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

function remount(): ReactTestRenderer {
  act(() => tree?.unmount());
  return render();
}

/** A recipe in `householdId`, last changed `minutesAgo` minutes ago. */
function addRecipe(householdId: string, name: string, minutesAgo: number, meal: string[] = []) {
  db.insert(recipes)
    .values({
      id: name.toLowerCase().replace(/\W+/g, '-'),
      householdId,
      name,
      tags: meal.length > 0 ? ({ ...emptyRecipeTags(), meal } as RecipeTags) : null,
      updatedAt: new Date(Date.now() - minutesAgo * 60_000),
    })
    .run();
}

/** The rows' recipe names, in order (the first part of each row's VoiceOver label). */
const rowNames = (node: ReactTestInstance) =>
  node
    .findAll((n) => n.type === ('Link' as never))
    .map((l) => (l.findAll((n) => n.props.accessibilityRole === 'button')[0].props.accessibilityLabel as string).split(',')[0]);
const menu = (root: ReactTestRenderer) => root.root.find((n) => n.type === ('SwiftMenu' as never));
const toggles = (root: ReactTestRenderer) => root.root.findAll((n) => n.type === ('SwiftToggle' as never));
const choose = (root: ReactTestRenderer, label: string) =>
  act(() => toggles(root).find((t) => t.props.label === label)!.props.onIsOnChange(true));
const sections = (root: ReactTestRenderer) => root.root.findAllByType(FoldingSection);
/** Each By meal section as [title, count, names]. */
const mealSections = (root: ReactTestRenderer) =>
  sections(root).map((s) => [s.props.title as string, s.props.count as number, rowNames(s)]);
/** Every host text, in order. */
const texts = (root: ReactTestRenderer) =>
  root.root.findAll((n) => n.type === ('Text' as never)).map((n) => [n.props.children].flat().join(''));

beforeEach(() => {
  resetDb();
  ensureStarterData('user-1');
  resetFoldedMealSections();
  setRecipeFilters(noRecipeFilters());
  db.insert(households).values({ id: 'home', name: 'Home' }).run();
  addRecipe('home', 'Tacos', 1, ['dinner']);
  addRecipe('home', 'Frittata', 2, ['breakfast', 'lunch']);
  addRecipe('home', 'Apple crumble', 3, ['dessert']);
  addRecipe('home', 'Banana bread', 4);
  addRecipe('home', 'Curry', 5, ['dinner']);
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  setRecipeFilters(noRecipeFilters());
});

describe('the sort pill', () => {
  test('reads Recent by default, after Filters, with a "Sort and group" menu, Recently added ticked', () => {
    const root = render();
    const all = texts(root);
    expect(all).toContain('Recent');
    expect(all.indexOf('Filters')).toBeLessThan(all.indexOf('Recent'));
    expect(menu(root).props.modifiers).toEqual([
      { accessibilityLabel: 'Sort: Recently added' },
      { accessibilityHint: 'Changes how recipes are sorted and grouped' },
    ]);
    expect(root.root.find((n) => n.type === ('SwiftSection' as never)).props.title).toBe('Sort and group');
    expect(toggles(root).map((t) => [t.props.label, t.props.isOn])).toEqual([
      ['Recently added', true],
      ['A–Z', false],
      ['By meal', false],
    ]);
  });

  test('Recently added: newest change first, in one card with no sections', () => {
    const root = render();
    expect(rowNames(root.root)).toEqual(['Tacos', 'Frittata', 'Apple crumble', 'Banana bread', 'Curry']);
    expect(sections(root)).toHaveLength(0);
  });

  test('A–Z: by name, ticked, and saved on this device', () => {
    const root = render();
    choose(root, 'A–Z');
    expect(rowNames(root.root)).toEqual(['Apple crumble', 'Banana bread', 'Curry', 'Frittata', 'Tacos']);
    expect(texts(root)).toContain('A–Z');
    expect(menu(root).props.modifiers[0]).toEqual({ accessibilityLabel: 'Sort: A–Z' });
    expect(toggles(root).map((t) => t.props.isOn)).toEqual([false, true, false]);
    expect(getDeviceSetting(RECIPE_SORT_KEY, null)).toBe('name');
    expect(sections(root)).toHaveLength(0);
  });

  test('back to Recently added restores the order', () => {
    const root = render();
    choose(root, 'A–Z');
    choose(root, 'Recently added');
    expect(rowNames(root.root)).toEqual(['Tacos', 'Frittata', 'Apple crumble', 'Banana bread', 'Curry']);
    expect(getDeviceSetting(RECIPE_SORT_KEY, null)).toBe('recent');
  });

  test('the choice survives a remount', () => {
    let root = render();
    choose(root, 'By meal');
    root = remount();
    expect(texts(root)).toContain('By meal');
    expect(toggles(root).map((t) => t.props.isOn)).toEqual([false, false, true]);
    expect(sections(root).length).toBeGreaterThan(0);
  });

  test('a stored choice the app doesn’t know reads as Recently added', () => {
    setDeviceSetting(RECIPE_SORT_KEY, 'cuisine');
    const root = render();
    expect(texts(root)).toContain('Recent');
    expect(sections(root)).toHaveLength(0);
  });
});

describe('By meal', () => {
  test('a section per meal in facet order, a two-meal recipe in both, No meal last, A–Z inside', () => {
    setDeviceSetting(RECIPE_SORT_KEY, 'meal');
    const root = render();
    expect(mealSections(root)).toEqual([
      ['Breakfast', 1, ['Frittata']],
      ['Lunch', 1, ['Frittata']],
      ['Dinner', 2, ['Curry', 'Tacos']],
      ['Dessert', 1, ['Apple crumble']],
      ['No meal', 1, ['Banana bread']],
    ]);
    // Empty meals (Side, Snack, Drink) have no section.
    expect(mealSections(root).map(([title]) => title)).not.toContain('Side');
  });

  test('headers are tinted bands in each meal’s hue, counting recipes for VoiceOver', () => {
    setDeviceSetting(RECIPE_SORT_KEY, 'meal');
    const root = render();
    const [breakfast, , dinner, , none] = sections(root);
    expect(breakfast.props.band).toEqual({ ground: AisleColors.light.amber.soft, text: AisleColors.light.amber.strong });
    expect(dinner.props.band).toEqual({ ground: AisleColors.light.rose.soft, text: AisleColors.light.rose.strong });
    expect(none.props.band.ground).toBe(AisleColors.light.grey.soft);
    expect(dinner.props.countUnit).toEqual(['recipe', 'recipes']);
    expect(
      root.root.findAll(
        (n) => typeof n.type === 'string' && n.props.accessibilityLabel === 'Dinner, 2 recipes' && n.props.accessibilityRole === 'button',
      ),
    ).toHaveLength(1);
  });

  test('every household gets its own sections under its name', () => {
    db.insert(households).values({ id: 'lake', name: 'Lake house' }).run();
    addRecipe('lake', 'Campfire chili', 0, ['dinner']);
    setDeviceSetting(RECIPE_SORT_KEY, 'meal');
    const root = render();
    const all = texts(root);
    expect(all.indexOf('Lake house')).toBeLessThan(all.indexOf('Home'));
    expect(mealSections(root)[0]).toEqual(['Dinner', 1, ['Campfire chili']]);
    expect(mealSections(root)[3]).toEqual(['Dinner', 2, ['Curry', 'Tacos']]);
  });

  test('a section folds and opens; the fold is per household and kept across a remount and sort changes', () => {
    db.insert(households).values({ id: 'lake', name: 'Lake house' }).run();
    addRecipe('lake', 'Campfire chili', 0, ['dinner']);
    setDeviceSetting(RECIPE_SORT_KEY, 'meal');
    let root = render();
    const homeDinner = () => sections(root).filter((s) => s.props.title === 'Dinner')[1];
    const lakeDinner = () => sections(root).filter((s) => s.props.title === 'Dinner')[0];
    expect(homeDinner().props.collapsed).toBe(false);

    act(() => homeDinner().props.onToggle());
    expect(homeDinner().props.collapsed).toBe(true);
    expect(lakeDinner().props.collapsed).toBe(false);
    expect([...getFoldedMealSections()]).toEqual(['home:dinner']);
    // Its rows are hidden from VoiceOver and taps while folded.
    const clip = homeDinner().findAll((n) => n.props.accessibilityElementsHidden !== undefined && n.props.pointerEvents)[0];
    expect(clip.props.accessibilityElementsHidden).toBe(true);
    expect(clip.props.pointerEvents).toBe('none');

    root = remount();
    expect(homeDinner().props.collapsed).toBe(true);
    choose(root, 'A–Z');
    choose(root, 'By meal');
    expect(homeDinner().props.collapsed).toBe(true);

    act(() => homeDinner().props.onToggle());
    expect(homeDinner().props.collapsed).toBe(false);
    expect(getFoldedMealSections().size).toBe(0);
  });

  test('search and filters apply before grouping', () => {
    setDeviceSetting(RECIPE_SORT_KEY, 'meal');
    const root = render();
    const field = root.root.find((n) => n.type === ('TextInput' as never) && n.props.accessibilityLabel === 'Search recipes');
    act(() => field.props.onChangeText('taco'));
    expect(mealSections(root)).toEqual([['Dinner', 1, ['Tacos']]]);
    act(() => field.props.onChangeText(''));

    act(() => setRecipeFilters(toggleRecipeFilter(noRecipeFilters(), 'meal', 'lunch')));
    // The filter keeps Frittata, which still shows under both of its meals.
    expect(mealSections(root)).toEqual([
      ['Breakfast', 1, ['Frittata']],
      ['Lunch', 1, ['Frittata']],
    ]);
  });

  test('nothing matching shows "No recipes match" and no sections', () => {
    setDeviceSetting(RECIPE_SORT_KEY, 'meal');
    const root = render();
    const field = root.root.find((n) => n.type === ('TextInput' as never) && n.props.accessibilityLabel === 'Search recipes');
    act(() => field.props.onChangeText('lasagne'));
    expect(sections(root)).toHaveLength(0);
    expect(texts(root)).toContain('No recipes match');
  });
});
