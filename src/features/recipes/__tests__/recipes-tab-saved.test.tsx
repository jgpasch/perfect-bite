// Favorite and Want to try on the Recipes tab (spec 4.5, 4.14): the row's heart and bookmark, its VoiceOver
// label, and the long-press menu's Favorite / Unfavorite and Want to try / Tried it, rendered against the
// in-memory database. Favorites are per person (`recipe_favorites`); Want to try is a Saved tag.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { and, eq } from 'drizzle-orm';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, householdMemberNames, households, recipeFavorites, recipes } from '@/db';
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
jest.mock('@/features/recipes/share-reconcile', () => ({ removeQueuedShare: () => false, retryShareImport: async () => true }));
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
    .findAll((n) => n.type === ('Icon' as never) && ['heart.fill', 'heart', 'bookmark'].includes(n.props.name))
    .map((n) => [n.props.name, n.props.color]);
const menu = (root: ReactTestRenderer, id: string) => card(root, id).findAll((n) => n.type === ('LinkMenuAction' as never));
const action = (root: ReactTestRenderer, id: string, title: string) => menu(root, id).find((a) => a.props.title === title)!;
const choose = (root: ReactTestRenderer, id: string, title: string) => act(() => action(root, id, title).props.onPress());
const rowNames = (root: ReactTestRenderer) =>
  root.root.findAll((n) => n.type === ('Link' as never)).map((l) => label(l).split(',')[0]);

const EMPTY = { saved: [], meal: [], cuisine: [], protein: [], diet: [], method: [] };

/** `userId`'s live favorite row for the recipe, as a pull would bring it. */
const favorite = (recipeId: string, userId = 'user-1') =>
  db.insert(recipeFavorites).values({ recipeId, userId, householdId: 'home' }).run();
const favoriteRow = (recipeId: string, userId = 'user-1') =>
  db
    .select()
    .from(recipeFavorites)
    .where(and(eq(recipeFavorites.recipeId, recipeId), eq(recipeFavorites.userId, userId)))
    .get();

beforeEach(() => {
  resetDb();
  ensureStarterData('user-1');
  resetFoldedMealSections();
  setRecipeFilters(noRecipeFilters());
  setDeviceSetting(RECIPE_PHOTO_SIZE_KEY, 'small');
  db.insert(households).values({ id: 'home', name: 'Home' }).run();
  db.insert(householdMemberNames)
    .values([
      { householdId: 'home', userId: 'user-1', firstName: 'Jo', lastName: 'Doe', joinedAt: '2026-10-01T00:00:00Z' },
      { householdId: 'home', userId: 'user-2', firstName: 'Sam', lastName: 'Lee', joinedAt: '2026-10-02T00:00:00Z' },
      { householdId: 'home', userId: 'user-3', firstName: 'Ana', lastName: 'Ruiz', joinedAt: '2026-10-03T00:00:00Z' },
      { householdId: 'home', userId: 'user-4', firstName: 'Bo', lastName: 'Chen', joinedAt: '2026-10-04T00:00:00Z' },
    ])
    .run();
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  setRecipeFilters(noRecipeFilters());
});

describe('a row with Saved marks', () => {
  // [saved tags, whose favorites, icons after the name, VoiceOver]
  const combos: [string[], string[], string[][], string][] = [
    [[], [], [], 'Tacos, Dinner, 35 min'],
    [[], ['user-1'], [['heart.fill', 'primary']], 'Tacos, Your favorite, Dinner, 35 min'],
    // Mine wins over others': still the filled heart and "Your favorite".
    [[], ['user-1', 'user-2'], [['heart.fill', 'primary']], 'Tacos, Your favorite, Dinner, 35 min'],
    [[], ['user-2'], [['heart', 'inkSecondary']], "Tacos, Sam's favorite, Dinner, 35 min"],
    [[], ['user-2', 'user-3'], [['heart', 'inkSecondary']], 'Tacos, Favorite of Ana and Sam, Dinner, 35 min'],
    [[], ['user-2', 'user-3', 'user-4'], [['heart', 'inkSecondary']], 'Tacos, Favorite of Ana and 2 others, Dinner, 35 min'],
    [['want-to-try'], [], [['bookmark', 'inkSecondary']], 'Tacos, Want to try, Dinner, 35 min'],
    [
      ['want-to-try'],
      ['user-1'],
      [
        ['heart.fill', 'primary'],
        ['bookmark', 'inkSecondary'],
      ],
      'Tacos, Your favorite, Want to try, Dinner, 35 min',
    ],
    [
      ['want-to-try'],
      ['user-2'],
      [
        ['heart', 'inkSecondary'],
        ['bookmark', 'inkSecondary'],
      ],
      "Tacos, Sam's favorite, Want to try, Dinner, 35 min",
    ],
    // An old stored `favorite` slug is ignored for display.
    [['favorite'], [], [], 'Tacos, Dinner, 35 min'],
    // Someone no longer in the household counts for nothing.
    [[], ['user-9'], [], 'Tacos, Dinner, 35 min'],
  ];

  test.each(combos)('saved %j, favorites of %j: icons %j after the name, VoiceOver "%s"', (saved, users, icons, voiceOver) => {
    const id = addRecipe('Tacos', { ...EMPTY, saved, meal: ['dinner'] });
    for (const user of users) favorite(id, user);
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
    const id = addRecipe('Tacos', { ...EMPTY, saved: ['want-to-try'], meal: ['dinner'] });
    favorite(id);
    const root = render();
    expect(root.root.findAll((n) => n.props.testID === 'recipe-grid').length).toBeGreaterThan(0);
    expect(marks(card(root, id))).toEqual([
      ['heart.fill', 'primary'],
      ['bookmark', 'inkSecondary'],
    ]);
    expect(label(card(root, id))).toBe('Tacos, Your favorite, Want to try, Dinner, 35 min');
  });

  test('a large tile shows the outlined heart for only another member’s favorite', () => {
    setDeviceSetting(RECIPE_PHOTO_SIZE_KEY, 'large');
    const id = addRecipe('Tacos', { ...EMPTY, meal: ['dinner'] });
    favorite(id, 'user-2');
    const root = render();
    expect(marks(card(root, id))).toEqual([['heart', 'inkSecondary']]);
    expect(card(root, id).find((n) => n.type === ('Icon' as never) && n.props.name === 'heart').props.size).toBe(12);
    expect(label(card(root, id))).toBe("Tacos, Sam's favorite, Dinner, 35 min");
  });
});

describe('the long-press menu', () => {
  test('reads Favorite and Want to try, then Unfavorite and Tried it once set, before Rename', () => {
    const plain = addRecipe('Dal', null);
    const both = addRecipe('Tacos', { ...EMPTY, saved: ['want-to-try'] }, 2);
    favorite(both);
    const root = render();
    expect(menu(root, plain).map((a) => [a.props.title, a.props.icon])).toEqual([
      ['Plan…', 'calendar'],
      ['Favorite', 'heart'],
      ['Want to try', 'bookmark'],
      ['Add to collection…', 'rectangle.stack'],
      ['Select', 'checkmark.circle'],
      ['Rename', 'pencil'],
      ['Delete', 'trash'],
    ]);
    expect(menu(root, both).map((a) => [a.props.title, a.props.icon])).toEqual([
      ['Plan…', 'calendar'],
      ['Unfavorite', 'heart.slash'],
      ['Tried it', 'checkmark'],
      ['Add to collection…', 'rectangle.stack'],
      ['Select', 'checkmark.circle'],
      ['Rename', 'pencil'],
      ['Delete', 'trash'],
    ]);
  });

  test('Favorite sets only the user’s favorite and leaves the stored tags alone', () => {
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
    expect(favoriteRow(id)).toMatchObject({ householdId: 'home', deletedAt: null });
    expect(getRecipe(id)).toMatchObject({ tags: stored, tagsEdited: false, totalMinutes: 35 });
  });

  test('another member’s favorite still offers Favorite; Unfavorite leaves theirs', () => {
    const id = addRecipe('Tacos', { ...EMPTY, meal: ['dinner'] });
    favorite(id, 'user-2');
    let root = render();
    expect(action(root, id, 'Favorite').props.icon).toBe('heart');
    choose(root, id, 'Favorite');
    expect(favoriteRow(id)!.deletedAt).toBeNull();
    expect(favoriteRow(id, 'user-2')!.deletedAt).toBeNull();
    root = render();
    expect(marks(card(root, id))).toEqual([['heart.fill', 'primary']]);
    choose(root, id, 'Unfavorite');
    expect(favoriteRow(id)!.deletedAt).toBeInstanceOf(Date);
    expect(favoriteRow(id, 'user-2')!.deletedAt).toBeNull();
    // Back to the outlined heart for Sam's.
    root = render();
    expect(marks(card(root, id))).toEqual([['heart', 'inkSecondary']]);
    expect(label(card(root, id))).toBe("Tacos, Sam's favorite, Dinner, 35 min");
    expect(action(root, id, 'Favorite')).toBeDefined();
  });

  test('an old stored `favorite` slug isn’t the user’s favorite, and is kept when Want to try saves', () => {
    const stored = { ...EMPTY, saved: ['favorite'], meal: ['brunch'] };
    const id = addRecipe('Tacos', stored);
    const root = render();
    expect(action(root, id, 'Favorite')).toBeDefined();
    choose(root, id, 'Want to try');
    expect(getRecipe(id)!.tags).toEqual({ ...stored, saved: ['favorite', 'want-to-try'] });
    expect(favoriteRow(id)).toBeUndefined();
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

  test('on an untagged recipe, Want to try creates the tags with only saved set; Favorite leaves them untagged', () => {
    const dal = addRecipe('Dal', null);
    const soup = addRecipe('Soup', null, 2);
    const root = render();
    choose(root, dal, 'Favorite');
    choose(root, soup, 'Want to try');
    expect(getRecipe(dal)).toMatchObject({ tags: null, tagsEdited: false });
    expect(favoriteRow(dal)!.deletedAt).toBeNull();
    expect(getRecipe(soup)).toMatchObject({ tags: { ...EMPTY, saved: ['want-to-try'] }, tagsEdited: true });
  });

  test('a value stored before Saved existed gains the saved key and keeps the rest', () => {
    const older = { meal: ['dinner'], cuisine: [], protein: [], diet: [], method: [] };
    const id = addRecipe('Tacos', older);
    choose(render(), id, 'Want to try');
    expect(getRecipe(id)!.tags).toEqual({ ...older, saved: ['want-to-try'] });
  });

  test('once marked, the row shows it and the Favorites and My favorites filters find it', () => {
    const tacos = addRecipe('Tacos', { ...EMPTY, meal: ['dinner'] });
    const soup = addRecipe('Soup', null, 2);
    addRecipe('Dal', null, 3);
    favorite(soup, 'user-2');
    choose(render(), tacos, 'Favorite');
    let root = render();
    expect(marks(card(root, tacos))).toEqual([['heart.fill', 'primary']]);
    expect(menu(root, tacos)[1].props.title).toBe('Unfavorite');
    setRecipeFilters(toggleRecipeFilter(noRecipeFilters(), 'saved', 'favorites'));
    root = render();
    expect(rowNames(root)).toEqual(['Soup', 'Tacos']);
    setRecipeFilters(toggleRecipeFilter(noRecipeFilters(), 'saved', 'my-favorites'));
    root = render();
    expect(rowNames(root)).toEqual(['Tacos']);
  });
});

describe('the Favorites and My favorites chips', () => {
  const chips = (root: ReactTestRenderer) =>
    root.root.findAll(
      (n) =>
        typeof n.type === 'string' &&
        n.props.accessibilityRole === 'button' &&
        /^Remove .* filter$/.test(n.props.accessibilityLabel ?? ''),
    );
  const chipText = (chip: ReactTestInstance) =>
    chip.findAll((n) => n.type === ('Text' as never)).map((n) => [n.props.children].flat().join(''));

  test.each<['favorites' | 'my-favorites', string, string[]]>([
    ['favorites', 'Favorites', ['Soup', 'Tacos']],
    ['my-favorites', 'My favorites', ['Tacos']],
  ])('%s shows "%s ✕"; removing it shows every recipe again', (value, text, names) => {
    const tacos = addRecipe('Tacos', null);
    const soup = addRecipe('Soup', null, 2);
    addRecipe('Dal', null, 3);
    favorite(tacos);
    favorite(soup, 'user-2');
    setRecipeFilters(toggleRecipeFilter(noRecipeFilters(), 'saved', value));
    let root = render();
    expect(rowNames(root)).toEqual(names);
    const [chip] = chips(root);
    expect(chip.props.accessibilityLabel).toBe(`Remove ${text} filter`);
    expect(chipText(chip).join(' ')).toContain(text);
    const pressable = root.root.find(
      (n) => n.props.accessibilityLabel === chip.props.accessibilityLabel && typeof n.props.onPress === 'function',
    );
    act(() => pressable.props.onPress());
    root = render();
    expect(chips(root)).toEqual([]);
    expect(rowNames(root)).toEqual(['Dal', 'Soup', 'Tacos']);
  });

  test('both on show both chips, Favorites first', () => {
    const tacos = addRecipe('Tacos', null);
    favorite(tacos);
    favorite(tacos, 'user-2');
    setRecipeFilters(toggleRecipeFilter(toggleRecipeFilter(noRecipeFilters(), 'saved', 'my-favorites'), 'saved', 'favorites'));
    const root = render();
    expect(chips(root).map((c) => c.props.accessibilityLabel)).toEqual(['Remove Favorites filter', 'Remove My favorites filter']);
  });
});
