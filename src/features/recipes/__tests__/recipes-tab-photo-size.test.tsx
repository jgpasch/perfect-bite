// The Recipes tab's photo-size toggle (spec 4.5): small photos in rows, large photos in a two-column grid of
// tiles, rendered against the in-memory database.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Alert, type AlertButton } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, households, recipes } from '@/db';
import { ensureStarterData } from '@/features/lists/lists';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { emptyRecipeTags, type RecipeTags } from '@/shared/recipe-tags';
import { Palette } from '@/constants/theme';
import { resetDb } from '@/test/db';

import RecipesScreen from '@/app/(tabs)/recipes/index';
import { FoldingSection } from '@/components/section-header';

import { resetFoldedMealSections } from '../recipe-fold-store';
import { setRecipeFilters } from '../recipe-filter-store';
import { noRecipeFilters } from '../recipe-filters';
import { RECIPE_PHOTO_SIZE_KEY } from '../recipe-photo-size';
import { addRecipeIngredient, createRecipe, recipesQuery } from '../recipes';
import { RECIPE_SORT_KEY } from '../recipe-sort';

const mockWindow = { width: 390, height: 844, scale: 3, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => mockWindow }));
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
function addRecipe(householdId: string, name: string, minutesAgo: number, meal: string[] = [], totalMinutes: number | null = null) {
  db.insert(recipes)
    .values({
      id: name.toLowerCase().replace(/\W+/g, '-'),
      householdId,
      name,
      tags: meal.length > 0 ? ({ ...emptyRecipeTags(), meal } as RecipeTags) : null,
      totalMinutes,
      imageUrl: name === 'Tacos' ? 'https://example.com/tacos.jpg' : null,
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
const toggle = (root: ReactTestRenderer) =>
  root.root.find((n) => n.type === ('View' as never) && n.props.accessibilityRole === 'tablist');
/** The segments' Pressables. */
const segments = (root: ReactTestRenderer) =>
  toggle(root).findAll((n) => n.props.accessibilityRole === 'tab' && typeof n.props.onPress === 'function' && typeof n.type !== 'string');
const segment = (root: ReactTestRenderer, label: string) => segments(root).find((s) => s.props.accessibilityLabel === label)!;
const choose = (root: ReactTestRenderer, label: 'Small photos' | 'Large photos') => act(() => segment(root, label).props.onPress());
const grids = (node: ReactTestInstance) => node.findAll((n) => n.type === ('View' as never) && n.props.testID === 'recipe-grid');
const covers = (node: ReactTestInstance) => node.findAll((n) => n.type === ('View' as never) && n.props.testID === 'recipe-photo-cover');
const swipeables = (root: ReactTestRenderer) => root.root.findAll((n) => n.type === ('Swipeable' as never));
const links = (node: ReactTestInstance) => node.findAll((n) => n.type === ('Link' as never));
/** A link's recipe name (the first part of its VoiceOver label). */
const linkName = (link: ReactTestInstance) =>
  (link.findAll((n) => n.props.accessibilityRole === 'button')[0].props.accessibilityLabel as string).split(',')[0];
/** Each grid row's recipe names, in order; an empty filler cell reads as null. */
const byTestID = (node: ReactTestInstance, id: string) =>
  node.findAll((n) => n.type === ('View' as never) && n.props.testID === id);
const gridRowsOf = (grid: ReactTestInstance) => byTestID(grid, 'recipe-grid-row');
const gridLayout = (grid: ReactTestInstance) =>
  gridRowsOf(grid).map((row) =>
    byTestID(row, 'recipe-grid-cell').map((cell) => {
      const link = links(cell)[0];
      return link ? linkName(link) : null;
    }),
  );
const texts = (node: ReactTestInstance) =>
  node.findAll((n) => n.type === ('Text' as never)).map((n) => [n.props.children].flat().join(''));
const sections = (root: ReactTestRenderer) => root.root.findAllByType(FoldingSection);
/** The recipes the tab would show, newest change first. */
const recipeNames = () => recipesQuery().all().map((r) => r.name);

beforeEach(() => {
  resetDb();
  ensureStarterData('user-1');
  resetFoldedMealSections();
  setRecipeFilters(noRecipeFilters());
  mockWindow.fontScale = 1;
  db.insert(households).values({ id: 'home', name: 'Home' }).run();
  addRecipe('home', 'Tacos', 1, ['dinner'], 35);
  addRecipe('home', 'Frittata', 2, ['breakfast'], 80);
  addRecipe('home', 'Apple crumble', 3, ['dessert']);
  addRecipe('home', 'Banana bread', 4, [], 60);
  addRecipe('home', 'Curry', 5, ['dinner'], 45);
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  jest.restoreAllMocks();
});

describe('the photo-size toggle', () => {
  test('"Photo size", Small then Large, Small selected by default, at the end of the header row', () => {
    const root = render();
    expect(toggle(root).props.accessibilityLabel).toBe('Photo size');
    expect(segments(root).map((s) => [s.props.accessibilityLabel, s.props.accessibilityState.selected])).toEqual([
      ['Small photos', true],
      ['Large photos', false],
    ]);
    // After the sort pill, last in the pills' row.
    const pills = toggle(root).parent!;
    expect(pills.children.at(-1)).toBe(toggle(root));
    expect(grids(root.root)).toHaveLength(0);
    expect(swipeables(root)).toHaveLength(5);
  });

  test('the selected segment is filled onHeader with a header glyph; the other is clear with an onHeader glyph', () => {
    const root = render();
    const light = Palette.light;
    const icon = (s: ReactTestInstance) => s.find((n) => n.type === ('Icon' as never)).props;
    expect(flat(segment(root, 'Small photos').props.style).backgroundColor).toBe(light.onHeader);
    expect(icon(segment(root, 'Small photos'))).toMatchObject({ name: 'list.bullet', tint: light.header });
    expect(flat(segment(root, 'Large photos').props.style).backgroundColor).toBe('transparent');
    expect(icon(segment(root, 'Large photos'))).toMatchObject({ name: 'photo', tint: light.onHeader });
  });

  test('each segment is at least 44 pt wide and, with its slop, 44 pt tall', () => {
    const root = render();
    for (const s of segments(root)) {
      const style = flat(s.props.style);
      expect(style.minWidth).toBeGreaterThanOrEqual(44);
      expect((style.minHeight as number) + s.props.hitSlop.top + s.props.hitSlop.bottom).toBeGreaterThanOrEqual(44);
    }
  });

  test('Large photos: a two-column grid of tiles on the screen\'s ground, saved on this device', () => {
    const root = render();
    choose(root, 'Large photos');
    expect(segments(root).map((s) => s.props.accessibilityState.selected)).toEqual([false, true]);
    expect(getDeviceSetting(RECIPE_PHOTO_SIZE_KEY, null)).toBe('large');
    const [grid] = grids(root.root);
    expect(grids(root.root)).toHaveLength(1);
    // Recently added order, two per row; the short last row keeps an empty cell so its tile stays a column wide.
    expect(gridLayout(grid)).toEqual([
      ['Tacos', 'Frittata'],
      ['Apple crumble', 'Banana bread'],
      ['Curry', null],
    ]);
    // No household card around the tiles; 12 between rows and columns.
    expect(flat(grid.props.style)).toMatchObject({ paddingTop: 0, gap: 12 });
    expect(flat(gridRowsOf(grid)[0].props.style)).toMatchObject({ flexDirection: 'row', gap: 12 });
    // Each cell takes an equal share of the row.
    expect(byTestID(grid, 'recipe-grid-cell').map((c) => flat(c.props.style).flex)).toEqual([1, 1, 1, 1, 1, 1]);
    // Tiles don't swipe: no row is left.
    expect(swipeables(root)).toHaveLength(0);
    expect(covers(root.root)).toHaveLength(5);
  });

  test('back to Small photos: rows again, saved', () => {
    const root = render();
    choose(root, 'Large photos');
    choose(root, 'Small photos');
    expect(grids(root.root)).toHaveLength(0);
    expect(swipeables(root)).toHaveLength(5);
    expect(getDeviceSetting(RECIPE_PHOTO_SIZE_KEY, null)).toBe('small');
  });

  test('the choice survives a remount', () => {
    let root = render();
    choose(root, 'Large photos');
    root = remount();
    expect(segment(root, 'Large photos').props.accessibilityState.selected).toBe(true);
    expect(grids(root.root)).toHaveLength(1);
  });

  test('a stored choice the app doesn’t know reads as Small photos', () => {
    setDeviceSetting(RECIPE_PHOTO_SIZE_KEY, 'huge');
    const root = render();
    expect(segment(root, 'Small photos').props.accessibilityState.selected).toBe(true);
    expect(grids(root.root)).toHaveLength(0);
  });

  test('A–Z with large photos: the grid follows the sort', () => {
    setDeviceSetting(RECIPE_SORT_KEY, 'name');
    setDeviceSetting(RECIPE_PHOTO_SIZE_KEY, 'large');
    const root = render();
    expect(gridLayout(grids(root.root)[0])).toEqual([
      ['Apple crumble', 'Banana bread'],
      ['Curry', 'Frittata'],
      ['Tacos', null],
    ]);
  });

  test('By meal with large photos: a grid inside each meal section', () => {
    setDeviceSetting(RECIPE_SORT_KEY, 'meal');
    const root = render();
    choose(root, 'Large photos');
    // 12 below each meal's header band.
    expect(flat(grids(root.root)[0].props.style)).toMatchObject({ paddingTop: 12, gap: 12 });
    expect(sections(root).map((s) => [s.props.title, gridLayout(grids(s)[0])])).toEqual([
      ['Breakfast', [['Frittata', null]]],
      ['Dinner', [['Curry', 'Tacos']]],
      ['Dessert', [['Apple crumble', null]]],
      ['No meal', [['Banana bread', null]]],
    ]);
    choose(root, 'Small photos');
    expect(grids(root.root)).toHaveLength(0);
    expect(sections(root)).toHaveLength(4);
  });

  test('one column at the largest accessibility text sizes', () => {
    setDeviceSetting(RECIPE_PHOTO_SIZE_KEY, 'large');
    mockWindow.fontScale = 2.35;
    const root = render();
    expect(gridLayout(grids(root.root)[0])).toEqual([['Tacos'], ['Frittata'], ['Apple crumble'], ['Banana bread'], ['Curry']]);
  });
});

describe('a large tile', () => {
  beforeEach(() => setDeviceSetting(RECIPE_PHOTO_SIZE_KEY, 'large'));
  const tile = (root: ReactTestRenderer, name: string) => links(root.root).find((l) => linkName(l) === name)!;

  test('the photo at 4:3 over the recipe hue, the name on up to two lines and the time', () => {
    const root = render();
    const tacos = tile(root, 'Tacos');
    const [cover] = covers(tacos);
    expect(flat(cover.props.style)).toMatchObject({ width: '100%', aspectRatio: 4 / 3, borderRadius: 12 });
    expect(cover.findAll((n) => n.type === ('ExpoImage' as never)).map((n) => n.props.source)).toEqual(['https://example.com/tacos.jpg']);
    const name = tacos.findAll((n) => n.type === ('Text' as never) && n.props.children === 'Tacos')[0];
    expect(name.props.numberOfLines).toBe(2);
    expect(texts(tacos)).toEqual(['Tacos', '35 min']);
    // Its own white card, 8 pt in, its corners concentric with the photo's.
    const card = tacos.find((n) => n.type === ('View' as never) && flat(n.props.style).borderWidth !== undefined);
    expect(flat(card.props.style)).toMatchObject({ backgroundColor: Palette.light.surface, padding: 6, borderWidth: 2, borderRadius: 20 });
    // No photo: just the hue and the fork and knife.
    const curry = covers(tile(root, 'Curry'))[0];
    expect(curry.findAll((n) => n.type === ('ExpoImage' as never))).toHaveLength(0);
    expect(curry.find((n) => n.type === ('Icon' as never)).props.name).toBe('fork.knife');
    // No time: the name alone.
    expect(texts(tile(root, 'Apple crumble'))).toEqual(['Apple crumble']);
    expect(texts(tile(root, 'Frittata'))).toEqual(['Frittata', '1 hr 20 min']);
  });

  test('opens the recipe and keeps the VoiceOver label', () => {
    const root = render();
    const tacos = tile(root, 'Tacos');
    expect(tacos.props.href).toEqual({ pathname: '/recipe/[id]', params: { id: 'tacos' } });
    expect(tacos.findAll((n) => n.props.accessibilityRole === 'button')[0].props.accessibilityLabel).toBe('Tacos, Dinner, 35 min');
  });

  test('offers the long-press menu; Delete asks first, then deletes', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const root = render();
    const menu = tile(root, 'Curry').findAll((n) => n.type === ('LinkMenuAction' as never));
    expect(menu.map((a) => a.props.title)).toEqual(['Favorite', 'Want to try', 'Rename', 'Delete']);
    act(() => menu.find((a) => a.props.title === 'Delete')!.props.onPress());
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toBe('Delete “Curry”?');
    expect(recipeNames()).toContain('Curry');
    act(() => (alert.mock.calls[0][2] as AlertButton[]).find((b) => b.text === 'Delete')!.onPress!());
    expect(recipeNames()).toEqual(['Tacos', 'Frittata', 'Apple crumble', 'Banana bread']);  });

  test('VoiceOver: a Delete action that asks first; Cancel deletes nothing', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const root = render();
    const button = tile(root, 'Tacos').findAll((n) => n.props.accessibilityRole === 'button')[0];
    expect(button.props.accessibilityActions).toEqual([{ name: 'delete', label: 'Delete' }]);
    act(() => button.props.onAccessibilityAction({ nativeEvent: { actionName: 'delete' } }));
    expect(alert).toHaveBeenCalledTimes(1);
    act(() => (alert.mock.calls[0][2] as AlertButton[]).find((b) => b.text === 'Cancel')!.onPress?.());
    expect(recipeNames()).toHaveLength(5);
  });

  test('Add to <list>: the tile is outlined while the toast shows and gets "On Groceries" over its photo', () => {
    const tacos = createRecipe('Weeknight tacos');
    addRecipeIngredient(tacos, '8 tortillas');
    const root = render();
    const outline = () =>
      flat(
        tile(root, 'Weeknight tacos').find((n) => n.type === ('View' as never) && flat(n.props.style).borderWidth !== undefined).props
          .style,
      );
    expect(outline().borderColor).toBe('transparent');
    const menu = tile(root, 'Weeknight tacos').findAll((n) => n.type === ('LinkMenuAction' as never));
    expect(menu[0].props.title).toBe('Add to Groceries');
    act(() => menu[0].props.onPress());
    expect(outline().borderColor).toBe(Palette.light.primary);
    // The badge sits over the photo's top corner.
    const badge = tile(root, 'Weeknight tacos').find(
      (n) => n.type === ('View' as never) && flat(n.props.style).position === 'absolute' && texts(n).includes('On Groceries'),
    );
    expect(flat(badge.props.style)).toMatchObject({ position: 'absolute', top: 4, end: 4 });
    expect(tile(root, 'Weeknight tacos').findAll((n) => n.props.accessibilityRole === 'button')[0].props.accessibilityLabel).toBe(
      'Weeknight tacos, on Groceries',
    );
  });

  test('a search that matched an ingredient says "Has …" in place of the time', () => {
    const tacos = createRecipe('Weeknight tacos');
    addRecipeIngredient(tacos, '2 lb chicken thighs');
    const root = render();
    const field = root.root.find((n) => n.type === ('TextInput' as never) && n.props.accessibilityLabel === 'Search recipes');
    act(() => field.props.onChangeText('chicken'));
    const tacosTile = tile(root, 'Weeknight tacos');
    // The outer line is "Has " with the ingredient nested in bold.
    const has = tacosTile.find((n) => n.type === ('Text' as never) && [n.props.children].flat()[0] === 'Has');
    expect(texts(has).slice(1)).toEqual(['chicken thighs']);
    expect(texts(tacosTile)[0]).toBe('Weeknight tacos');
    expect(tacosTile.findAll((n) => n.props.accessibilityRole === 'button')[0].props.accessibilityLabel).toBe(
      'Weeknight tacos, has chicken thighs',
    );
  });
});
