// The Recipes tab's sort pill (spec 4.5): the Sort and Group by menu and the grouped folding sections,
// rendered against the in-memory database.
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
import { Card } from '@/components/card';
import { FoldingSection } from '@/components/section-header';

import { getFoldedMealSections, resetFoldedMealSections } from '../recipe-fold-store';
import { setRecipeFilters } from '../recipe-filter-store';
import { noRecipeFilters, toggleRecipeFilter } from '../recipe-filters';
import { RECIPE_PHOTO_SIZE_KEY } from '../recipe-photo-size';
import { RECIPE_GROUP_KEY, RECIPE_SORT_KEY } from '../recipe-sort';

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

/** A recipe in `householdId`, last changed `minutesAgo` minutes ago, with `meal` and any other tags. */
function addRecipe(
  householdId: string,
  name: string,
  minutesAgo: number,
  meal: string[] = [],
  { totalMinutes, ...tags }: Partial<RecipeTags> & { totalMinutes?: number } = {},
) {
  const tagged = meal.length > 0 || Object.keys(tags).length > 0;
  db.insert(recipes)
    .values({
      id: name.toLowerCase().replace(/\W+/g, '-'),
      householdId,
      name,
      tags: tagged ? ({ ...emptyRecipeTags(), meal, ...tags } as RecipeTags) : null,
      totalMinutes: totalMinutes ?? null,
      updatedAt: new Date(Date.now() - minutesAgo * 60_000),
    })
    .run();
}

/** The rows' recipe names, in order (the first part of each row's VoiceOver label). */
const rowNames = (node: ReactTestInstance) =>
  node
    .findAll((n) => n.type === ('Link' as never))
    .map((l) => (l.findAll((n) => n.props.accessibilityRole === 'button')[0].props.accessibilityLabel as string).split(',')[0]);
/** The header's sort button menu (the title's view menu is another). */
const menu = (root: ReactTestRenderer) =>
  root.root.find(
    (n) => n.type === ('SwiftMenu' as never) && n.findAll((c) => c.props.testID === 'recipes-sort' && typeof c.type === 'string').length > 0,
  );
const toggles = (root: ReactTestRenderer) => menu(root).findAll((n) => n.type === ('SwiftToggle' as never));
const choose = (root: ReactTestRenderer, label: string) =>
  act(() => toggles(root).find((t) => t.props.label === label)!.props.onIsOnChange(true));
/** Each menu section as [title, [label, icon, ticked][]]. */
const menuSections = (root: ReactTestRenderer) =>
  menu(root)
    .findAll((n) => n.type === ('SwiftSection' as never))
    .map((s) => [
      s.props.title as string,
      s.findAll((n) => n.type === ('SwiftToggle' as never)).map((t) => [t.props.label, t.props.systemImage, t.props.isOn]),
    ]);
/** The ticked items, the sort's, the grouping's, then the photo size's. */
const ticked = (root: ReactTestRenderer) => toggles(root).filter((t) => t.props.isOn).map((t) => t.props.label as string);
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

describe('the sort button', () => {
  test('Sort, Group by and Photo size sections, Recently added, None and Small photos ticked by default', () => {
    const root = render();
    expect(menu(root).props.modifiers).toEqual([
      { accessibilityLabel: 'Sort: Recently added, small photos' },
      { accessibilityHint: 'Changes how recipes are sorted and grouped' },
    ]);
    expect(menuSections(root)).toEqual([
      [
        'Sort',
        [
          ['Recently added', 'clock', true],
          ['A–Z', 'textformat', false],
        ],
      ],
      [
        'Group by',
        [
          ['None', 'list.bullet', true],
          ['Meal', 'fork.knife', false],
          ['Cuisine', 'globe.americas', false],
          ['Protein', 'fish', false],
          ['Method', 'frying.pan', false],
          ['Time', 'timer', false],
          ['Saved', 'heart', false],
        ],
      ],
      [
        'Photo size',
        [
          ['Small photos', 'list.bullet', true],
          ['Large photos', 'photo', false],
        ],
      ],
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
    expect(menu(root).props.modifiers[0]).toEqual({ accessibilityLabel: 'Sort: A–Z, small photos' });
    expect(ticked(root)).toEqual(['A–Z', 'None', 'Small photos']);
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
    choose(root, 'A–Z');
    choose(root, 'Meal');
    root = remount();
    expect(ticked(root)).toEqual(['A–Z', 'Meal', 'Small photos']);
    expect(sections(root).length).toBeGreaterThan(0);
  });

  test('a stored choice the app doesn’t know reads as Recently added', () => {
    setDeviceSetting(RECIPE_SORT_KEY, 'cuisine');
    const root = render();
    expect(ticked(root)).toEqual(['Recently added', 'None', 'Small photos']);
    expect(sections(root)).toHaveLength(0);
  });

  test('a grouping keeps the sort and a sort keeps the grouping, each saved; VoiceOver reads both', () => {
    const root = render();
    choose(root, 'Meal');
    expect(getDeviceSetting(RECIPE_SORT_KEY, null)).toBe('recent');
    expect(getDeviceSetting(RECIPE_GROUP_KEY, null)).toBe('meal');
    expect(ticked(root)).toEqual(['Recently added', 'Meal', 'Small photos']);
    expect(menu(root).props.modifiers[0]).toEqual({ accessibilityLabel: 'Sort: Recently added, grouped by meal, small photos' });
    choose(root, 'A–Z');
    expect(getDeviceSetting(RECIPE_SORT_KEY, null)).toBe('name');
    expect(getDeviceSetting(RECIPE_GROUP_KEY, null)).toBe('meal');
    expect(ticked(root)).toEqual(['A–Z', 'Meal', 'Small photos']);
    expect(menu(root).props.modifiers[0]).toEqual({ accessibilityLabel: 'Sort: A–Z, grouped by meal, small photos' });
    choose(root, 'None');
    expect(getDeviceSetting(RECIPE_SORT_KEY, null)).toBe('name');
    expect(getDeviceSetting(RECIPE_GROUP_KEY, null)).toBe('none');
    expect(menu(root).props.modifiers[0]).toEqual({ accessibilityLabel: 'Sort: A–Z, small photos' });
    expect(sections(root)).toHaveLength(0);
  });

  test('an old By meal sort opens as A–Z by meal and writes both settings back', () => {
    setDeviceSetting(RECIPE_SORT_KEY, 'meal');
    const root = render();
    expect(ticked(root)).toEqual(['A–Z', 'Meal', 'Small photos']);
    expect(mealSections(root).map(([title]) => title)).toEqual(['Breakfast', 'Lunch', 'Dinner', 'Dessert', 'No meal']);
    expect(rowNames(sections(root)[2])).toEqual(['Curry', 'Tacos']);
    expect(getDeviceSetting(RECIPE_SORT_KEY, null)).toBe('name');
    expect(getDeviceSetting(RECIPE_GROUP_KEY, null)).toBe('meal');
  });

  test('a stored Saved grouping groups the tab, Saved ticked', () => {
    setDeviceSetting(RECIPE_SORT_KEY, 'recent');
    setDeviceSetting(RECIPE_GROUP_KEY, 'saved');
    const root = render();
    expect(ticked(root)).toEqual(['Recently added', 'Saved', 'Small photos']);
    expect(mealSections(root)).toEqual([['Not saved', 5, ['Tacos', 'Frittata', 'Apple crumble', 'Banana bread', 'Curry']]]);
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
    expect([...getFoldedMealSections()]).toEqual(['home:meal:dinner']);
    // Its rows are hidden from VoiceOver and taps while folded.
    const clip = homeDinner().findAll((n) => n.props.accessibilityElementsHidden !== undefined && n.props.pointerEvents)[0];
    expect(clip.props.accessibilityElementsHidden).toBe(true);
    expect(clip.props.pointerEvents).toBe('none');

    root = remount();
    expect(homeDinner().props.collapsed).toBe(true);
    choose(root, 'Recently added');
    expect(homeDinner().props.collapsed).toBe(true);
    choose(root, 'None');
    choose(root, 'Meal');
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

describe('Group by', () => {
  // Newer than the five above: Pho, then Enchiladas, then Pad thai.
  const addCuisines = () => {
    addRecipe('home', 'Pad thai', -1, ['dinner'], { cuisine: ['thai'], totalMinutes: 30 });
    // Two Asian cuisines: in Asian once.
    addRecipe('home', 'Pho', -3, [], { cuisine: ['vietnamese', 'thai'] });
    // Two regions: in both.
    addRecipe('home', 'Enchiladas', -2, [], { cuisine: ['mexican', 'italian'] });
  };
  const rowLabel = (root: ReactTestRenderer, name: string) =>
    root.root
      .findAll((n) => n.props.accessibilityRole === 'button' && typeof n.props.accessibilityLabel === 'string')
      .map((n) => n.props.accessibilityLabel as string)
      .find((label) => label === name || label.startsWith(`${name},`));

  test('Cuisine groups by region with No cuisine last, A–Z inside; Recently added reorders within the same sections', () => {
    addCuisines();
    const root = render();
    choose(root, 'A–Z');
    choose(root, 'Cuisine');
    expect(menu(root).props.modifiers[0]).toEqual({ accessibilityLabel: 'Sort: A–Z, grouped by cuisine, small photos' });
    expect(ticked(root)).toEqual(['A–Z', 'Cuisine', 'Small photos']);
    expect(getDeviceSetting(RECIPE_GROUP_KEY, null)).toBe('cuisine');
    expect(mealSections(root)).toEqual([
      ['Latin', 1, ['Enchiladas']],
      ['European', 1, ['Enchiladas']],
      ['Asian', 2, ['Pad thai', 'Pho']],
      ['No cuisine', 5, ['Apple crumble', 'Banana bread', 'Curry', 'Frittata', 'Tacos']],
    ]);
    const [latin, european, asian, none] = sections(root);
    expect(latin.props.band).toEqual({ ground: AisleColors.light.orange.soft, text: AisleColors.light.orange.strong });
    expect(european.props.band.ground).toBe(AisleColors.light.green.soft);
    expect(asian.props.band.ground).toBe(AisleColors.light.teal.soft);
    expect(none.props.band.ground).toBe(AisleColors.light.grey.soft);

    choose(root, 'Recently added');
    expect(ticked(root)).toEqual(['Recently added', 'Cuisine', 'Small photos']);
    expect(getDeviceSetting(RECIPE_GROUP_KEY, null)).toBe('cuisine');
    expect(getDeviceSetting(RECIPE_SORT_KEY, null)).toBe('recent');
    expect(mealSections(root)).toEqual([
      ['Latin', 1, ['Enchiladas']],
      ['European', 1, ['Enchiladas']],
      ['Asian', 2, ['Pho', 'Pad thai']],
      ['No cuisine', 5, ['Tacos', 'Frittata', 'Apple crumble', 'Banana bread', 'Curry']],
    ]);
  });

  test('grouped by cuisine a row reads its cuisine in place of the meal; other groupings keep the meal', () => {
    addCuisines();
    const root = render();
    choose(root, 'Cuisine');
    expect(texts(root)).toContain('Thai · 30 min');
    expect(texts(root)).not.toContain('Dinner · 30 min');
    expect(rowLabel(root, 'Pad thai')).toBe('Pad thai, Thai, 30 min');
    // No known cuisine: just the time, or nothing.
    expect(rowLabel(root, 'Tacos')).toBe('Tacos');

    choose(root, 'Meal');
    expect(texts(root)).toContain('Dinner · 30 min');
    expect(texts(root)).not.toContain('Thai · 30 min');
    expect(rowLabel(root, 'Pad thai')).toBe('Pad thai, Dinner, 30 min');
    choose(root, 'None');
    expect(rowLabel(root, 'Pad thai')).toBe('Pad thai, Dinner, 30 min');
  });

  test('None shows the plain household card again', () => {
    const root = render();
    choose(root, 'Cuisine');
    expect(sections(root)).toHaveLength(1);
    choose(root, 'None');
    expect(sections(root)).toHaveLength(0);
    const cards = root.root.findAllByType(Card).filter((c) => rowNames(c).length > 0);
    expect(cards).toHaveLength(1);
    expect(rowNames(cards[0])).toEqual(['Tacos', 'Frittata', 'Apple crumble', 'Banana bread', 'Curry']);
    expect(ticked(root)).toEqual(['Recently added', 'None', 'Small photos']);
  });

  test('Protein, Method, Time and Saved each draw their own sections', () => {
    addRecipe('home', 'Surf and turf', -1, [], { protein: ['shellfish', 'beef'], method: ['grill'], totalMinutes: 75 });
    addRecipe('home', 'Salad', -2, [], { method: ['no-cook'], saved: ['favorite'], totalMinutes: 10 });
    const root = render();
    choose(root, 'A–Z');
    choose(root, 'Protein');
    expect(ticked(root)).toEqual(['A–Z', 'Protein', 'Small photos']);
    expect(mealSections(root).map(([title, count]) => [title, count])).toEqual([
      ['Beef', 1],
      ['Shellfish', 1],
      ['No protein', 6],
    ]);
    choose(root, 'Method');
    expect(mealSections(root).map(([title, count]) => [title, count])).toEqual([
      ['Grill', 1],
      ['No cook', 1],
      ['No method', 5],
    ]);
    choose(root, 'Time');
    expect(mealSections(root).map(([title, , names]) => [title, names])).toEqual([
      ['Under 30 min', ['Salad']],
      ['Over 1 hour', ['Surf and turf']],
      ['No time', ['Apple crumble', 'Banana bread', 'Curry', 'Frittata', 'Tacos']],
    ]);
    choose(root, 'Saved');
    expect(mealSections(root).map(([title, count]) => [title, count])).toEqual([
      ['Favorite', 1],
      ['Not saved', 6],
    ]);
  });

  test('folding a Cuisine section doesn’t fold that household’s Meal sections', () => {
    const root = render();
    choose(root, 'Cuisine');
    act(() => sections(root)[0].props.onToggle());
    expect(sections(root)[0].props.collapsed).toBe(true);
    expect([...getFoldedMealSections()]).toEqual(['home:cuisine:none']);

    choose(root, 'Meal');
    expect(sections(root).map((s) => s.props.collapsed)).toEqual([false, false, false, false, false]);
    choose(root, 'Cuisine');
    expect(sections(root)[0].props.collapsed).toBe(true);
  });

  test('large photos lay tiles under each band', () => {
    addCuisines();
    setDeviceSetting(RECIPE_PHOTO_SIZE_KEY, 'large');
    setDeviceSetting(RECIPE_GROUP_KEY, 'cuisine');
    const root = render();
    const [latin, , asian, none] = sections(root);
    expect(asian.findAll((n) => n.props.testID === 'recipe-grid' && typeof n.type === 'string')).toHaveLength(1);
    expect(none.findAll((n) => n.props.testID === 'recipe-grid' && typeof n.type === 'string')).toHaveLength(1);
    expect(rowNames(latin)).toEqual(['Enchiladas']);
    expect(rowNames(asian)).toEqual(['Pho', 'Pad thai']);
    // Tiles, not swipeable rows.
    expect(root.root.findAll((n) => n.type === ('Swipeable' as never))).toHaveLength(0);
    // The section's card sits on the screen's ground, so each tile is its own card.
    expect(root.root.findAllByType(Card).filter((c) => c.findAllByType(FoldingSection).length === 1)[0].props.background).toBe(
      'background',
    );
  });

  test('search and filters apply before grouping by cuisine', () => {
    addCuisines();
    setDeviceSetting(RECIPE_GROUP_KEY, 'cuisine');
    const root = render();
    const field = root.root.find((n) => n.type === ('TextInput' as never) && n.props.accessibilityLabel === 'Search recipes');
    act(() => field.props.onChangeText('p'));
    expect(mealSections(root).map(([title, , names]) => [title, names])).toEqual([
      ['Asian', ['Pho', 'Pad thai']],
      ['No cuisine', ['Apple crumble']],
    ]);
  });
});
