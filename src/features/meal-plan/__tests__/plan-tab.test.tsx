// Where the week plan lives (spec 4.16, boards 4 and 5): the Plan trigger follows Settings > Meal plan >
// Plan tab, and with it off the Recipes tab gets All recipes | This week. Rendered against the in-memory
// database.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, households, recipes } from '@/db';
import { ensureStarterData } from '@/features/lists/lists';
import { setPlanTab } from '@/features/settings/device-settings';
import { resetDb } from '@/test/db';

import TabsLayout from '@/app/(tabs)/_layout';
import RecipesScreen from '@/app/(tabs)/recipes/index';
import { EmptyState } from '@/components/empty-state';
import { RecipeSortButton } from '@/features/recipes/recipe-sort-button';
import { setRecipeFilters } from '@/features/recipes/recipe-filter-store';
import { noRecipeFilters } from '@/features/recipes/recipe-filters';

import { addModeEnded, dismissAddHint, isAddHintVisible, resetAddHint } from '@/features/tabs/add-hint';

import { onPlanTab, resetRecipesSegment, setRecipesSegment } from '../plan-tab';

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
jest.mock('@/features/recipes/share-drain', () => ({ onShareImports: () => () => {}, removeQueuedShare: () => {} }));
jest.mock('@/features/recipes/share-queue-status', () => ({
  useShareQueueStatus: () => ({ waiting: 0, importing: false }),
  importsBadgeCount: () => 0,
  importsCardHeading: () => null,
}));
const mockNavigate = jest.fn();
let mockPathname = '/recipes';
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
    usePathname: () => mockPathname,
  };
});
// Each tab as a `TabTrigger` host: `href: null` is how the layout hides one.
jest.mock('expo-router/tabs', () => {
  const { createElement } = require('react');
  const Screen = ({ name, options }: { name: string; options?: { href?: string | null } }) =>
    createElement('TabTrigger', { name, hidden: options?.href === null, options });
  const Tabs = ({ children, tabBar }: { children?: unknown; tabBar?: unknown }) => createElement('Tabs', { tabBar }, children);
  return { Tabs: Object.assign(Tabs, { Screen }) };
});
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
let tree: ReactTestRenderer | null = null;

function render(element: React.ReactElement): ReactTestRenderer {
  act(() => {
    tree = create(<SafeAreaProvider initialMetrics={METRICS}>{element}</SafeAreaProvider>);
  });
  return tree!;
}

function remount(element: React.ReactElement): ReactTestRenderer {
  act(() => tree?.unmount());
  return render(element);
}

const triggers = (root: ReactTestRenderer) => root.root.findAll((n) => n.type === ('TabTrigger' as never));
/** The tab bar as it shows: each trigger's name, hidden ones left out. */
const visibleTabs = (root: ReactTestRenderer) => triggers(root).filter((n) => !n.props.hidden).map((n) => n.props.name);
const planTrigger = (root: ReactTestRenderer) => triggers(root).find((n) => n.props.name === 'plan')!;

/** The title's view menu (spec 4.16, Plan tab off). */
const viewMenus = (root: ReactTestRenderer) =>
  root.root.findAll(
    (n) =>
      n.type === ('SwiftMenu' as never) &&
      n.findAll((c) => c.props.testID === 'recipes-view-title' && typeof c.type === 'string').length > 0,
  );
/** The menu's All recipes and This week items. */
const segments = (root: ReactTestRenderer) =>
  viewMenus(root).flatMap((m) => m.findAll((n) => n.type === ('SwiftToggle' as never)));
const segmentState = (root: ReactTestRenderer) => segments(root).map((s) => [s.props.label, s.props.isOn]);
const choose = (root: ReactTestRenderer, label: 'All recipes' | 'This week') =>
  act(() => segments(root).find((s) => s.props.label === label)!.props.onIsOnChange(true));
const byTestID = (root: ReactTestRenderer, id: string) =>
  root.root.findAll((n) => n.type === ('View' as never) && n.props.testID === id);
const hasLabel = (node: ReactTestInstance, label: string) =>
  node.findAll((n) => typeof n.type === 'string' && n.props.accessibilityLabel === label).length > 0;
const recipeLinks = (root: ReactTestRenderer) => root.root.findAll((n) => n.type === ('Link' as never));

beforeEach(() => {
  resetDb();
  ensureStarterData('user-1');
  resetRecipesSegment();
  setRecipeFilters(noRecipeFilters());
  mockNavigate.mockClear();
  mockPathname = '/recipes';
  db.insert(households).values({ id: 'home', name: 'Home' }).run();
  db.insert(recipes).values({ id: 'tacos', householdId: 'home', name: 'Tacos' }).run();
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

describe('the Plan trigger', () => {
  test('is hidden by default', () => {
    const root = render(<TabsLayout />);
    expect(visibleTabs(root)).toEqual(['lists', 'recipes', 'settings']);
    expect(planTrigger(root).props.hidden).toBe(true);
  });

  test('shows between Recipes and Settings once Plan tab is turned on', () => {
    setPlanTab(true);
    const root = render(<TabsLayout />);
    expect(visibleTabs(root)).toEqual(['lists', 'recipes', 'plan', 'settings']);
    expect(planTrigger(root).props.hidden).toBe(false);
  });

  test('hides when Plan tab is turned off from Settings, and comes back when it is turned on', () => {
    setPlanTab(true);
    mockPathname = '/settings';
    const root = render(<TabsLayout />);
    act(() => setPlanTab(false));
    expect(visibleTabs(root)).toEqual(['lists', 'recipes', 'settings']);
    // Off from Settings: Settings stays where it is.
    expect(mockNavigate).not.toHaveBeenCalled();
    act(() => setPlanTab(true));
    expect(visibleTabs(root)).toEqual(['lists', 'recipes', 'plan', 'settings']);
  });

  test('stays hidden on launch when Plan tab was turned off before', () => {
    setPlanTab(false);
    const root = render(<TabsLayout />);
    expect(visibleTabs(root)).toEqual(['lists', 'recipes', 'settings']);
  });

  test('turned off while on the Plan tab: lands on Recipes > This week, and only then hides', () => {
    setPlanTab(true);
    mockPathname = '/plan';
    const root = render(<TabsLayout />);
    act(() => setPlanTab(false));
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/recipes');
    // Never a hidden focused tab: the trigger stays until the tab bar is off Plan.
    expect(planTrigger(root).props.hidden).toBe(false);
    mockPathname = '/recipes';
    act(() => root.update(<SafeAreaProvider initialMetrics={METRICS}><TabsLayout /></SafeAreaProvider>));
    expect(planTrigger(root).props.hidden).toBe(true);

    // Recipes opens on This week.
    remount(<RecipesScreen />);
    expect(segmentState(tree!)).toEqual([
      ['All recipes', false],
      ['This week', true],
    ]);
    expect(byTestID(tree!, 'week-toolbar')).toHaveLength(1);
  });

  test('on the Plan tab with the setting on, nothing moves', () => {
    setPlanTab(true);
    mockPathname = '/plan';
    render(<TabsLayout />);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('the Recipes tab', () => {
  test('has no All recipes | This week while the Plan tab is on', () => {
    setPlanTab(true);
    const root = render(<RecipesScreen />);
    expect(segments(root)).toHaveLength(0);
    expect(viewMenus(root)).toHaveLength(0);
    expect(byTestID(root, 'week-toolbar')).toHaveLength(0);
  });

  test('ignores a remembered This week while the Plan tab is on', () => {
    setPlanTab(true);
    setRecipesSegment('week');
    const root = render(<RecipesScreen />);
    expect(segments(root)).toHaveLength(0);
    expect(recipeLinks(root)).toHaveLength(1);
    expect(byTestID(root, 'week-toolbar')).toHaveLength(0);
  });

  test('with the Plan tab off, the title menu offers All recipes and This week, All recipes first and ticked', () => {
    setPlanTab(false);
    const root = render(<RecipesScreen />);
    expect(segmentState(root)).toEqual([
      ['All recipes', true],
      ['This week', false],
    ]);
    // All recipes is the usual tab: search, Filters, the sort button and the recipes.
    expect(hasLabel(root.root, 'Search recipes')).toBe(true);
    expect(byTestID(root, 'recipes-filters')).toHaveLength(1);
    expect(root.root.findAllByType(RecipeSortButton)).toHaveLength(1);
    expect(recipeLinks(root)).toHaveLength(1);
    expect(byTestID(root, 'week-toolbar')).toHaveLength(0);
  });

  test('follows the setting while showing', () => {
    const root = render(<RecipesScreen />);
    act(() => setPlanTab(false));
    expect(segments(root)).toHaveLength(2);
    act(() => setPlanTab(true));
    expect(segments(root)).toHaveLength(0);
  });

  test('This week shows the week with its toolbar and hides search, Filters, the sort button and the recipes', () => {
    setPlanTab(false);
    const root = render(<RecipesScreen />);
    choose(root, 'This week');
    expect(byTestID(root, 'week-toolbar')).toHaveLength(1);
    expect(byTestID(root, 'week-grid')).toHaveLength(1);
    expect(hasLabel(root.root, 'Search recipes')).toBe(false);
    expect(byTestID(root, 'recipes-filters')).toHaveLength(0);
    expect(root.root.findAllByType(RecipeSortButton)).toHaveLength(0);
    expect(recipeLinks(root)).toHaveLength(0);
    // The week's own Agenda/Grid toggle sits in the sheet, below the header.
    expect(byTestID(root, 'plan-view-toggle')).toHaveLength(1);
  });

  test('This week shows the week even with no recipes yet', () => {
    db.delete(recipes).run();
    setPlanTab(false);
    setRecipesSegment('week');
    const root = render(<RecipesScreen />);
    expect(byTestID(root, 'week-toolbar')).toHaveLength(1);
    expect(root.root.findAllByType(EmptyState)).toHaveLength(0);
    // All recipes has the empty state as before.
    choose(root, 'All recipes');
    expect(root.root.findAllByType(EmptyState)).toHaveLength(1);
  });

  test('the segment is kept for the app session, across leaving and coming back', () => {
    setPlanTab(false);
    let root = render(<RecipesScreen />);
    choose(root, 'This week');
    root = remount(<RecipesScreen />);
    expect(segmentState(root)).toEqual([
      ['All recipes', false],
      ['This week', true],
    ]);
    choose(root, 'All recipes');
    root = remount(<RecipesScreen />);
    expect(segmentState(root)).toEqual([
      ['All recipes', true],
      ['This week', false],
    ]);
    expect(recipeLinks(root)).toHaveLength(1);
  });

  test('a fresh session starts on All recipes', () => {
    setPlanTab(false);
    setRecipesSegment('week');
    resetRecipesSegment();
    const root = render(<RecipesScreen />);
    expect(segmentState(root)[0]).toEqual(['All recipes', true]);
  });

  test('the switch reads in Spanish', () => {
    setPlanTab(false);
    const { i18n } = require('@/i18n') as typeof import('@/i18n');
    const before = i18n.language;
    act(() => void i18n.changeLanguage('es'));
    try {
      const root = render(<RecipesScreen />);
      expect(segments(root).map((n) => n.props.label)).toEqual(['Todas las recetas', 'Esta semana']);
      expect(viewMenus(root)[0].props.modifiers).toEqual([{ accessibilityLabel: 'Recetas, cambiar vista' }]);
    } finally {
      act(() => void i18n.changeLanguage(before));
    }
  });
});

test('onPlanTab is the Plan tab and its screens, not a route that only starts the same', () => {
  expect(onPlanTab('/plan')).toBe(true);
  expect(onPlanTab('/plan/slot')).toBe(true);
  expect(onPlanTab('/planner')).toBe(false);
  expect(onPlanTab('/recipes')).toBe(false);
});

// The tabs' layout also puts up the + hint (spec 4.1) over the tab bar.
describe('the + hint in the tabs layout', () => {
  /** The hint text the layout hands the tab bar. */
  const barHint = (root: ReactTestRenderer) =>
    (root.root.findByType('Tabs' as never).props.tabBar({}) as { props: { addHint?: string | null } }).props.addHint;
  const tabsRoot = (root: ReactTestRenderer) => byTestID(root, 'tabs-root')[0];

  beforeEach(() => dismissAddHint());

  test('no hint, and no touch capture, at rest', () => {
    const root = render(<TabsLayout />);
    expect(barHint(root)).toBeNull();
    expect(tabsRoot(root).props.onStartShouldSetResponderCapture).toBeUndefined();
  });

  test('once due, the tab bar shows it; any touch dismisses it without taking the touch', async () => {
    resetAddHint();
    const root = render(<TabsLayout />);
    await act(() => addModeEnded(() => ({ sheetOpen: false, selecting: false })));
    expect(barHint(root)).toBe('Hold + for more ways to add');
    let claimed: unknown;
    act(() => {
      claimed = tabsRoot(root).props.onStartShouldSetResponderCapture();
    });
    expect(claimed).toBe(false);
    expect(isAddHintVisible()).toBe(false);
    expect(barHint(root)).toBeNull();
  });
});
