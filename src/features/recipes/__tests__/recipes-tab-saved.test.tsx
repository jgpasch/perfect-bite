// Favorite and Want to try on the Recipes tab (spec 4.5, 4.14): the row's heart and bookmark, its VoiceOver
// label, and the long-press menu's Favorite / Unfavorite and Want to try / Tried it, rendered against the
// in-memory database.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, households, recipes } from '@/db';
import { ensureStarterData } from '@/features/lists/lists';
import { setDeviceSetting } from '@/features/settings/device-settings';
import { type RecipeTags } from '@/shared/recipe-tags';
import { resetDb } from '@/test/db';

import RecipesScreen from '@/app/(tabs)/recipes/index';

import { resetFoldedMealSections } from '../recipe-fold-store';
import { setRecipeFilters } from '../recipe-filter-store';
import { noRecipeFilters, toggleRecipeFilter } from '../recipe-filters';
import { RECIPE_PHOTO_SIZE_KEY } from '../recipe-photo-size';
import { getRecipe } from '../recipes';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => {
  const { createElement } = require('react');
  return { Icon: (props: object) => createElement('Icon', props) };
});
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
  act(() => tree?.unmount());
  act(() => {
    tree = create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <RecipesScreen />
      </SafeAreaProvider>,
    );
  });
  return tree!;
}

/** A recipe stored with exactly these tags (null = never tagged), so unknown slugs can be stored too. */
function addRecipe(name: string, tags: Partial<RecipeTags> | null, minutesAgo = 1) {
  const id = name.toLowerCase().replace(/\W+/g, '-');
  db.insert(recipes)
    .values({
      id,
      householdId: 'home',
      name,
      tags: tags as RecipeTags | null,
      totalMinutes: 35,
      updatedAt: new Date(Date.now() - minutesAgo * 60_000),
    })
    .run();
  return id;
}

const card = (root: ReactTestRenderer, id: string) =>
  root.root.find((n) => n.type === ('Link' as never) && n.props.href.params.id === id);
const label = (node: ReactTestInstance) =>
  node.findAll((n) => n.props.accessibilityRole === 'button')[0].props.accessibilityLabel as string;
/** The heart and bookmark after the name, as [symbol, colour token]. */
const marks = (node: ReactTestInstance) =>
  node
    .findAll((n) => n.type === ('Icon' as never) && ['heart.fill', 'bookmark'].includes(n.props.name))
    .map((n) => [n.props.name, n.props.color]);
const menu = (root: ReactTestRenderer, id: string) => card(root, id).findAll((n) => n.type === ('LinkMenuAction' as never));
const action = (root: ReactTestRenderer, id: string, title: string) => menu(root, id).find((a) => a.props.title === title)!;
const choose = (root: ReactTestRenderer, id: string, title: string) => act(() => action(root, id, title).props.onPress());
const rowNames = (root: ReactTestRenderer) =>
  root.root.findAll((n) => n.type === ('Link' as never)).map((l) => label(l).split(',')[0]);

const EMPTY = { saved: [], meal: [], cuisine: [], protein: [], diet: [], method: [] };

beforeEach(() => {
  resetDb();
  ensureStarterData('user-1');
  resetFoldedMealSections();
  setRecipeFilters(noRecipeFilters());
  setDeviceSetting(RECIPE_PHOTO_SIZE_KEY, 'small');
  db.insert(households).values({ id: 'home', name: 'Home' }).run();
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  setRecipeFilters(noRecipeFilters());
});

describe('a row with Saved marks', () => {
  const combos: [string[], string[][], string][] = [
    [[], [], 'Tacos, Dinner, 35 min'],
    [['favorite'], [['heart.fill', 'primary']], 'Tacos, Favorite, Dinner, 35 min'],
    [['want-to-try'], [['bookmark', 'inkSecondary']], 'Tacos, Want to try, Dinner, 35 min'],
    [
      ['want-to-try', 'favorite'],
      [
        ['heart.fill', 'primary'],
        ['bookmark', 'inkSecondary'],
      ],
      'Tacos, Favorite, Want to try, Dinner, 35 min',
    ],
  ];

  test.each(combos)('saved %j: icons %j after the name, VoiceOver "%s"', (saved, icons, voiceOver) => {
    const id = addRecipe('Tacos', { ...EMPTY, saved, meal: ['dinner'] });
    const root = render();
    expect(marks(card(root, id))).toEqual(icons);
    expect(label(card(root, id))).toBe(voiceOver);
    // Right after the name, before the meta line, and small.
    const order = card(root, id)
      .findAll((n) => n.type === ('Text' as never) || n.type === ('Icon' as never))
      .map((n) => (n.type === ('Icon' as never) ? n.props.name : [n.props.children].flat().join('')))
      .filter((s) => s !== 'fork.knife');
    expect(order).toEqual(['Tacos', ...icons.map(([name]) => name), 'Dinner · 35 min']);
    for (const [name] of icons) {
      expect(card(root, id).find((n) => n.type === ('Icon' as never) && n.props.name === name).props.size).toBe(12);
    }
  });

  test('an untagged recipe and one with only an unknown saved slug show no marks', () => {
    const plain = addRecipe('Dal', null);
    const odd = addRecipe('Soup', { ...EMPTY, saved: ['cooked-it'] }, 2);
    const root = render();
    expect(marks(card(root, plain))).toEqual([]);
    expect(label(card(root, plain))).toBe('Dal, 35 min');
    expect(marks(card(root, odd))).toEqual([]);
    expect(label(card(root, odd))).toBe('Soup, 35 min');
  });

  test('a large tile shows the same marks and label', () => {
    setDeviceSetting(RECIPE_PHOTO_SIZE_KEY, 'large');
    const id = addRecipe('Tacos', { ...EMPTY, saved: ['favorite', 'want-to-try'], meal: ['dinner'] });
    const root = render();
    expect(root.root.findAll((n) => n.props.testID === 'recipe-grid').length).toBeGreaterThan(0);
    expect(marks(card(root, id))).toEqual([
      ['heart.fill', 'primary'],
      ['bookmark', 'inkSecondary'],
    ]);
    expect(label(card(root, id))).toBe('Tacos, Favorite, Want to try, Dinner, 35 min');
  });
});

describe('the long-press menu', () => {
  test('reads Favorite and Want to try, then Unfavorite and Tried it once set, before Rename', () => {
    const plain = addRecipe('Dal', null);
    const both = addRecipe('Tacos', { ...EMPTY, saved: ['favorite', 'want-to-try'] }, 2);
    const root = render();
    expect(menu(root, plain).map((a) => [a.props.title, a.props.icon])).toEqual([
      ['Plan…', 'calendar'],
      ['Favorite', 'heart'],
      ['Want to try', 'bookmark'],
      ['Rename', 'pencil'],
      ['Delete', 'trash'],
    ]);
    expect(menu(root, both).map((a) => [a.props.title, a.props.icon])).toEqual([
      ['Plan…', 'calendar'],
      ['Unfavorite', 'heart.slash'],
      ['Tried it', 'checkmark'],
      ['Rename', 'pencil'],
      ['Delete', 'trash'],
    ]);
  });

  test('Favorite adds only its slug and keeps every other stored slug, unknown ones too', () => {
    const stored = {
      saved: ['want-to-try', 'cooked-it'],
      meal: ['dinner', 'brunch'],
      cuisine: ['mexican'],
      protein: ['chicken'],
      diet: [],
      method: ['campfire'],
    };
    const id = addRecipe('Tacos', stored);
    choose(render(), id, 'Favorite');
    expect(getRecipe(id)).toMatchObject({
      tags: { ...stored, saved: ['want-to-try', 'cooked-it', 'favorite'] },
      tagsEdited: true,
      totalMinutes: 35,
    });
  });

  test('Unfavorite removes only favorite', () => {
    const stored = { ...EMPTY, saved: ['favorite', 'want-to-try', 'cooked-it'], meal: ['brunch'] };
    const id = addRecipe('Tacos', stored);
    choose(render(), id, 'Unfavorite');
    expect(getRecipe(id)!.tags).toEqual({ ...stored, saved: ['want-to-try', 'cooked-it'] });
    expect(getRecipe(id)!.tagsEdited).toBe(true);
  });

  test('Want to try adds only want-to-try; Tried it removes only it', () => {
    const stored = { ...EMPTY, saved: ['favorite'], cuisine: ['italian', 'martian'] };
    const id = addRecipe('Pasta', stored);
    choose(render(), id, 'Want to try');
    expect(getRecipe(id)!.tags).toEqual({ ...stored, saved: ['favorite', 'want-to-try'] });
    choose(render(), id, 'Tried it');
    expect(getRecipe(id)!.tags).toEqual(stored);
    expect(getRecipe(id)!.tagsEdited).toBe(true);
  });

  test('on an untagged recipe, each creates the tags with only saved set', () => {
    const dal = addRecipe('Dal', null);
    const soup = addRecipe('Soup', null, 2);
    const root = render();
    choose(root, dal, 'Favorite');
    choose(root, soup, 'Want to try');
    expect(getRecipe(dal)).toMatchObject({ tags: { ...EMPTY, saved: ['favorite'] }, tagsEdited: true });
    expect(getRecipe(soup)).toMatchObject({ tags: { ...EMPTY, saved: ['want-to-try'] }, tagsEdited: true });
  });

  test('a value stored before Saved existed gains the saved key and keeps the rest', () => {
    const older = { meal: ['dinner'], cuisine: [], protein: [], diet: [], method: [] };
    const id = addRecipe('Tacos', older);
    choose(render(), id, 'Want to try');
    expect(getRecipe(id)!.tags).toEqual({ ...older, saved: ['want-to-try'] });
  });

  test('once marked, the row shows it and the Favorite filter finds it', () => {
    const tacos = addRecipe('Tacos', { ...EMPTY, meal: ['dinner'] });
    addRecipe('Dal', null, 2);
    choose(render(), tacos, 'Favorite');
    let root = render();
    expect(marks(card(root, tacos))).toEqual([['heart.fill', 'primary']]);
    expect(label(card(root, tacos))).toBe('Tacos, Favorite, Dinner, 35 min');
    expect(menu(root, tacos)[1].props.title).toBe('Unfavorite');
    setRecipeFilters(toggleRecipeFilter(noRecipeFilters(), 'saved', 'favorite'));
    root = render();
    expect(rowNames(root)).toEqual(['Tacos']);
  });
});
