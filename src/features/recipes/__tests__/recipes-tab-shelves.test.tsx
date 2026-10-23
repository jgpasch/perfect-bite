// The Recipes tab's shelves (spec 4.5): This week, Recently added and Favorites over an All recipes heading,
// hidden while searching or filtering and below 8 recipes, and what each See all does, rendered against the
// in-memory database.
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ScrollView, TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, householdMemberNames, households, lists, mealPlanEntries, recipeFavorites, recipes } from '@/db';
import { ensureStarterData } from '@/features/lists/lists';
import { resetRecipesSegment } from '@/features/meal-plan/plan-tab';
import { getRecipeSortChoice, setDeviceSetting, setPlanTab, setRecipeSortChoice } from '@/features/settings/device-settings';
import { emptyRecipeTags, type RecipeTags } from '@/shared/recipe-tags';
import { resetDb } from '@/test/db';

import RecipesScreen from '@/app/(tabs)/recipes/index';

import { resetFoldedMealSections } from '../recipe-fold-store';
import { getRecipeFilters, setRecipeFilters } from '../recipe-filter-store';
import { activeFilterCount, noRecipeFilters, toggleRecipeFilter } from '../recipe-filters';
import { RECIPE_PHOTO_SIZE_KEY } from '../recipe-photo-size';
import { addWholeRecipeToList } from '../add-to-list';
import { addRecipeIngredient } from '../recipes';
import { RecipeSortButton } from '../recipe-sort-button';

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
jest.mock('@/features/recipes/share-reconcile', () => ({ removeQueuedShare: () => false, retryShareImport: async () => true }));
// This week's view is the week plan, tested on its own.
jest.mock('@/features/meal-plan/week-plan', () => {
  const { createElement } = require('react');
  return { WeekPlan: () => createElement('WeekPlan') };
});
const mockNavigate = jest.fn();
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
    router: { push: () => {}, back: () => {}, navigate: (...args: unknown[]) => mockNavigate(...args) },
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
    useLocalSearchParams: () => ({}),
    usePathname: () => '/recipes',
  };
});
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));

// Tuesday 13 October 2026: the week runs Sunday 11 to Saturday 17.
const NOW = new Date(2026, 9, 13, 9, 0);

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

/**
 * A recipe changed `minutesAgo` minutes before now, so the smaller it is the more recent. `favorite` in `marks`
 * makes it the user's favorite (`recipe_favorites`, 4.14); the rest are its Saved tags.
 */
function addRecipe(name: string, minutesAgo: number, marks: string[] = [], totalMinutes: number | null = 35) {
  const id = name.toLowerCase().replace(/\W+/g, '-');
  const saved = marks.filter((m) => m !== 'favorite');
  db.insert(recipes)
    .values({
      id,
      householdId: 'home',
      name,
      tags: saved.length > 0 ? ({ ...emptyRecipeTags(), saved } as RecipeTags) : null,
      totalMinutes,
      updatedAt: new Date(NOW.getTime() - minutesAgo * 60_000),
    })
    .run();
  if (marks.includes('favorite')) db.insert(recipeFavorites).values({ recipeId: id, userId: 'user-1', householdId: 'home' }).run();
  return id;
}

function plan(recipeId: string, planDate: string, meal: 'breakfast' | 'lunch' | 'dinner') {
  db.insert(mealPlanEntries)
    .values({ id: `${recipeId}-${planDate}-${meal}`, householdId: 'home', planDate, meal, kind: 'recipe', recipeId })
    .run();
}

/** Nine recipes, the newest first: Tacos is planned for Thursday dinner, Curry and Dal are favorites. */
function addCollection() {
  ['Tacos', 'Pho', 'Curry', 'Banana bread', 'Dal', 'Enchiladas', 'Apple crumble', 'Frittata', 'Gnocchi'].forEach((name, i) =>
    addRecipe(name, i + 1, name === 'Curry' || name === 'Dal' ? ['favorite'] : [], name === 'Banana bread' ? null : 35),
  );
  plan('tacos', '2026-10-15', 'dinner');
}

const byTestId = (root: ReactTestRenderer, testID: string) => root.root.findAll((n) => n.props.testID === testID && typeof n.type === 'string');
const shelf = (root: ReactTestRenderer, key: string) => byTestId(root, `recipe-shelf-${key}`)[0];
const shelfKeys = (root: ReactTestRenderer) =>
  root.root
    .findAll((n) => typeof n.type === 'string' && /^recipe-shelf-(thisWeek|recent|favorites)$/.test(String(n.props.testID ?? '')))
    .map((n) => String(n.props.testID).replace('recipe-shelf-', ''));
const text = (node: ReactTestInstance) => [node.props.children].flat().join('');
const texts = (node: ReactTestInstance) => node.findAll((n) => n.type === ('Text' as never)).map(text);
const linkLabel = (link: ReactTestInstance) =>
  link.findAll((n) => n.props.accessibilityRole === 'button')[0].props.accessibilityLabel as string;
/** A shelf's tiles, as their VoiceOver labels. */
const tiles = (node: ReactTestInstance) => node.findAll((n) => n.type === ('Link' as never)).map(linkLabel);
const onShelf = (n: ReactTestInstance | null): boolean =>
  n !== null && (/^recipe-shelf-/.test(String(n.props.testID ?? '')) || onShelf(n.parent));
/** The household cards' rows, by name, in order. */
const rowNames = (root: ReactTestRenderer) =>
  root.root
    .findAll((n) => n.type === ('Link' as never) && !onShelf(n))
    .map((l) => linkLabel(l).split(',')[0]);
const allHeading = (root: ReactTestRenderer) => byTestId(root, 'recipes-all-heading');
const seeAllButton = (root: ReactTestRenderer, key: string) =>
  root.root.find((n) => n.props.testID === `recipe-shelf-${key}-see-all` && typeof n.props.onPress === 'function');
const seeAll = (root: ReactTestRenderer, key: string) =>
  act(() => seeAllButton(root, key).props.onPress());
const weekShown = (root: ReactTestRenderer) => root.root.findAll((n) => n.type === ('WeekPlan' as never)).length === 1;
const search = (root: ReactTestRenderer, query: string) =>
  act(() => root.root.findByType(TextInput).props.onChangeText(query));

beforeAll(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'setInterval', 'clearInterval', 'queueMicrotask', 'nextTick'] });
});

afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  resetDb();
  ensureStarterData('user-1');
  resetFoldedMealSections();
  resetRecipesSegment();
  setRecipeFilters(noRecipeFilters());
  setRecipeSortChoice({ sort: 'name', group: 'none' });
  setDeviceSetting(RECIPE_PHOTO_SIZE_KEY, 'small');
  setPlanTab(false);
  mockNavigate.mockClear();
  db.insert(households).values({ id: 'home', name: 'Home' }).run();
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  setRecipeFilters(noRecipeFilters());
  resetRecipesSegment();
});

describe('with 8 or more recipes', () => {
  test('This week, Recently added and Favorites, then All recipes over the cards A–Z', () => {
    addCollection();
    const root = render();
    expect(shelfKeys(root)).toEqual(['thisWeek', 'recent', 'favorites']);

    // Each header: its glyph and colour, the title as a header, and See all with the shelf's count.
    const header = (key: string) => {
      const node = shelf(root, key);
      const icon = node.findAll((n) => n.type === ('Icon' as never))[0];
      const title = node.find((n) => n.type === ('Text' as never) && n.props.accessibilityRole === 'header');
      const button = seeAllButton(root, key);
      const pressable = button.find((n) => typeof n.props.accessibilityLabel === 'string');
      return [icon.props.name, icon.props.color, text(title), pressable.props.accessibilityLabel];
    };
    expect(header('thisWeek')).toEqual(['calendar', 'inkSecondary', 'This week', 'See all 1']);
    expect(header('recent')).toEqual(['clock', 'inkSecondary', 'Recently added', 'See all 9']);
    expect(header('favorites')).toEqual(['heart.fill', 'primary', 'Favorites', 'See all 2']);

    // The tiles, with their captions as VoiceOver reads them.
    expect(tiles(shelf(root, 'thisWeek'))).toEqual(['Tacos, Thursday dinner']);
    expect(texts(shelf(root, 'thisWeek'))).toContain('Thu dinner');
    expect(tiles(shelf(root, 'recent'))).toEqual([
      'Tacos, 35 min',
      'Pho, 35 min',
      'Curry, 35 min',
      // No time: just the name.
      'Banana bread',
      'Dal, 35 min',
      'Enchiladas, 35 min',
      'Apple crumble, 35 min',
      'Frittata, 35 min',
      'Gnocchi, 35 min',
    ]);
    expect(tiles(shelf(root, 'favorites'))).toEqual(['Curry, 35 min', 'Dal, 35 min']);

    // 140 pt tiles in a sideways row with no indicator, 12 apart and 16 in.
    const row = shelf(root, 'recent').findByType(ScrollView);
    expect(row.props.horizontal).toBe(true);
    expect(row.props.showsHorizontalScrollIndicator).toBe(false);
    expect(row.props.contentContainerStyle).toEqual({ gap: 12, paddingHorizontal: 16 });
    expect(byTestId(root, 'recipe-shelf-tile')[0].props.style).toMatchObject({ width: 140 });

    // All recipes with its count beside the title, over every recipe A–Z.
    const heading = allHeading(root)[0];
    expect(heading.findAll((n) => n.type === ('Text' as never)).map(text)).toEqual(['All recipes', '9']);
    expect(heading.find((n) => n.props.testID === 'section-header-title-group')).toBeTruthy();
    expect(rowNames(root)).toEqual([
      'Apple crumble',
      'Banana bread',
      'Curry',
      'Dal',
      'Enchiladas',
      'Frittata',
      'Gnocchi',
      'Pho',
      'Tacos',
    ]);
  });

  test('a shelf with nothing on it is left out; nothing planned or favorited leaves Recently added', () => {
    ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'].forEach((name, i) => addRecipe(name, i + 1));
    const root = render();
    expect(shelfKeys(root)).toEqual(['recent']);
    expect(allHeading(root)).toHaveLength(1);
  });

  test('a tile keeps the card’s long-press menu and "On <list>" badge', () => {
    addCollection();
    const root = render();
    const tile = shelf(root, 'thisWeek').find((n) => n.type === ('Link' as never));
    expect(tile.props.href).toEqual({ pathname: '/recipe/[id]', params: { id: 'tacos' } });
    expect(tile.findAll((n) => n.type === ('LinkMenuAction' as never)).map((a) => a.props.title)).toEqual([
      'Plan…',
      'Favorite',
      'Want to try',
      'Rename',
      'Delete',
    ]);
  });

  test('a tile on a list gets the "On <list>" badge over its photo, and says it to VoiceOver', () => {
    addCollection();
    addRecipeIngredient('tacos', '8 tortillas');
    const groceries = db.select().from(lists).all()[0];
    expect(groceries.name).toBe('Groceries');
    expect(addWholeRecipeToList(groceries.id, 'tacos', 'user-1')?.count).toBe(1);
    const root = render();
    const tacos = () => shelf(root, 'thisWeek').find((n) => n.type === ('Link' as never));
    expect(linkLabel(tacos())).toBe('Tacos, Thursday dinner, on Groceries');
    const badge = tacos().find(
      (n) => n.type === ('View' as never) && n.props.style?.[0]?.position === 'absolute' && texts(n).includes('On Groceries'),
    );
    expect(badge.props.style[1]).toEqual({ top: 4, end: 4 });
  });

  test('typing a search hides the shelves and the heading; clearing it brings them back', () => {
    addCollection();
    const root = render();
    search(root, 'taco');
    expect(shelfKeys(root)).toEqual([]);
    expect(allHeading(root)).toHaveLength(0);
    expect(rowNames(root)).toEqual(['Tacos']);
    // Only spaces isn't a search.
    search(root, '   ');
    expect(shelfKeys(root)).toEqual(['thisWeek', 'recent', 'favorites']);
    search(root, '');
    expect(shelfKeys(root)).toEqual(['thisWeek', 'recent', 'favorites']);
    expect(allHeading(root)).toHaveLength(1);
  });

  test('a filter hides them; clearing the filters brings them back', () => {
    addCollection();
    const root = render();
    act(() => setRecipeFilters(toggleRecipeFilter(noRecipeFilters(), 'saved', 'want-to-try')));
    expect(shelfKeys(root)).toEqual([]);
    expect(allHeading(root)).toHaveLength(0);
    act(() => setRecipeFilters(noRecipeFilters()));
    expect(shelfKeys(root)).toEqual(['thisWeek', 'recent', 'favorites']);
    expect(allHeading(root)).toHaveLength(1);
  });

  test('large photos change only the list under All recipes', () => {
    setDeviceSetting(RECIPE_PHOTO_SIZE_KEY, 'large');
    addCollection();
    const root = render();
    expect(shelfKeys(root)).toEqual(['thisWeek', 'recent', 'favorites']);
    expect(byTestId(root, 'recipe-shelf-tile')).toHaveLength(1 + 9 + 2);
    expect(byTestId(root, 'recipe-grid').length).toBeGreaterThan(0);
  });
});

describe('grouped', () => {
  const toggle = (root: ReactTestRenderer, key: string) =>
    act(() =>
      shelf(root, key)
        .findAll((n) => n.props.accessibilityRole === 'button' && n.props.accessibilityState?.expanded !== undefined)[0]
        .props.onPress(),
    );

  test('picking a grouping folds the shelves to their headers; a tap opens one in place with See all', () => {
    addCollection();
    const root = render();
    act(() => root.root.findByType(RecipeSortButton).props.onGroupChange('meal'));
    expect(shelfKeys(root)).toEqual(['thisWeek', 'recent', 'favorites']);
    expect(byTestId(root, 'recipe-shelf-tile')).toHaveLength(0);
    expect(root.root.findAll((n) => String(n.props.testID ?? '').endsWith('-see-all'))).toHaveLength(0);
    toggle(root, 'favorites');
    expect(tiles(shelf(root, 'favorites'))).toHaveLength(2);
    expect(seeAllButton(root, 'favorites')).toBeTruthy();
    expect(byTestId(root, 'recipe-shelf-tile')).toHaveLength(2);
    toggle(root, 'favorites');
    expect(root.root.findAll((n) => n.props.testID === 'recipe-shelf-favorites-see-all')).toHaveLength(0);
  });

  test('an opened shelf stays open across groupings, and Group by None shows every shelf open', () => {
    addCollection();
    const root = render();
    act(() => root.root.findByType(RecipeSortButton).props.onGroupChange('meal'));
    toggle(root, 'thisWeek');
    act(() => root.root.findByType(RecipeSortButton).props.onGroupChange('protein'));
    expect(tiles(shelf(root, 'thisWeek'))).toHaveLength(1);
    expect(byTestId(root, 'recipe-shelf-tile')).toHaveLength(1);
    act(() => root.root.findByType(RecipeSortButton).props.onGroupChange('none'));
    expect(byTestId(root, 'recipe-shelf-tile')).toHaveLength(1 + 9 + 2);
  });
});

describe('fewer than 8 recipes', () => {
  test('no shelves and no All recipes heading', () => {
    ['Tacos', 'Pho', 'Curry', 'Dal', 'Enchiladas', 'Frittata', 'Gnocchi'].forEach((name, i) =>
      addRecipe(name, i + 1, name === 'Curry' ? ['favorite'] : []),
    );
    plan('tacos', '2026-10-15', 'dinner');
    const root = render();
    expect(shelfKeys(root)).toEqual([]);
    expect(allHeading(root)).toHaveLength(0);
    expect(rowNames(root)).toEqual(['Curry', 'Dal', 'Enchiladas', 'Frittata', 'Gnocchi', 'Pho', 'Tacos']);
  });
});

describe('See all', () => {
  test('This week opens the week on the Recipes tab while the Plan tab is off', () => {
    addCollection();
    const root = render();
    seeAll(root, 'thisWeek');
    expect(weekShown(root)).toBe(true);
    expect(texts(byTestId(root, 'recipes-view-title')[0])).toEqual(['This week']);
    expect(shelfKeys(root)).toEqual([]);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test('This week opens the Plan tab when it’s on', () => {
    setPlanTab(true);
    addCollection();
    const root = render();
    seeAll(root, 'thisWeek');
    expect(mockNavigate).toHaveBeenCalledWith('/plan');
    expect(weekShown(root)).toBe(false);
    expect(shelfKeys(root)).toEqual(['thisWeek', 'recent', 'favorites']);
  });

  test('Recently added sorts by Recently added and scrolls to the All recipes heading', () => {
    addCollection();
    const root = render();
    const scrollTo = jest.fn();
    root.root.findAllByType(ScrollView)[0].instance.scrollTo = scrollTo;
    act(() => allHeading(root)[0].props.onLayout({ nativeEvent: { layout: { x: 0, y: 640, width: 390, height: 40 } } }));
    seeAll(root, 'recent');
    expect(scrollTo).toHaveBeenCalledWith({ y: 640, animated: true });
    expect(getRecipeSortChoice()).toEqual({ sort: 'recent', group: 'none' });
    expect(rowNames(root)).toEqual([
      'Tacos',
      'Pho',
      'Curry',
      'Banana bread',
      'Dal',
      'Enchiladas',
      'Apple crumble',
      'Frittata',
      'Gnocchi',
    ]);
    // The shelves stay.
    expect(shelfKeys(root)).toEqual(['thisWeek', 'recent', 'favorites']);
  });

  test('Favorites turns on the Favorites filter, so its results take the shelves’ place', () => {
    addCollection();
    const root = render();
    seeAll(root, 'favorites');
    expect(getRecipeFilters()).toEqual({ ...noRecipeFilters(), favorites: ['favorites'] });
    expect(activeFilterCount(getRecipeFilters())).toBe(1);
    expect(shelfKeys(root)).toEqual([]);
    expect(allHeading(root)).toHaveLength(0);
    expect(rowNames(root)).toEqual(['Curry', 'Dal']);
  });

  test('another member’s favorite is on the shelf too (outlined heart), and in its See all', () => {
    addCollection();
    db.insert(householdMemberNames)
      .values([
        { householdId: 'home', userId: 'user-1', firstName: 'Jo', lastName: 'Doe', joinedAt: '2026-10-01T00:00:00Z' },
        { householdId: 'home', userId: 'user-2', firstName: 'Sam', lastName: 'Lee', joinedAt: '2026-10-02T00:00:00Z' },
      ])
      .run();
    db.insert(recipeFavorites).values({ recipeId: 'pho', userId: 'user-2', householdId: 'home' }).run();
    // Someone not in the household counts for nothing.
    db.insert(recipeFavorites).values({ recipeId: 'gnocchi', userId: 'user-9', householdId: 'home' }).run();
    const root = render();
    expect(tiles(shelf(root, 'favorites'))).toEqual(['Curry, 35 min', 'Dal, 35 min', 'Pho, 35 min']);
    seeAll(root, 'favorites');
    expect(rowNames(root)).toEqual(['Curry', 'Dal', 'Pho']);
    const hearts = (name: string) =>
      root.root
        .find((n) => n.type === ('Link' as never) && n.props.href.params.id === name)
        .findAll((n) => n.type === ('Icon' as never) && String(n.props.name).startsWith('heart'))
        .map((n) => [n.props.name, n.props.color]);
    expect(hearts('pho')).toEqual([['heart', 'inkSecondary']]);
    expect(hearts('curry')).toEqual([['heart.fill', 'primary']]);
  });
});
