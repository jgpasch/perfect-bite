// The list screen (spec 4.1, 4.2, 4.4, 4.5, 4.6), the List tab's root, rendered against the real in-memory database. The row,
// add bar, view button and section header are host stand-ins, so the test reads the props the screen gives
// them and calls their callbacks as a tap, swipe or add would.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import * as Haptics from 'expo-haptics';
import { StatusBar } from 'expo-status-bar';
import { activateKeepAwakeAsync } from 'expo-keep-awake';
import {
  AccessibilityInfo,
  ActionSheetIOS,
  AppState,
  FlatList,
  Share,
  StyleSheet,
  type ActionSheetIOSOptions,
  type AppStateStatus,
} from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { categories, db, deviceSettings, householdMemberNames, households, ingredients, listItemContributions } from '@/db';
import { categorizePending } from '@/features/categories/categorization';
import { setHouseholdFeatures } from '@/features/plans/features';
import { pressAddButton, takePendingListAdd } from '@/features/tabs/add-button';
import { ADD_HINT_SEEN_KEY, ADD_TAP_COUNT_KEY, dismissAddHint, isAddHintVisible } from '@/features/tabs/add-hint';
import { addMenuOpened, runAddMenuItem } from '@/features/tabs/add-menu';
import { addRecipeIngredient, createRecipe, deleteRecipe, updateRecipe } from '@/features/recipes/recipes';
import { addWholeRecipeToList } from '@/features/recipes/add-to-list';
import {
  getDeviceSetting,
  setAisleColorStyle,
  setDeviceSetting,
  setAlwaysShowChecked,
  setItemRowStyle,
  setKeepScreenOn,
} from '@/features/settings/device-settings';
import type { MyInvite } from '@/features/households/invites';
import { setStaple } from '@/features/households/staples';
import { recordListOpened } from '@/features/siri/list-snapshot';
import { Button } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { Pill } from '@/components/pill';
import { initI18n } from '@/i18n';
import { SYSTEM_CATEGORIES } from '@/shared';
import { resetDb } from '@/test/db';
import { openChannels, realtimeChannels, resetSupabase, setChannelStatus, setPresence, type FakeChannel } from '@/test/fake-supabase';

import { addItem, listItemsQuery, moveItemToList, setItemChecked } from '../items';
import type { RowMove } from '../item-row';
import { getListSeenAt, markListSeen } from '../last-seen';
import { addedAt, CHECK_LINGER_MS, collapsedSectionsKey, LIST_VIEW_MODES, listSeenAtKey, manualOrderKey, viewModeKey } from '../list-view';
import { ListScreen } from '../list-screen';
import { createList, ensureStarterData, getDefaultListId, getList } from '../lists';
import { setMoveResult } from '../move-result';
import { setRecipeAddResult } from '../recipe-add-result';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('@/components/icon-tile', () => ({ IconTile: () => null }));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(), selectionAsync: jest.fn(), ImpactFeedbackStyle: { Light: 'light' } }));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const builder: object = new Proxy({}, { get: () => () => builder });
  return {
    __esModule: true,
    default: { View, createAnimatedComponent: (c: unknown) => c },
    FadeIn: builder,
    FadeInDown: builder,
    FadeOut: builder,
    LinearTransition: builder,
    Extrapolation: { CLAMP: 'clamp' },
    // Clamped, two points only: all the screen uses.
    interpolate: (x: number, [a, b]: number[], [c, d]: number[]) => c + (d - c) * Math.min(1, Math.max(0, (x - a) / (b - a))),
    useReducedMotion: () => false,
    useAnimatedRef: () => require('react').useRef(null),
    useAnimatedStyle: (fn: () => object) => fn(),
    useSharedValue: (value: unknown) => ({ value }),
    withTiming: (value: unknown) => value,
    withDelay: (_delay: number, value: unknown) => value,
    withRepeat: (value: unknown) => value,
    withSequence: (...values: unknown[]) => values[values.length - 1],
  };
});
jest.mock('expo-network', () => ({ addNetworkStateListener: () => ({ remove: () => {} }) }));
// The keep-awake tags held right now; the screen stays on while there's any.
const mockAwake = new Set<string>();
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn((tag: string) => (mockAwake.add(tag), Promise.resolve())),
  deactivateKeepAwake: jest.fn((tag: string) => (mockAwake.delete(tag), Promise.resolve())),
}));
// Live queries read once per render from the test database.
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
jest.mock('@/features/categories/categorization', () => ({
  ...jest.requireActual<object>('@/features/categories/categorization'),
  categorizePending: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/features/siri/list-snapshot', () => ({ recordListOpened: jest.fn() }));
const mockOpenLink = jest.fn((_url: string) => Promise.resolve(true));
jest.mock('@/features/recipes/recipe-link', () => ({
  ...jest.requireActual<object>('@/features/recipes/recipe-link'),
  openRecipeLink: (url: string) => mockOpenLink(url),
}));
// Siri and share-extension drains: the test plays their listeners.
const mockSiriListeners = new Set<(count: number) => void>();
jest.mock('@/features/siri/drain', () => ({
  onSiriAdds: (l: (count: number) => void) => (mockSiriListeners.add(l), () => void mockSiriListeners.delete(l)),
}));
const mockShareListeners = new Set<(imported: unknown[]) => void>();
jest.mock('@/features/recipes/share-drain', () => ({
  onShareImports: (l: (imported: unknown[]) => void) => (mockShareListeners.add(l), () => void mockShareListeners.delete(l)),
}));
// Host stand-ins.
jest.mock('@/features/lists/item-row', () => {
  const { createElement } = require('react');
  return { ItemRow: (props: object) => createElement('ItemRow', props) };
});
jest.mock('@/features/lists/add-bar', () => {
  const { createElement } = require('react');
  return { ItemAddBar: (props: object) => createElement('ItemAddBar', props) };
});
// As added's drag: the test calls its drop and still-lift callbacks as the gesture would.
jest.mock('@/features/lists/reorderable-rows', () => {
  const { createElement } = require('react');
  return {
    ReorderableRows: ({ rows, ...props }: { rows: { id: string; draggable: boolean; node: unknown }[] }) =>
      createElement('ReorderableRows', { ...props, draggable: rows.map((r) => r.draggable) }, rows.map((r) => r.node)),
  };
});
// A folded section draws no rows.
jest.mock('@/components/section-header', () => {
  const { createElement } = require('react');
  return {
    FoldingSection: ({ children, ...props }: { children?: unknown; collapsed?: boolean }) =>
      createElement('FoldingSection', props, props.collapsed ? null : children),
  };
});

// Invites waiting for the signed-in user; the switcher shows a dot for them.
const mockInvites: { current: MyInvite[] } = { current: [] };
jest.mock('@/features/households/my-invites', () => ({ useMyInvites: () => mockInvites.current }));
// The invite cards on the list have their own tests (invite-cards.test.tsx).
jest.mock('@/features/households/invite-cards', () => ({ ListInviteCards: () => null }));

const mockPath: { current: string } = { current: '/lists' };
const mockPush = jest.fn();
const mockBack = jest.fn();
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
  const Toolbar = Object.assign(passThrough(), {
    Button: host('ToolbarButton'),
    Label: host('ToolbarLabel'),
    Menu: host('ToolbarMenu'),
    View: passThrough(),
    MenuAction: host('ToolbarMenuAction'),
  });
  return {
    Stack: { Screen: () => null, Title: passThrough(), Toolbar },
    router: {
      push: (...args: unknown[]) => mockPush(...args),
      navigate: (...args: unknown[]) => mockNavigate(...args),
      back: () => mockBack(),
    },
    // The screen is focused while it's mounted.
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
    usePathname: () => mockPath.current,
  };
});
jest.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 0 }));

const USER = 'user-1';
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));

const cat = (slug: string) => SYSTEM_CATEGORIES.find((c) => c.slug === slug)!.id;

/** The system aisles and a few known ingredients (the full catalog seed is slow to load per test). */
function seedCatalog() {
  SYSTEM_CATEGORIES.forEach((c, rank) =>
    db.insert(categories).values({ id: c.id, slug: c.slug, name: c.name, householdId: null, defaultRank: rank }).run(),
  );
  const known: [string, string][] = [
    ['milk', 'dairy-eggs'],
    ['egg', 'dairy-eggs'],
    ['banana', 'produce'],
    ['lime', 'produce'],
    ['bread', 'bakery'],
    ['tortilla', 'bakery'],
  ];
  for (const [name, slug] of known) {
    db.insert(ingredients)
      .values({ normalizedName: name, displayName: name, defaultCategoryId: cat(slug), status: 'categorized' })
      .run();
  }
}

let listId: string;
/** The list the tab shows; the List tab passes it as `id`. */
let shownId: string;
let tree: ReactTestRenderer | null = null;

beforeEach(() => {
  // Each add a second apart, so As added has a definite order.
  jest.useFakeTimers({ now: new Date('2026-05-01T12:00:00Z'), doNotFake: ['queueMicrotask', 'nextTick'] });
  resetDb();
  ensureStarterData(USER);
  seedCatalog();
  setHouseholdFeatures(null);
  listId = getDefaultListId(USER)!;
  shownId = listId;
  mockPath.current = '/lists';
  mockInvites.current = [];
  mockPush.mockClear();
  mockBack.mockClear();
  mockNavigate.mockClear();
  mockOpenLink.mockClear();
  jest.mocked(categorizePending).mockClear();
});

afterEach(() => {
  const shown = tree;
  tree = null;
  act(() => shown?.unmount());
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function render(): ReactTestRenderer {
  act(() => {
    tree = create(<ListScreen id={shownId} />);
  });
  return tree!;
}
/** Re-reads the database, as the live queries would after a write from elsewhere. */
const refresh = () => act(() => tree!.update(<ListScreen id={shownId} />));

const all = (type: string, root: ReactTestInstance = tree!.root) => root.findAll((n) => n.type === (type as never));
const rows = (root?: ReactTestInstance) => all('ItemRow', root);
const rowNames = (root?: ReactTestInstance) => rows(root).map((r) => r.props.item.displayName as string);
const row = (name: string) => rows().find((r) => r.props.item.displayName === name)!;
const sections = () => all('FoldingSection');
const section = (title: string) => sections().find((s) => s.props.title === title)!;
/** The add bar, opened with the tab bar's + first if it's hidden, as it is at rest. */
const addBar = () => {
  if (all('ItemAddBar').length === 0) act(() => pressAddButton());
  return all('ItemAddBar')[0];
};
/** Acts on the add bar, opened first outside the act so it's on screen. */
const onBar = (fn: (bar: ReactTestInstance) => void) => {
  const bar = addBar();
  act(() => fn(bar));
};
/** Adds as the user would have, a second after the last add. */
function put(value: string, list = listId) {
  jest.setSystemTime(Date.now() + 1000);
  return addItem(list, value, USER);
}
/** A Text's whole string, nested Texts (a toast's bold name) included. */
const textOf = (n: ReactTestInstance): string =>
  n.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
/** Every Text drawn on screen, one per line. */
const lines = () => tree!.root.findAll((n) => n.type === ('Text' as never)).map(textOf);
const text = () => lines().join('\n');
const hostByLabel = (label: string) =>
  tree!.root.find((n) => typeof n.type === 'string' && n.props.accessibilityLabel === label);
const pressable = (label: string) =>
  tree!.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && 'onPress' in n.props);
/** The invite dot on the switcher's chevron: the one view drawn past the chevron's corner. */
const inviteDots = (switcher: ReactTestInstance) =>
  switcher.findAll((n) => n.type === ('View' as never) && (StyleSheet.flatten(n.props.style)?.top ?? 0) < 0);
const menuAction = (title: string) => all('ToolbarMenuAction').find((n) => n.props.children === title)!;
/** The ⋯ menu. */
const moreMenu = () => all('ToolbarMenu').find((n) => n.props.icon === 'ellipsis')!;
/**
 * The view menu beside ⋯ (spec 4.6), read as the old view pill's props: the ticked view, a change of view, and
 * Reset order while it's offered. Views are told apart by icon, so it reads the same in any language.
 */
const viewMenu = () => {
  const actions = all('ToolbarMenuAction', all('ToolbarMenu').find((n) => n.props.icon === 'arrow.up.arrow.down')!);
  const reset = actions.find((n) => n.props.icon === 'arrow.uturn.backward');
  const modeOf = (n: ReactTestInstance) => LIST_VIEW_MODES.find((m) => m.icon === n.props.icon)?.value;
  return {
    props: {
      value: modeOf(actions.find((n) => n.props.isOn)!),
      onChange: (mode: string) => actions.find((n) => modeOf(n) === mode)!.props.onPress(),
      onResetOrder: reset ? () => reset.props.onPress() : undefined,
    },
  };
};
/** The list switcher's label, which carries the count to get. */
const switcherLabel = (): string =>
  tree!.root.findAll((n) => typeof n.props.accessibilityHint === 'string' && n.props.accessibilityHint === 'Shows your other lists')[0]
    .props.accessibilityLabel;
// Braces: an onPress that returns a promise (Share.share) would make act async.
const press = (n: ReactTestInstance) =>
  act(() => {
    n.props.onPress();
  });
const tapToast = (label: string) => act(() => hostByLabel(label).props.onClick());
/** An add from the bar; the live query then re-reads, as it would on the write. */
const add = (value: string) => {
  onBar((bar) => bar.props.onAdd(value));
  refresh();
};
/** The ⋯ menu's inline groups, each as its actions' titles. */
const menuGroups = () =>
  all('ToolbarMenu', moreMenu())
    .filter((m) => m.props.inline)
    .map((g) => all('ToolbarMenuAction', g).map((n) => n.props.children));
const setView = (mode: string) => act(() => viewMenu().props.onChange(mode));

describe('the list', () => {
  test('a missing list renders nothing', () => {
    shownId = 'gone';
    render();
    expect(rows()).toHaveLength(0);
    expect(all('ItemAddBar')).toHaveLength(0);
  });

  test('an empty list says so and offers the add bar', () => {
    render();
    expect(lines()).toContain('Your list is empty');
    expect(lines()).toContain("Add what you need, or pull in a recipe's ingredients in one go.");
    expect(addBar().props.placeholder).toBeTruthy();
    expect(lines()).toContain('Groceries');
    expect(switcherLabel()).not.toContain('to get');
  });

  describe('the empty list (board C)', () => {
    const viewMenuNode = () => all('ToolbarMenu').find((n) => n.props.icon === 'arrow.up.arrow.down')!;
    const emptyStates = () => tree!.root.findAll((n) => n.type === EmptyState);

    test('shows the cart tile, the title as a header, the message and both actions in order', () => {
      render();
      const [empty] = emptyStates();
      expect(empty.props.icon).toBe('cart');
      expect(empty.props.title).toBe('Your list is empty');
      expect(empty.props.message).toBe("Add what you need, or pull in a recipe's ingredients in one go.");
      const titleText = tree!.root.find((n) => n.type === ('Text' as never) && n.props.children === 'Your list is empty');
      expect(titleText.props.accessibilityRole).toBe('header');
      const labels = lines();
      expect(labels.indexOf('Your list is empty')).toBeLessThan(labels.indexOf('Add an item'));
      expect(labels.indexOf('Add an item')).toBeLessThan(labels.indexOf('Add from a recipe'));
      // Add an item is a soft pill with a + glyph; Add from a recipe a plain primary button with fork.knife.
      const pill = tree!.root.find((n) => n.type === Pill);
      expect(pill.props).toMatchObject({ label: 'Add an item', soft: true, icon: 'plus' });
      const button = tree!.root.find((n) => n.type === Button && n.props.label === 'Add from a recipe');
      expect(button.props).toMatchObject({ variant: 'plain', icon: 'fork.knife' });
    });

    test('both actions have at least a 44 pt tap target', () => {
      render();
      const target = (label: string) => {
        const host = hostByLabel(label);
        const height = StyleSheet.flatten(host.props.style).minHeight as number;
        const slop = (host.props.hitSlop ?? 0) as number;
        return height + slop * 2;
      };
      expect(target('Add an item')).toBeGreaterThanOrEqual(44);
      expect(target('Add from a recipe')).toBeGreaterThanOrEqual(44);
    });

    test('Add an item opens the add bar, focused, as the tab bar + does', () => {
      render();
      expect(all('ItemAddBar')).toHaveLength(0);
      press(pressable('Add an item'));
      expect(all('ItemAddBar')).toHaveLength(1);
      expect(all('ItemAddBar')[0].props.autoFocus).toBe(true);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    test('Add from a recipe opens the Recipes tab', () => {
      render();
      press(pressable('Add from a recipe'));
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('/recipes');
      expect(mockPush).not.toHaveBeenCalled();
      expect(all('ItemAddBar')).toHaveLength(0);
    });

    test('the view menu is hidden while the list is empty and back once an item is added; ⋯ stays', () => {
      render();
      expect(viewMenuNode().props.hidden).toBe(true);
      expect(moreMenu().props.hidden).toBe(false);
      add('milk');
      expect(viewMenuNode().props.hidden).toBe(false);
      expect(emptyStates()).toHaveLength(0);
      expect(lines()).not.toContain('Your list is empty');
    });

    test('a list with only checked items is not empty: no empty state, and the view menu shows', () => {
      for (const name of ['milk', 'egg']) {
        const added = put(name)!;
        setItemChecked(added.itemId, true, USER);
      }
      render();
      expect(switcherLabel()).not.toContain('to get');
      expect(rowNames().sort()).toEqual(['egg', 'milk']);
      expect(emptyStates()).toHaveLength(0);
      expect(lines()).not.toContain('Your list is empty');
      expect(viewMenuNode().props.hidden).toBe(false);
    });

    test('Select mode still hides the view menu once there are items', () => {
      put('milk');
      render();
      expect(viewMenuNode().props.hidden).toBe(false);
      press(menuAction('Select items'));
      expect(viewMenuNode().props.hidden).toBe(true);
    });
  });

  test('the name is the list switcher, opening Your lists', () => {
    put('milk');
    render();
    const switcher = pressable('Groceries, switch list, 1 to get');
    expect(switcher.props.accessibilityHint).toBe('Shows your other lists');
    expect(switcher.props.accessibilityRole).toBe('button');
    expect(inviteDots(switcher)).toHaveLength(0);
    // The count is a badge after the chevron; the view is a menu beside ⋯.
    expect(lines()).toContain('1');
    expect(viewMenu().props.value).toBe('newest');
    // One line: a long name truncates so the chevron and ⋯ stay in view.
    expect(switcher.find((n) => n.props.variant === 'screenTitle').props.numberOfLines).toBe(1);
    press(switcher);
    expect(mockPush).toHaveBeenCalledWith('/lists-sheet');
  });

  test('with invites waiting, the switcher wears a dot and says how many', () => {
    const invite = { id: 'inv-1', householdName: 'The Smiths' } as MyInvite;
    mockInvites.current = [invite];
    render();
    expect(inviteDots(pressable('Groceries, switch list, 1 invite waiting'))).toHaveLength(1);
    act(() => tree!.unmount());
    mockInvites.current = [invite, { ...invite, id: 'inv-2' }];
    render();
    press(pressable('Groceries, switch list, 2 invites waiting'));
    expect(mockPush).toHaveBeenCalledWith('/lists-sheet');
  });

  test('light status bar on the List tab and over this list\'s sheets, not elsewhere', () => {
    const lightBars = () => tree!.root.findAll((n) => n.type === StatusBar && n.props.style === 'light');
    render();
    expect(lightBars()).toHaveLength(1);
    mockPath.current = `/list/${listId}/item/x`;
    refresh();
    expect(lightBars()).toHaveLength(1);
    mockPath.current = '/lists-sheet';
    refresh();
    expect(lightBars()).toHaveLength(0);
    mockPath.current = '/list/other/item/x';
    refresh();
    expect(lightBars()).toHaveLength(0);
  });

  test('opening the list records it for the next launch and Siri', () => {
    render();
    expect(recordListOpened).toHaveBeenCalledWith(listId, USER);
  });

  test('As added (the default): one card, latest first, each row read with its aisle', () => {
    put('milk');
    put('bananas');
    put('kombucha');
    render();
    expect(viewMenu().props.value).toBe('newest');
    expect(sections()).toHaveLength(0);
    expect(rowNames()).toEqual(['kombucha', 'bananas', 'milk']);
    expect(row('milk').props.aisle).toEqual({ name: 'Dairy & Eggs' });
    // Not categorized yet: Sorting….
    expect(row('kombucha').props.sorting).toBe(true);
    expect(switcherLabel()).toContain('3 to get');
  });

  test('By aisle: a card per aisle in order, a Sorting… card without a header, and the choice is remembered', () => {
    put('milk');
    put('bananas');
    put('eggs');
    put('kombucha');
    render();
    setView('category');
    expect(getDeviceSetting(viewModeKey(listId), null)).toBe('category');
    expect(sections().map((s) => [s.props.title, s.props.count])).toEqual([
      ['Produce', 1],
      ['Dairy & Eggs', 2],
    ]);
    expect(rowNames(section('Dairy & Eggs'))).toEqual(['milk', 'eggs']);
    // Sorting… comes first, with no header.
    expect(rowNames()[0]).toBe('kombucha');
    expect(row('kombucha').props.sorting).toBe(true);
    // Rows under an aisle header don't repeat the aisle for VoiceOver.
    expect(row('milk').props.aisle).toBeUndefined();
    // The view comes back on the next visit.
    act(() => tree!.unmount());
    render();
    expect(viewMenu().props.value).toBe('category');
  });

  test('on a plan with no features (free), new names still wait in Sorting…', () => {
    const household = db.select().from(households).get()!.id;
    setHouseholdFeatures({ [household]: [] });
    put('kombucha');
    render();
    setView('category');
    expect(sections().map((s) => s.props.title)).toEqual([]);
    expect(row('kombucha').props.sorting).toBe(true);
  });

  test('Aisle colours "header" colours the aisle header instead of the rows', () => {
    put('milk');
    setAisleColorStyle('header');
    render();
    setView('category');
    expect(section('Dairy & Eggs').props.band).toBeDefined();
    expect(row('milk').props.look).toBeUndefined();
  });

  test('rows are tinted by aisle by default', () => {
    put('milk');
    render();
    setView('category');
    expect(section('Dairy & Eggs').props.band).toBeUndefined();
    expect(row('milk').props.look).toBeDefined();
  });

  test('Item rows "white" keeps rows the card colour, with the aisle colour on the check', () => {
    put('milk');
    setItemRowStyle('white');
    render();
    setView('category');
    expect(row('milk').props.look.tint).toBe(row('milk').props.background);
    expect(row('milk').props.look.ring).toBeDefined();
  });

  test('white rows give way to plain rows under a coloured aisle header', () => {
    put('milk');
    setItemRowStyle('white');
    setAisleColorStyle('header');
    render();
    setView('category');
    expect(row('milk').props.look).toBeUndefined();
  });
});

describe('checking off', () => {
  test('a checked row lingers in place, then moves to Checked, which opens on tap', () => {
    put('milk');
    put('eggs');
    render();
    act(() => row('milk').props.onToggle());
    // Still in the card, drawn checked.
    expect(rowNames()).toEqual(['eggs', 'milk']);
    expect(row('milk').props.item.checkedAt).not.toBeNull();
    act(() => jest.advanceTimersByTime(CHECK_LINGER_MS));
    expect(rowNames()).toEqual(['eggs']);
    expect(switcherLabel()).toContain('1 to get');
    const header = pressable('Checked, 1 item');
    press(header);
    expect(rowNames()).toEqual(['eggs', 'milk']);
    press(pressable('Checked, 1 item'));
    expect(rowNames()).toEqual(['eggs']);
  });

  test('tapping a lingering row again takes it back', () => {
    put('milk');
    render();
    act(() => row('milk').props.onToggle());
    act(() => row('milk').props.onToggle());
    act(() => jest.advanceTimersByTime(CHECK_LINGER_MS));
    expect(row('milk').props.item.checkedAt).toBeNull();
    expect(text()).not.toContain('Checked,');
  });

  test('checks in a row linger together, and move at once after the last', () => {
    put('milk');
    put('eggs');
    put('bread');
    render();
    act(() => row('milk').props.onToggle());
    act(() => jest.advanceTimersByTime(CHECK_LINGER_MS - 100));
    act(() => row('eggs').props.onToggle());
    // Milk's own moment is over, but the second check started it again for both.
    act(() => jest.advanceTimersByTime(CHECK_LINGER_MS - 100));
    expect(rowNames()).toEqual(['bread', 'eggs', 'milk']);
    act(() => jest.advanceTimersByTime(100));
    expect(rowNames()).toEqual(['bread']);
  });

  test('a touch on the list holds lingering rows in place', () => {
    put('milk');
    put('eggs');
    render();
    act(() => row('milk').props.onToggle());
    const viewport = tree!.root.find((n) => typeof n.type !== 'string' && n.props.testID === 'list-viewport');
    act(() => jest.advanceTimersByTime(CHECK_LINGER_MS - 100));
    act(() => viewport.props.onTouchStart());
    act(() => jest.advanceTimersByTime(CHECK_LINGER_MS - 100));
    expect(rowNames()).toEqual(['eggs', 'milk']);
    act(() => jest.advanceTimersByTime(100));
    expect(rowNames()).toEqual(['eggs']);
  });

  test('taking one lingering row back leaves the others lingering', () => {
    put('milk');
    put('eggs');
    put('bread');
    render();
    act(() => row('milk').props.onToggle());
    act(() => row('eggs').props.onToggle());
    act(() => row('milk').props.onToggle());
    expect(row('milk').props.item.checkedAt).toBeNull();
    expect(rowNames()).toEqual(['bread', 'eggs', 'milk']);
    act(() => jest.advanceTimersByTime(CHECK_LINGER_MS));
    expect(rowNames()).toEqual(['bread', 'milk']);
  });

  test('unchecking from Checked puts the item back', () => {
    const { itemId } = put('milk')!;
    setItemChecked(itemId, true, USER);
    render();
    // Nothing left to get, so Checked is already open.
    act(() => row('milk').props.onToggle());
    expect(text()).not.toContain('Checked,');
    expect(rowNames()).toEqual(['milk']);
  });

  test('Clear removes the checked items, and Undo brings them back', () => {
    const a = put('milk')!;
    const b = put('eggs')!;
    put('bread');
    setItemChecked(a.itemId, true, USER);
    setItemChecked(b.itemId, true, USER);
    render();
    act(() => hostByLabel('Clear 2 checked items').props.onClick());
    expect(text()).toContain('Cleared 2 items');
    expect(text()).not.toContain('Checked,');
    tapToast('Undo');
    expect(pressable('Checked, 2 items')).toBeDefined();
    expect(text()).not.toContain('Cleared');
  });

  test('long-pressing the Checked header offers Clear and Uncheck all', () => {
    const a = put('milk')!;
    setItemChecked(a.itemId, true, USER);
    const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((options, callback) => {
      expect(options.options).toEqual(['Clear 1 checked item', 'Uncheck all', 'Cancel']);
      callback(1);
    });
    render();
    act(() => pressable('Checked, 1 item').props.onLongPress());
    expect(sheet).toHaveBeenCalled();
    refresh();
    expect(text()).not.toContain('Checked,');
    expect(rowNames()).toEqual(['milk']);
  });

  test('a section\'s Check all checks its rows, with Undo', () => {
    put('milk');
    put('eggs');
    put('bananas');
    render();
    setView('category');
    act(() => section('Dairy & Eggs').props.onSwipeCheck());
    expect(text()).toContain('Checked 2 items');
    expect(sections().map((s) => s.props.title)).toEqual(['Produce']);
    tapToast('Undo');
    expect(sections().map((s) => s.props.title)).toEqual(['Produce', 'Dairy & Eggs']);
  });
});

describe('the check-off haptic (spec 4.1)', () => {
  const tick = () => jest.mocked(Haptics.selectionAsync);
  const impact = () => jest.mocked(Haptics.impactAsync);
  beforeEach(() => {
    tick().mockClear();
    impact().mockClear();
  });

  test('checking an item (tap or swipe, both the row\'s onToggle) plays one tick and no impact', () => {
    put('milk');
    put('eggs');
    render();
    act(() => row('milk').props.onToggle());
    expect(tick()).toHaveBeenCalledTimes(1);
    act(() => row('eggs').props.onToggle());
    expect(tick()).toHaveBeenCalledTimes(2);
    expect(impact()).not.toHaveBeenCalled();
  });

  test('unchecking plays nothing, whether a lingering row or one in Checked', () => {
    const { itemId } = put('milk')!;
    put('eggs');
    setItemChecked(itemId, true, USER);
    render();
    press(pressable('Checked, 1 item'));
    act(() => row('milk').props.onToggle());
    refresh();
    expect(row('milk').props.item.checkedAt).toBeNull();
    expect(tick()).not.toHaveBeenCalled();
    // Checked, then taken back while it lingers: the check ticks, the take-back doesn't.
    act(() => row('eggs').props.onToggle());
    act(() => row('eggs').props.onToggle());
    expect(row('eggs').props.item.checkedAt).toBeNull();
    expect(tick()).toHaveBeenCalledTimes(1);
  });

  test('a tap in Select mode selects without a tick', () => {
    put('milk');
    put('eggs');
    render();
    act(() => row('milk').props.onSelect());
    act(() => row('eggs').props.onToggle());
    act(() => row('milk').props.onToggle());
    expect(text()).toContain('1 selected');
    expect(row('milk').props.item.checkedAt).toBeNull();
    expect(tick()).not.toHaveBeenCalled();
  });

  test('a header swipe\'s Check all ticks once, however many items it checks; its Undo doesn\'t', () => {
    put('milk');
    put('eggs');
    put('bananas');
    render();
    setView('category');
    act(() => section('Dairy & Eggs').props.onSwipeCheck());
    expect(text()).toContain('Checked 2 items');
    expect(tick()).toHaveBeenCalledTimes(1);
    expect(impact()).not.toHaveBeenCalled();
    tapToast('Undo');
    expect(tick()).toHaveBeenCalledTimes(1);
  });

  test('Check all from a recipe\'s menu: the long-press impact, then one tick', () => {
    const recipeId = createRecipe('Tacos', getList(listId)!.householdId);
    addRecipeIngredient(recipeId, 'tortillas');
    addRecipeIngredient(recipeId, 'limes');
    addWholeRecipeToList(listId, recipeId, USER);
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => callback(0));
    render();
    setView('recipe');
    act(() => section('Tacos').props.onLongPress());
    expect(text()).toContain('Checked 2 items');
    expect(impact()).toHaveBeenCalledTimes(1);
    expect(tick()).toHaveBeenCalledTimes(1);
  });

  test('Check all as an aisle header\'s VoiceOver action ticks once too', () => {
    put('milk');
    put('eggs');
    render();
    setView('category');
    const actions = section('Dairy & Eggs').props.actions as { label: string; onPress: () => void }[];
    act(() => actions.find((a) => a.label === 'Check all')!.onPress());
    expect(text()).toContain('Checked 2 items');
    expect(tick()).toHaveBeenCalledTimes(1);
  });

  test('Uncheck all plays no tick', () => {
    const { itemId } = put('milk')!;
    setItemChecked(itemId, true, USER);
    render();
    press(pressable('Uncheck all'));
    refresh();
    expect(rowNames()).toEqual(['milk']);
    expect(tick()).not.toHaveBeenCalled();
  });
});

describe('adding', () => {
  test('an add lands on the list and is sent for categorizing', () => {
    render();
    add('2 kombucha');
    expect(rowNames()).toEqual(['kombucha']);
    expect(row('kombucha').props.item.amountText).toBe('2');
    expect(categorizePending).toHaveBeenCalledWith(['kombucha']);
  });

  test('adding what is already open combines, tints the row and offers Undo', () => {
    put('1 milk');
    render();
    add('1 milk');
    expect(rowNames()).toEqual(['milk']);
    expect(text()).toContain('Added to Milk, now 2');
    expect(row('milk').props.tint).toBeDefined();
    tapToast('Undo');
    expect(row('milk').props.item.amountText).toBe('1');
    expect(row('milk').props.tint).toBeUndefined();
  });

  test('add mode: the title collapses into the header and matching items say "already on list"', () => {
    put('milk');
    put('eggs');
    render();
    onBar((bar) => bar.props.onFocusChange(true));
    onBar((bar) => bar.props.onTextChange('2 mil'));
    expect(hostByLabel('Groceries, 2 to get · As added')).toBeDefined();
    // The big switcher title leaves the header's left slot while the compact one stands in.
    expect(tree!.root.findAll((n) => n.props.accessibilityLabel === 'Groceries, switch list')).toHaveLength(0);
    // Part of a word marks nothing; the whole word does.
    expect(row('milk').props.alreadyOnList).toBeUndefined();
    onBar((bar) => bar.props.onTextChange('2 Milk'));
    expect(row('milk').props.alreadyOnList).toEqual({ query: 'milk' });
    expect(row('eggs').props.alreadyOnList).toBeUndefined();
    onBar((bar) => bar.props.onFocusChange(false));
    expect(row('milk').props.alreadyOnList).toBeUndefined();
  });

  // `pepino` is linked to `cucumber`; `tomate` and `tomato` are not linked.
  const insertTwins = () => {
    const produce = cat('produce');
    db.insert(ingredients)
      .values([
        { normalizedName: 'cucumber', displayName: 'cucumber', defaultCategoryId: produce, status: 'categorized', lang: 'en' },
        { normalizedName: 'pepino', displayName: 'pepino', defaultCategoryId: produce, status: 'categorized', lang: 'es', sameAs: 'cucumber', linkedBy: 'seed' },
        { normalizedName: 'tomato', displayName: 'tomato', defaultCategoryId: produce, status: 'categorized', lang: 'en' },
        { normalizedName: 'tomate', displayName: 'tomate', defaultCategoryId: produce, status: 'categorized', lang: 'es' },
      ])
      .run();
  };
  /** Combine English and Spanish names (spec 4.15) for every household, as a pull would set it. */
  const setCombine = (on: boolean) => db.update(households).set({ combineLanguages: on }).run();
  const type = (value: string) => onBar((bar) => bar.props.onTextChange(value));

  describe('add mode across a family, Combine English and Spanish names off (spec 4.15)', () => {
    beforeEach(insertTwins);

    test('typing pepino marks nothing beside Cucumber, and cucumber nothing beside Pepino', () => {
      put('Cucumber');
      put('Pepino');
      render();
      onBar((bar) => bar.props.onFocusChange(true));
      type('2 pepinos');
      expect(row('Cucumber').props.alreadyOnList).toBeUndefined();
      expect(row('Pepino').props.alreadyOnList).toEqual({ query: 'pepino' });
      type('cucumber');
      expect(row('Cucumber').props.alreadyOnList).toEqual({ query: 'cucumber' });
      expect(row('Pepino').props.alreadyOnList).toBeUndefined();
    });

    test('adding pepino beside Cucumber, and cucumber beside Pepino, makes new items', () => {
      put('Cucumber');
      render();
      add('2 pepinos');
      expect(rowNames()).toEqual(['Cucumber', 'pepinos']);
      expect(text()).not.toContain('Added to Cucumber');
      add('cucumber');
      expect(rowNames()).toEqual(['Cucumber', 'pepinos']);
      expect(text()).toContain('Added to Cucumber, now 2');
    });

    test('turning it on marks the twin at once, and leaves open twins as two items', () => {
      put('Cucumber');
      put('Pepino');
      render();
      onBar((bar) => bar.props.onFocusChange(true));
      type('pepino');
      expect(row('Cucumber').props.alreadyOnList).toBeUndefined();
      setCombine(true);
      refresh();
      expect(row('Cucumber').props.alreadyOnList).toEqual({ query: 'cucumber' });
      expect(rowNames()).toEqual(['Pepino', 'Cucumber']);
    });
  });

  describe('add mode across a family (spec 4.15)', () => {
    beforeEach(() => {
      insertTwins();
      setCombine(true);
    });

    test('typing pepino marks an unchecked Cucumber, highlighting its own name', () => {
      put('Cucumber');
      put('milk');
      render();
      onBar((bar) => bar.props.onFocusChange(true));
      type('2 pepinos');
      expect(row('Cucumber').props.alreadyOnList).toEqual({ query: 'cucumber' });
      expect(row('milk').props.alreadyOnList).toBeUndefined();
    });

    test('typing cucumber marks an unchecked Pepino', () => {
      put('Pepino');
      render();
      onBar((bar) => bar.props.onFocusChange(true));
      type('cucumber');
      expect(row('Pepino').props.alreadyOnList).toEqual({ query: 'cucumber' });
      type('pepino');
      expect(row('Pepino').props.alreadyOnList).toEqual({ query: 'pepino' });
      // Part of a word still marks nothing.
      type('cucu');
      expect(row('Pepino').props.alreadyOnList).toBeUndefined();
    });

    test('adding pepino beside Cucumber adds to it, keeping its name (spec 4.4)', () => {
      put('Cucumber');
      render();
      add('2 pepinos');
      expect(rowNames()).toEqual(['Cucumber']);
      expect(text()).toContain('Added to Cucumber, now 3');
    });

    test('adding cucumber beside Pepino adds to it, and Undo takes it back', () => {
      put('Pepino');
      render();
      add('cucumber');
      expect(rowNames()).toEqual(['Pepino']);
      expect(text()).toContain('Added to Pepino, now 2');
      tapToast('Undo');
      refresh();
      expect(rowNames()).toEqual(['Pepino']);
      expect(row('Pepino').props.item.amountText).toBe('');
    });

    test('an unlinked pair stays two items', () => {
      put('Tomato');
      render();
      add('tomate');
      expect(rowNames()).toEqual(['Tomato', 'tomate']);
    });

    test('an unlinked pair marks nothing either way', () => {
      put('Tomato');
      put('Tomate');
      render();
      onBar((bar) => bar.props.onFocusChange(true));
      type('tomate');
      expect(row('Tomato').props.alreadyOnList).toBeUndefined();
      expect(row('Tomate').props.alreadyOnList).toEqual({ query: 'tomate' });
      type('tomato');
      expect(row('Tomato').props.alreadyOnList).toEqual({ query: 'tomato' });
      expect(row('Tomate').props.alreadyOnList).toBeUndefined();
    });

    test('a checked twin is not marked', () => {
      const { itemId } = put('Cucumber')!;
      setItemChecked(itemId, true, USER);
      // Added before the link, as an add now reopens the checked Cucumber.
      const pepino = eq(ingredients.normalizedName, 'pepino');
      db.update(ingredients).set({ sameAs: null, linkedBy: null }).where(pepino).run();
      put('Pepino');
      db.update(ingredients).set({ sameAs: 'cucumber', linkedBy: 'seed' }).where(pepino).run();
      render();
      press(pressable('Checked, 1 item'));
      onBar((bar) => bar.props.onFocusChange(true));
      type('pepino');
      expect(row('Cucumber').props.item.checkedAt).not.toBeNull();
      expect(row('Cucumber').props.alreadyOnList).toBeUndefined();
      expect(row('Pepino').props.alreadyOnList).toEqual({ query: 'pepino' });
      type('cucumber');
      expect(row('Cucumber').props.alreadyOnList).toBeUndefined();
      expect(row('Pepino').props.alreadyOnList).toEqual({ query: 'cucumber' });
    });
  });

  test('a recipe chip adds the whole recipe with Undo and Adjust', () => {
    const recipeId = createRecipe('Tacos', getList(listId)!.householdId);
    addRecipeIngredient(recipeId, 'tortillas');
    addRecipeIngredient(recipeId, 'limes');
    render();
    onBar((bar) => bar.props.onAddRecipe({ id: recipeId, name: 'Tacos', ingredientCount: 2 }));
    expect(rowNames().sort()).toEqual(['limes', 'tortillas']);
    expect(text()).toContain('Added Tacos · 2 items');
    tapToast('Adjust');
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/recipe/[id]/add-to-list',
      params: { id: recipeId, list: listId, adjust: expect.any(String) },
    });
  });

  test('a recipe chip leaves the staples off and names them on a second line', () => {
    const householdId = getList(listId)!.householdId;
    const recipeId = createRecipe('Tacos', householdId);
    addRecipeIngredient(recipeId, 'tortillas');
    addRecipeIngredient(recipeId, 'salt');
    addRecipeIngredient(recipeId, 'limes');
    addRecipeIngredient(recipeId, 'pepper');
    setStaple(householdId, 'salt', true, USER);
    setStaple(householdId, 'pepper', true, USER);
    render();
    onBar((bar) => bar.props.onAddRecipe({ id: recipeId, name: 'Tacos', ingredientCount: 4 }));
    expect(rowNames().sort()).toEqual(['limes', 'tortillas']);
    expect(lines()).toContain('Added Tacos · 2 items\nSkipped salt, pepper');
    expect(hostByLabel('Undo')).toBeDefined();
    tapToast('Adjust');
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/recipe/[id]/add-to-list',
      params: { id: recipeId, list: listId, adjust: expect.any(String) },
    });
  });

  test('a recipe chip with more than three staples names two and counts the rest', () => {
    const householdId = getList(listId)!.householdId;
    const recipeId = createRecipe('Tacos', householdId);
    for (const name of ['tortillas', 'salt', 'pepper', 'olive oil', 'water']) addRecipeIngredient(recipeId, name);
    for (const name of ['salt', 'pepper', 'olive oil', 'water']) setStaple(householdId, name, true, USER);
    render();
    onBar((bar) => bar.props.onAddRecipe({ id: recipeId, name: 'Tacos', ingredientCount: 5 }));
    expect(rowNames()).toEqual(['tortillas']);
    expect(lines()).toContain('Added Tacos · 1 item\nSkipped salt, pepper and 2 more');
  });

  test('a recipe chip with no staples has no second line', () => {
    const householdId = getList(listId)!.householdId;
    const recipeId = createRecipe('Tacos', householdId);
    addRecipeIngredient(recipeId, 'salt');
    setStaple(householdId, 'salt', true, USER);
    setStaple(householdId, 'salt', false, USER);
    render();
    onBar((bar) => bar.props.onAddRecipe({ id: recipeId, name: 'Tacos', ingredientCount: 1 }));
    expect(rowNames()).toEqual(['salt']);
    expect(lines()).toContain('Added Tacos · 1 item');
    expect(text()).not.toContain('Skipped');
  });

  test('a recipe chip that is all staples adds nothing and offers only Adjust', () => {
    const householdId = getList(listId)!.householdId;
    const recipeId = createRecipe('Tacos', householdId);
    addRecipeIngredient(recipeId, 'Salt');
    addRecipeIngredient(recipeId, 'pepper');
    setStaple(householdId, 'salt', true, USER);
    setStaple(householdId, 'pepper', true, USER);
    render();
    onBar((bar) => bar.props.onAddRecipe({ id: recipeId, name: 'Tacos', ingredientCount: 2 }));
    expect(rows()).toHaveLength(0);
    expect(lines()).toContain('You always have everything in Tacos');
    expect(text()).not.toContain('Added');
    expect(tree!.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityLabel === 'Undo')).toHaveLength(0);
    tapToast('Adjust');
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/recipe/[id]/add-to-list',
      params: { id: recipeId, list: listId, adjust: expect.any(String) },
    });
  });

  test('Undo on a recipe add takes its items back', () => {
    const recipeId = createRecipe('Tacos', getList(listId)!.householdId);
    addRecipeIngredient(recipeId, 'tortillas');
    render();
    onBar((bar) => bar.props.onAddRecipe({ id: recipeId, name: 'Tacos', ingredientCount: 1 }));
    tapToast('Undo');
    expect(rows()).toHaveLength(0);
  });

  test('a recipe gone since is ignored', () => {
    render();
    onBar((bar) => bar.props.onAddRecipe({ id: 'gone', name: 'Gone', ingredientCount: 1 }));
    expect(rows()).toHaveLength(0);
    expect(text()).not.toContain('Added');
  });
});

describe('a row', () => {
  test('tap opens its details sheet', () => {
    const { itemId } = put('milk')!;
    render();
    act(() => row('milk').props.onEdit());
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/list/[id]/item/[itemId]', params: { id: listId, itemId } });
  });

  test('delete removes it, with Undo', () => {
    put('milk');
    render();
    act(() => row('milk').props.onDelete());
    expect(rows()).toHaveLength(0);
    expect(text()).toContain('Deleted Milk');
    tapToast('Undo');
    expect(rowNames()).toEqual(['milk']);
  });
});

describe('Select mode', () => {
  test('long-press selects a row; the bar counts them and Add to recipe opens the sheet', () => {
    const milk = put('milk')!;
    const eggs = put('eggs')!;
    render();
    act(() => row('milk').props.onSelect());
    expect(all('ItemAddBar')).toHaveLength(0);
    expect(text()).toContain('1 selected');
    expect(row('milk').props.selected).toBe(true);
    expect(row('eggs').props.selected).toBe(false);
    // While selecting, a tap selects instead of checking.
    act(() => row('eggs').props.onToggle());
    expect(text()).toContain('2 selected');
    expect(row('eggs').props.item.checkedAt).toBeNull();
    act(() => pressable('Add to recipe').props.onPress());
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/list/[id]/add-to-recipe',
      params: { id: listId, items: `${milk.itemId},${eggs.itemId}` },
    });
  });

  test('Select items starts with nothing selected; Done leaves', () => {
    put('milk');
    render();
    press(menuAction('Select items'));
    expect(text()).toContain('Tap items to select them');
    expect(pressable('Add to recipe').props.disabled).toBe(true);
    const done = all('ToolbarButton').find((b) => b.props.children === 'Done')!;
    press(done);
    // The add bar stays hidden, as at rest, until the tab bar's + opens it.
    expect(all('ItemAddBar')).toHaveLength(0);
    expect(row('milk').props.selected).toBeUndefined();
  });

  test('Select All picks every unchecked item, folded or not, and then reads Deselect All', () => {
    put('milk');
    put('eggs');
    const jam = put('jam')!;
    setItemChecked(jam.itemId, true, USER);
    render();
    press(menuAction('Select items'));
    expect(pressable('Delete 0 items').props.disabled).toBe(true);
    act(() => pressable('Select All').props.onPress());
    expect(text()).toContain('2 selected');
    expect(row('milk').props.selected).toBe(true);
    expect(row('eggs').props.selected).toBe(true);
    act(() => pressable('Deselect All').props.onPress());
    expect(text()).toContain('Tap items to select them');
    expect(row('milk').props.selected).toBe(false);
  });

  test('Delete asks first; Cancel keeps the selection', () => {
    put('milk');
    put('eggs');
    const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((options, callback) => {
      expect(options.title).toBeUndefined();
      expect(options.options).toEqual(['Delete 2 items', 'Cancel']);
      expect(options.destructiveButtonIndex).toBe(0);
      callback(1);
    });
    render();
    act(() => row('milk').props.onSelect());
    act(() => row('eggs').props.onToggle());
    act(() => pressable('Delete 2 items').props.onPress());
    expect(sheet).toHaveBeenCalled();
    expect(rowNames().sort()).toEqual(['eggs', 'milk']);
    expect(text()).toContain('2 selected');
  });

  test('confirming Delete removes the selection, leaves Select mode, and Undo brings them back', () => {
    put('milk');
    put('eggs');
    put('bread');
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => callback(0));
    render();
    act(() => row('milk').props.onSelect());
    act(() => row('eggs').props.onToggle());
    act(() => pressable('Delete 2 items').props.onPress());
    expect(rowNames()).toEqual(['bread']);
    expect(row('bread').props.selected).toBeUndefined();
    expect(text()).toContain('Deleted 2 items');
    tapToast('Undo');
    expect(rowNames().sort()).toEqual(['bread', 'eggs', 'milk']);
  });

  test('coming back from Add to recipe leaves Select mode, shows By recipe and the toast', () => {
    put('milk');
    render();
    act(() => row('milk').props.onSelect());
    act(() => setRecipeAddResult({ kind: 'toRecipe', listId, recipeId: 'r1', recipeName: 'Pancakes', count: 1 }));
    expect(row('milk').props.selected).toBeUndefined();
    expect(viewMenu().props.value).toBe('recipe');
    expect(getDeviceSetting(viewModeKey(listId), null)).toBe('recipe');
    expect(text()).toContain('Added 1 item to Pancakes');
    tapToast('View recipe');
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]', params: { id: 'r1' } });
  });
});

describe('dragging in As added (spec 4.6)', () => {
  const drag = () => all('ReorderableRows')[0];
  const savedOrder = () => getDeviceSetting<unknown>(manualOrderKey(listId), null);
  const actionNames = (name: string) => (row(name).props.moves as RowMove[]).map((m) => m.name);
  const moveAction = (name: string, action: string) =>
    act(() => (row(name).props.moves as RowMove[]).find((m) => m.name === action)!.onPress());
  /** milk, eggs, bananas added in that order: As added reads bananas, eggs, milk. */
  function threeItems() {
    put('milk');
    put('eggs');
    put('bananas');
  }

  test('the order applies from a saved setting, with a new add above it', () => {
    threeItems();
    render();
    const at = (name: string) => addedAt(row(name).props.item);
    const id = (name: string) => row(name).props.item.id as string;
    const saved = ['milk', 'bananas', 'eggs'].map((name) => ({ id: id(name), at: at(name) }));
    act(() => tree!.unmount());
    setDeviceSetting(manualOrderKey(listId), saved);
    render();
    expect(rowNames()).toEqual(['milk', 'bananas', 'eggs']);
    // The header still reads As added.
    expect(viewMenu().props.value).toBe('newest');
    jest.setSystemTime(Date.now() + 1000);
    add('bread');
    expect(rowNames()).toEqual(['bread', 'milk', 'bananas', 'eggs']);
    // Garbage in storage counts as no order.
    act(() => tree!.unmount());
    setDeviceSetting(manualOrderKey(listId), 'nonsense');
    render();
    expect(rowNames()).toEqual(['bread', 'bananas', 'eggs', 'milk']);
    expect(viewMenu().props.onResetOrder).toBeUndefined();
  });

  test('a drop saves the whole order on screen, which survives leaving and switching views', () => {
    threeItems();
    render();
    expect(drag().props.draggable).toEqual([true, true, true]);
    // bananas (top) dropped at the bottom.
    act(() => drag().props.onMove(0, 2));
    expect(rowNames()).toEqual(['eggs', 'milk', 'bananas']);
    expect((savedOrder() as { id: string }[]).map((e) => e.id)).toEqual(
      ['eggs', 'milk', 'bananas'].map((name) => row(name).props.item.id),
    );
    setView('category');
    expect(all('ReorderableRows')).toHaveLength(0);
    setView('newest');
    expect(rowNames()).toEqual(['eggs', 'milk', 'bananas']);
    act(() => tree!.unmount());
    render();
    expect(rowNames()).toEqual(['eggs', 'milk', 'bananas']);
  });

  test('a long-press let go without moving still enters Select mode with the item selected', () => {
    threeItems();
    render();
    // The drag owns the row's long-press in As added.
    expect(row('milk').props.reorderable).toBe(true);
    act(() => drag().props.onSelect(row('milk').props.item.id));
    expect(text()).toContain('1 selected');
    expect(row('milk').props.selected).toBe(true);
    expect(row('eggs').props.selected).toBe(false);
    expect(savedOrder()).toBeNull();
    // No dragging, and no Move actions, while selecting.
    expect(drag().props.draggable).toEqual([false, false, false]);
    expect(row('milk').props.reorderable).toBe(false);
    expect(row('milk').props.moves).toBeUndefined();
  });

  test('no drag in add mode, By aisle or By recipe, where the row keeps its own long-press', () => {
    threeItems();
    render();
    onBar((bar) => bar.props.onFocusChange(true));
    expect(drag().props.draggable).toEqual([false, false, false]);
    expect(row('milk').props.reorderable).toBe(false);
    onBar((bar) => bar.props.onFocusChange(false));
    expect(drag().props.draggable).toEqual([true, true, true]);
    for (const mode of ['category', 'recipe']) {
      setView(mode);
      expect(row('milk').props.reorderable).toBe(false);
      expect(row('milk').props.moves).toBeUndefined();
      expect(row('milk').props.onSelect).toBeDefined();
    }
  });

  test('a checked row lingering in place doesn\'t move', () => {
    threeItems();
    render();
    act(() => row('eggs').props.onToggle());
    expect(drag().props.draggable).toEqual([true, false, true]);
    expect(row('eggs').props.moves).toBeUndefined();
  });

  test('VoiceOver Move up / Move down, left out at the ends, save and announce the new place', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    threeItems();
    render();
    expect(actionNames('bananas')).toEqual(['moveDown']);
    expect(actionNames('eggs')).toEqual(['moveUp', 'moveDown']);
    expect(actionNames('milk')).toEqual(['moveUp']);
    expect(row('milk').props.moves.map((m: RowMove) => m.label)).toEqual(['Move up']);
    moveAction('bananas', 'moveDown');
    expect(rowNames()).toEqual(['eggs', 'bananas', 'milk']);
    expect(announce).toHaveBeenLastCalledWith('Bananas, 2 of 3');
    moveAction('eggs', 'moveDown');
    expect(rowNames()).toEqual(['bananas', 'eggs', 'milk']);
    moveAction('milk', 'moveUp');
    expect(rowNames()).toEqual(['bananas', 'milk', 'eggs']);
    expect(announce).toHaveBeenLastCalledWith('Milk, 2 of 3');
    act(() => tree!.unmount());
    render();
    expect(rowNames()).toEqual(['bananas', 'milk', 'eggs']);
  });

  test('Reset order clears it with no confirm, and Undo puts it back', () => {
    threeItems();
    render();
    // Nothing saved yet: no Reset order.
    expect(viewMenu().props.onResetOrder).toBeUndefined();
    act(() => drag().props.onMove(0, 2));
    const saved = savedOrder();
    expect(rowNames()).toEqual(['eggs', 'milk', 'bananas']);
    // Only in As added.
    setView('category');
    expect(viewMenu().props.onResetOrder).toBeUndefined();
    setView('newest');
    act(() => viewMenu().props.onResetOrder!());
    expect(rowNames()).toEqual(['bananas', 'eggs', 'milk']);
    expect(savedOrder()).toBeNull();
    expect(text()).toContain('Order reset');
    expect(viewMenu().props.onResetOrder).toBeUndefined();
    expect(viewMenu().props.value).toBe('newest');
    tapToast('Undo');
    expect(rowNames()).toEqual(['eggs', 'milk', 'bananas']);
    expect(savedOrder()).toEqual(saved);
    expect(text()).not.toContain('Order reset');
    expect(viewMenu().props.onResetOrder).toBeDefined();
  });

  test('the Order reset toast goes after 5 seconds, leaving the plain order', () => {
    threeItems();
    render();
    act(() => drag().props.onMove(0, 2));
    act(() => viewMenu().props.onResetOrder!());
    expect(text()).toContain('Order reset');
    act(() => jest.advanceTimersByTime(5000));
    expect(text()).not.toContain('Order reset');
    expect(rowNames()).toEqual(['bananas', 'eggs', 'milk']);
    expect(savedOrder()).toBeNull();
  });

  test('a checked item keeps its place for when it comes back', () => {
    const { itemId: milkId } = put('milk')!;
    put('eggs');
    put('bananas');
    render();
    // milk to the top: milk, bananas, eggs.
    act(() => drag().props.onMove(2, 0));
    expect(rowNames()).toEqual(['milk', 'bananas', 'eggs']);
    setItemChecked(milkId, true, USER);
    refresh();
    act(() => drag().props.onMove(1, 0));
    expect(rowNames()).toEqual(['eggs', 'bananas']);
    setItemChecked(milkId, false, USER);
    refresh();
    expect(rowNames()).toEqual(['milk', 'eggs', 'bananas']);
  });
});

describe('By recipe', () => {
  function withTacos() {
    const recipeId = createRecipe('Tacos', getList(listId)!.householdId);
    addRecipeIngredient(recipeId, 'tortillas');
    addRecipeIngredient(recipeId, 'limes');
    addWholeRecipeToList(listId, recipeId, USER);
    put('milk');
    return recipeId;
  }

  test('a card per recipe, then Other items', () => {
    withTacos();
    render();
    setView('recipe');
    expect(sections().map((s) => s.props.title)).toEqual(['Tacos', 'Other items']);
    expect(rowNames(section('Tacos')).sort()).toEqual(['limes', 'tortillas']);
    expect(rowNames(section('Other items'))).toEqual(['milk']);
    // Other items isn't a recipe: no menu, no swipe to remove.
    expect(section('Other items').props.actions).toEqual([]);
    expect(section('Other items').props.onSwipeRemove).toBeUndefined();
  });

  test('Remove recipe from list takes its items off, with Undo', () => {
    withTacos();
    render();
    setView('recipe');
    act(() => section('Tacos').props.onSwipeRemove());
    expect(text()).toContain('Removed Tacos from the list');
    expect(sections().map((s) => s.props.title)).toEqual(['Other items']);
    tapToast('Undo');
    expect(sections().map((s) => s.props.title)).toEqual(['Tacos', 'Other items']);
  });

  test('long-pressing a recipe header opens its menu; Check all checks its items', () => {
    withTacos();
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((options, callback) => {
      expect(options.title).toBe('Tacos');
      expect(options.options).toEqual(['Check all', 'Remove recipe from list', 'Cancel']);
      callback(0);
    });
    render();
    setView('recipe');
    act(() => section('Tacos').props.onLongPress());
    expect(text()).toContain('Checked 2 items');
    expect(sections().map((s) => s.props.title)).toEqual(['Other items']);
  });

  describe('Visit recipe on web', () => {
    /** Opens Tacos's menu and returns what it showed, choosing `choose` (a label) if given. */
    function openMenu(choose?: string) {
      let shown: ActionSheetIOSOptions | null = null;
      jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((options, callback) => {
        shown = options;
        callback(choose === undefined ? options.cancelButtonIndex! : options.options.indexOf(choose));
      });
      act(() => section('Tacos').props.onLongPress());
      return shown!;
    }
    const withLink = (url: string) => {
      const recipeId = withTacos();
      updateRecipe(recipeId, { name: 'Tacos', notes: '', sourceUrl: url });
      return recipeId;
    };
    const labels = () => (section('Tacos').props.actions as { label: string }[]).map((a) => a.label);

    test('a recipe with no link has no Visit; Remove stays red and Cancel cancels', () => {
      withTacos();
      render();
      setView('recipe');
      expect(labels()).toEqual(['Check all', 'Remove recipe from list']);
      const shown = openMenu();
      expect(shown.options).toEqual(['Check all', 'Remove recipe from list', 'Cancel']);
      expect(shown.destructiveButtonIndex).toBe(1);
      expect(shown.cancelButtonIndex).toBe(2);
      // Cancel did nothing.
      expect(sections().map((s) => s.props.title)).toEqual(['Tacos', 'Other items']);
      expect(text()).not.toContain('Checked');
    });

    test('plain text in the link field is not a link', () => {
      withLink('grandma’s card');
      render();
      setView('recipe');
      expect(labels()).toEqual(['Check all', 'Remove recipe from list']);
      expect(openMenu().options).toEqual(['Check all', 'Remove recipe from list', 'Cancel']);
    });

    test('a link adds Visit between Check all and Remove; it opens the link', () => {
      withLink('https://cooking.example.com/tacos?x=1');
      render();
      setView('recipe');
      expect(labels()).toEqual(['Check all', 'Visit recipe on web', 'Remove recipe from list']);
      const shown = openMenu('Visit recipe on web');
      expect(shown.options).toEqual(['Check all', 'Visit recipe on web', 'Remove recipe from list', 'Cancel']);
      expect(shown.destructiveButtonIndex).toBe(2);
      expect(shown.cancelButtonIndex).toBe(3);
      expect(mockOpenLink).toHaveBeenCalledTimes(1);
      expect(mockOpenLink).toHaveBeenCalledWith('https://cooking.example.com/tacos?x=1');
      // Nothing on the list changed.
      expect(sections().map((s) => s.props.title)).toEqual(['Tacos', 'Other items']);
    });

    test('with a link, Cancel cancels and Remove still removes', () => {
      withLink('https://example.com/tacos');
      render();
      setView('recipe');
      openMenu();
      expect(mockOpenLink).not.toHaveBeenCalled();
      expect(sections().map((s) => s.props.title)).toEqual(['Tacos', 'Other items']);
      openMenu('Remove recipe from list');
      expect(text()).toContain('Removed Tacos from the list');
      expect(sections().map((s) => s.props.title)).toEqual(['Other items']);
    });

    test("VoiceOver's actions include Visit, and it opens the link", () => {
      withLink('https://example.com/tacos');
      render();
      setView('recipe');
      const visit = (section('Tacos').props.actions as { label: string; onPress: () => void }[]).find(
        (a) => a.label === 'Visit recipe on web',
      )!;
      act(() => visit.onPress());
      expect(mockOpenLink).toHaveBeenCalledWith('https://example.com/tacos');
    });

    test('each recipe gets its own link', () => {
      withLink('https://example.com/tacos');
      const soup = createRecipe('Soup', getList(listId)!.householdId);
      addRecipeIngredient(soup, 'leeks');
      addWholeRecipeToList(listId, soup, USER);
      render();
      setView('recipe');
      expect((section('Soup').props.actions as { label: string }[]).map((a) => a.label)).toEqual([
        'Check all',
        'Remove recipe from list',
      ]);
      expect(labels()).toContain('Visit recipe on web');
    });

    test('a deleted recipe has no link', () => {
      const recipeId = withLink('https://example.com/tacos');
      deleteRecipe(recipeId);
      render();
      setView('recipe');
      const visits = sections().flatMap((s) => ((s.props.actions ?? []) as { label: string }[]).map((a) => a.label));
      expect(visits).not.toContain('Visit recipe on web');
    });
  });
});

describe('folding sections', () => {
  test('a header folds its card, remembered per list and view; Collapse all and Expand all', () => {
    put('milk');
    put('bananas');
    render();
    setView('category');
    act(() => section('Produce').props.onToggle());
    expect(section('Produce').props.collapsed).toBe(true);
    expect(rowNames()).toEqual(['milk']);
    expect(getDeviceSetting(collapsedSectionsKey(listId, 'category'), [])).toEqual([`c-${cat('produce')}`]);

    // In the ⋯ menu: one section folded, so both are on.
    expect(menuAction('Collapse all').props.disabled).toBe(false);
    expect(menuAction('Expand all').props.disabled).toBe(false);
    press(menuAction('Collapse all'));
    expect(rows()).toHaveLength(0);
    expect(menuAction('Collapse all').props.disabled).toBe(true);
    expect(menuAction('Expand all').props.disabled).toBe(false);
    press(menuAction('Expand all'));
    expect(rowNames()).toEqual(['bananas', 'milk']);
    expect(menuAction('Collapse all').props.disabled).toBe(false);
    expect(menuAction('Expand all').props.disabled).toBe(true);
    expect(getDeviceSetting(collapsedSectionsKey(listId, 'category'), [])).toEqual([]);
  });

  test('Collapse all and Expand all are their own ⋯ group after Select items / Share, in By aisle', () => {
    put('milk');
    render();
    setView('category');
    expect(menuGroups()).toEqual([
      ['Select items', 'Share list'],
      ['Collapse all', 'Expand all'],
      ['Edit list…', 'Reorder aisles…'],
    ]);
    expect(menuAction('Collapse all').props.icon).toBe('rectangle.compress.vertical');
    expect(menuAction('Expand all').props.icon).toBe('rectangle.expand.vertical');
    // Nothing folded yet: nothing to expand.
    expect(menuAction('Collapse all').props.disabled).toBe(false);
    expect(menuAction('Expand all').props.disabled).toBe(true);
  });

  test('By recipe: Collapse all and Expand all fold every recipe card, saved for that view only', () => {
    const recipeId = createRecipe('Tacos', getList(listId)!.householdId);
    addRecipeIngredient(recipeId, 'tortillas');
    addWholeRecipeToList(listId, recipeId, USER);
    put('milk');
    render();
    setView('recipe');
    expect(menuGroups()[1]).toEqual(['Collapse all', 'Expand all']);
    press(menuAction('Collapse all'));
    expect(rows()).toHaveLength(0);
    expect(getDeviceSetting(collapsedSectionsKey(listId, 'recipe'), [])).toEqual([`r-${recipeId}`, 'r-other']);
    expect(sections().every((s) => s.props.collapsed)).toBe(true);
    expect(menuAction('Collapse all').props.disabled).toBe(true);
    expect(getDeviceSetting(collapsedSectionsKey(listId, 'category'), [])).toEqual([]);
    press(menuAction('Expand all'));
    expect(rows().length).toBeGreaterThan(0);
    expect(sections().some((s) => s.props.collapsed)).toBe(false);
    expect(menuAction('Expand all').props.disabled).toBe(true);
  });

  test('As added has no Collapse all', () => {
    put('milk');
    render();
    expect(menuAction('Collapse all')).toBeUndefined();
    expect(menuAction('Expand all')).toBeUndefined();
    expect(menuGroups()).toEqual([['Select items', 'Share list'], ['Edit list…']]);
  });

  test('a view with no sections has no Collapse all', () => {
    render();
    setView('category');
    expect(menuAction('Collapse all')).toBeUndefined();
    setView('recipe');
    expect(menuAction('Expand all')).toBeUndefined();
  });

  test('the view menu no longer has them', () => {
    put('milk');
    render();
    setView('category');
    expect(viewMenu().props).not.toHaveProperty('fold');
  });

  test('an add into a folded section opens it', () => {
    put('milk');
    render();
    setView('category');
    act(() => section('Dairy & Eggs').props.onToggle());
    add('eggs');
    expect(section('Dairy & Eggs').props.collapsed).toBe(false);
  });

});

describe("the tab bar's +", () => {
  test('the add bar is hidden at rest, and + opens it focused', () => {
    render();
    expect(all('ItemAddBar')).toHaveLength(0);
    act(() => pressAddButton());
    expect(all('ItemAddBar')).toHaveLength(1);
    expect(all('ItemAddBar')[0].props.autoFocus).toBe(true);
  });

  describe('one tap out', () => {
    /** Focuses the field and types, as the user would. */
    const typeFocused = (value: string) => {
      onBar((bar) => bar.props.onFocusChange(true));
      onBar((bar) => bar.props.onTextChange(value));
    };
    /** A tap on the list's empty space or the header: the keyboard goes, so the field loses focus. */
    const tapOut = () => act(() => all('ItemAddBar')[0].props.onFocusChange(false));

    test('with text typed, the first tap out hides the bar', () => {
      render();
      typeFocused('mil');
      tapOut();
      expect(all('ItemAddBar')).toHaveLength(0);
    });

    test('the list no longer takes a second tap out', () => {
      render();
      const viewport = tree!.root.find((n) => typeof n.type !== 'string' && n.props.testID === 'list-viewport');
      expect(viewport.props.onStartShouldSetResponder).toBeUndefined();
      expect(viewport.props.onResponderRelease).toBeUndefined();
    });

    test('+ then brings the bar back empty and focused', () => {
      render();
      typeFocused('2 mil');
      tapOut();
      act(() => pressAddButton());
      expect(all('ItemAddBar')).toHaveLength(1);
      expect(all('ItemAddBar')[0].props.initialText).toBe('');
      expect(all('ItemAddBar')[0].props.autoFocus).toBe(true);
      act(() => all('ItemAddBar')[0].props.onFocusChange(true));
      expect(all('ItemAddBar')).toHaveLength(1);
    });

    test('the thrown-away text no longer marks rows already on the list', () => {
      put('milk');
      render();
      typeFocused('milk');
      expect(row('milk').props.alreadyOnList).toEqual({ query: 'milk' });
      tapOut();
      act(() => pressAddButton());
      act(() => all('ItemAddBar')[0].props.onFocusChange(true));
      expect(row('milk').props.alreadyOnList).toBeUndefined();
    });

    test('a bar brought back closes again on the next tap out', () => {
      render();
      typeFocused('mil');
      tapOut();
      typeFocused('egg');
      tapOut();
      expect(all('ItemAddBar')).toHaveLength(0);
    });

    test('with an empty field, losing focus hides the bar straight away', () => {
      render();
      onBar((bar) => bar.props.onFocusChange(true));
      tapOut();
      expect(all('ItemAddBar')).toHaveLength(0);
    });

    test('a field cleared before the tap out hides the bar the same way', () => {
      render();
      typeFocused('mil');
      onBar((bar) => bar.props.onTextChange(''));
      tapOut();
      expect(all('ItemAddBar')).toHaveLength(0);
    });

    test('tapping a row while typing keeps the bar and its text', () => {
      put('milk');
      render();
      typeFocused('egg');
      act(() => row('milk').props.onToggle());
      expect(all('ItemAddBar')).toHaveLength(1);
      expect(all('ItemAddBar')[0].props.initialText).toBe('egg');
    });

    test('submitting from the keyboard adds and keeps the bar open', () => {
      render();
      typeFocused('eggs');
      onBar((bar) => bar.props.onAdd('eggs'));
      expect(rowNames()).toContain('eggs');
      expect(all('ItemAddBar')).toHaveLength(1);
    });

    test('Select mode still swaps the bar out and clears the text', () => {
      put('milk');
      render();
      typeFocused('egg');
      press(menuAction('Select items'));
      expect(all('ItemAddBar')).toHaveLength(0);
      act(() => pressAddButton());
      expect(all('ItemAddBar')).toHaveLength(1);
      expect(all('ItemAddBar')[0].props.initialText).toBe('');
    });
  });

  test("the long-press menu's Add item opens this list's add bar, as a tap does, without leaving the list", () => {
    render();
    act(() => runAddMenuItem('item'));
    expect(all('ItemAddBar')).toHaveLength(1);
    expect(all('ItemAddBar')[0].props.autoFocus).toBe(true);
    expect(takePendingListAdd()).toBe(false);
  });

  test('+ in Select mode leaves it for the add bar', () => {
    put('milk');
    render();
    press(menuAction('Select items'));
    act(() => pressAddButton());
    expect(row('milk').props.selected).toBeUndefined();
    expect(all('ItemAddBar')).toHaveLength(1);
  });
});

describe('the + hint (spec 4.1)', () => {
  beforeEach(() => {
    // One left up by an earlier test; then forget it was seen.
    dismissAddHint();
    db.delete(deviceSettings).run();
    jest
      .spyOn(AccessibilityInfo, 'isScreenReaderEnabled')
      .mockClear()
      .mockImplementation(() => Promise.resolve(false));
  });

  /** + opens the bar focused; the add field then loses focus, which ends add mode. */
  const addThenTapOut = async () => {
    onBar((bar) => bar.props.onFocusChange(true));
    await act(async () => all('ItemAddBar')[0].props.onFocusChange(false));
  };
  /** `addThenTapOut`, `n` times over. */
  const addsThenTapOut = async (n: number) => {
    for (let i = 0; i < n; i++) await addThenTapOut();
  };

  test('three taps on +, then add mode ending, shows the hint', async () => {
    render();
    await addThenTapOut();
    await addThenTapOut();
    expect(isAddHintVisible()).toBe(false);
    await addThenTapOut();
    expect(isAddHintVisible()).toBe(true);
    expect(getDeviceSetting(ADD_TAP_COUNT_KEY, 0)).toBe(3);
  });

  test('a long-press on + before then means it never shows', async () => {
    render();
    addMenuOpened();
    await addsThenTapOut(4);
    expect(isAddHintVisible()).toBe(false);
  });

  test('once dismissed, the next add mode ending shows nothing', async () => {
    render();
    await addsThenTapOut(3);
    expect(isAddHintVisible()).toBe(true);
    dismissAddHint();
    expect(getDeviceSetting(ADD_HINT_SEEN_KEY, false)).toBe(true);
    await addThenTapOut();
    expect(isAddHintVisible()).toBe(false);
  });

  test('not while a sheet is over the list', async () => {
    render();
    await addsThenTapOut(2);
    mockPath.current = `/list/${listId}/item/x`;
    await addThenTapOut();
    expect(isAddHintVisible()).toBe(false);
    expect(getDeviceSetting(ADD_HINT_SEEN_KEY, false)).toBe(false);
  });

  test('not when Select mode swaps the bar out', async () => {
    put('milk');
    render();
    await addsThenTapOut(2);
    // The third tap on +.
    onBar((bar) => bar.props.onFocusChange(true));
    const { onFocusChange } = all('ItemAddBar')[0].props;
    act(() => row('milk').props.onSelect());
    expect(all('ItemAddBar')).toHaveLength(0);
    // The field blurs as the bar goes.
    await act(async () => onFocusChange(false));
    expect(isAddHintVisible()).toBe(false);
    expect(getDeviceSetting(ADD_HINT_SEEN_KEY, false)).toBe(false);
  });

  test('with VoiceOver on it is marked seen and not shown', async () => {
    jest.mocked(AccessibilityInfo.isScreenReaderEnabled).mockImplementation(() => Promise.resolve(true));
    render();
    await addsThenTapOut(3);
    expect(isAddHintVisible()).toBe(false);
    expect(getDeviceSetting(ADD_HINT_SEEN_KEY, false)).toBe(true);
  });
});

describe('the list menu', () => {
  test('Select items, Share list, then Edit list… in its own group', () => {
    render();
    const groups = all('ToolbarMenu', moreMenu()).filter((m) => m.props.inline);
    expect(groups.map((g) => g.findAll((n) => n.type === ('ToolbarMenuAction' as never)).map((n) => n.props.children))).toEqual([
      ['Select items', 'Share list'],
      ['Edit list…'],
    ]);
    expect(all('ToolbarMenuAction', moreMenu())).toHaveLength(3);
  });

  test('Select items is disabled with nothing to get', () => {
    render();
    expect(menuAction('Select items').props.disabled).toBe(true);
  });

  test('Share list shares what is left to get', () => {
    put('2 milk');
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    render();
    press(menuAction('Share list'));
    expect(share).toHaveBeenCalledWith({ message: expect.stringContaining('2 Milk') });
    expect(share.mock.calls[0][0]).toEqual({ message: expect.stringContaining('Groceries') });
  });

  test('Edit list… opens the Edit list sheet', () => {
    render();
    press(menuAction('Edit list…'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/list/[id]/edit', params: { id: listId } });
  });
});

describe('the Checked section opening by itself', () => {
  test('opens once the last item is checked, and folds again when something is added', () => {
    put('milk');
    render();
    act(() => row('milk').props.onToggle());
    act(() => jest.advanceTimersByTime(CHECK_LINGER_MS));
    expect(rowNames()).toEqual(['milk']);
    expect(pressable('Checked, 1 item').props.accessibilityState).toEqual({ expanded: true });
    expect(switcherLabel()).toContain('All done');
    put('eggs');
    refresh();
    expect(rowNames()).toEqual(['eggs']);
    expect(switcherLabel()).toContain('1 to get');
  });

  test('stays folded after a fold by hand until the list changes', () => {
    const { itemId } = put('milk')!;
    setItemChecked(itemId, true, USER);
    render();
    press(pressable('Checked, 1 item'));
    expect(rowNames()).toEqual([]);
    refresh();
    expect(rowNames()).toEqual([]);
  });

  test('stays open after an open by hand when something is added', () => {
    const { itemId } = put('milk')!;
    put('eggs');
    setItemChecked(itemId, true, USER);
    render();
    press(pressable('Checked, 1 item'));
    expect(rowNames()).toEqual(['eggs', 'milk']);
    put('bread');
    refresh();
    expect(rowNames()).toEqual(['bread', 'eggs', 'milk']);
  });

  test('is open while shopping with Always show checked items on', () => {
    setAlwaysShowChecked(true);
    const { itemId } = put('milk')!;
    put('eggs');
    setItemChecked(itemId, true, USER);
    render();
    expect(rowNames()).toEqual(['eggs', 'milk']);
    press(pressable('Checked, 1 item'));
    expect(rowNames()).toEqual(['eggs']);
  });
});

describe('the Checked header', () => {
  test('reads "Checked · N" with Uncheck all and Clear', () => {
    const a = put('milk')!;
    const b = put('eggs')!;
    setItemChecked(a.itemId, true, USER);
    setItemChecked(b.itemId, true, USER);
    render();
    expect(lines()).toContain('Checked · 2');
    expect(pressable('Uncheck all')).toBeDefined();
    expect(pressable('Clear 2 checked items')).toBeDefined();
  });

  test('is not there with nothing checked', () => {
    put('milk');
    render();
    expect(text()).not.toContain('Checked');
    expect(tree!.root.findAll((n) => n.props.accessibilityLabel === 'Uncheck all')).toHaveLength(0);
  });

  test('Uncheck all puts every checked item back', () => {
    const a = put('milk')!;
    setItemChecked(a.itemId, true, USER);
    render();
    press(pressable('Uncheck all'));
    refresh();
    expect(rowNames()).toEqual(['milk']);
    expect(text()).not.toContain('Checked');
  });

  test('Uncheck all shows "Unchecked N items", and Undo checks them again', () => {
    const a = put('milk')!;
    const b = put('eggs')!;
    put('bread');
    setItemChecked(a.itemId, true, USER);
    setItemChecked(b.itemId, true, USER);
    render();
    press(pressable('Uncheck all'));
    refresh();
    expect(text()).toContain('Unchecked 2 items');
    expect(text()).not.toContain('Checked · ');
    tapToast('Undo');
    refresh();
    expect(lines()).toContain('Checked · 2');
    expect(rowNames()).toEqual(['bread']);
    expect(text()).not.toContain('Unchecked');
  });

  test("the long-press menu's Uncheck all shows the toast too, and its Undo works", () => {
    const a = put('milk')!;
    setItemChecked(a.itemId, true, USER);
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => callback(1));
    render();
    act(() => pressable('Checked, 1 item').props.onLongPress());
    refresh();
    expect(text()).toContain('Unchecked 1 item');
    expect(rowNames()).toEqual(['milk']);
    tapToast('Undo');
    refresh();
    expect(pressable('Checked, 1 item')).toBeDefined();
    expect(text()).not.toContain('Unchecked');
  });
});

describe('Reorder aisles', () => {
  test('By aisle has Reorder aisles… in the list menu, which opens the aisle order', () => {
    put('milk');
    render();
    expect(menuAction('Reorder aisles…')).toBeUndefined();
    setView('category');
    press(menuAction('Reorder aisles…'));
    expect(mockPush).toHaveBeenCalledWith('/category-order');
  });

  test('By recipe has none', () => {
    put('milk');
    render();
    setView('recipe');
    expect(menuAction('Reorder aisles…')).toBeUndefined();
  });

  test('not at the end of the list', () => {
    put('milk');
    render();
    setView('category');
    expect(tree!.root.findAll((n) => n.props.accessibilityLabel === 'Reorder aisles')).toHaveLength(0);
  });
});

describe('toasts from elsewhere', () => {
  test('an item moved here shows "Moved … from …" with Undo', () => {
    const other = createList('Costco');
    const { itemId } = put('milk', other)!;
    setMoveResult(moveItemToList(itemId, listId));
    render();
    expect(text()).toContain('Moved Milk from Costco');
    tapToast('Undo');
    expect(rows()).toHaveLength(0);
    expect(listItemsQuery(other).all()).toHaveLength(1);
  });

  test('a move that combined tints the row it joined', () => {
    put('1 milk');
    const other = createList('Costco');
    const { itemId } = put('1 milk', other)!;
    setMoveResult(moveItemToList(itemId, listId));
    render();
    expect(text()).toContain('Added to Milk, now 2');
    expect(row('milk').props.tint).toBeDefined();
  });

  test('a recipe added from its screen shows its toast with Undo', () => {
    const recipeId = createRecipe('Tacos', getList(listId)!.householdId);
    addRecipeIngredient(recipeId, 'limes');
    const added = addWholeRecipeToList(listId, recipeId, USER)!;
    setRecipeAddResult({ kind: 'toList', listId, recipeId, recipeName: 'Tacos', count: 1, results: added.results });
    render();
    expect(text()).toContain('Added Tacos · 1 item');
    tapToast('Undo');
    expect(rows()).toHaveLength(0);
  });

  test('an imported recipe shows Undo and View recipe', () => {
    const undo = jest.fn();
    setRecipeAddResult({ kind: 'imported', listId, recipeId: 'r9', recipeName: 'Dal', count: 4, undo });
    render();
    expect(text()).toContain('Dal');
    tapToast('Undo');
    expect(undo).toHaveBeenCalled();
    expect(text()).not.toContain('Dal');
    // Shown while the list is up too (an import's notification tapped here).
    act(() => setRecipeAddResult({ kind: 'imported', listId, recipeId: 'r9', recipeName: 'Dal', count: 4, undo }));
    tapToast('View recipe');
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]', params: { id: 'r9' } });
  });

  test('a recipe saved from this list without adding to it: "Saved", Undo only when created', () => {
    const undo = jest.fn();
    setRecipeAddResult({ kind: 'saved', listId, recipeId: 'r9', recipeName: 'Dal', created: true, undo });
    render();
    expect(text()).toContain('Saved Dal');
    tapToast('Undo');
    expect(undo).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain('Saved Dal');
    // Reused: it was already in the recipes, so there's nothing to undo.
    act(() => setRecipeAddResult({ kind: 'saved', listId, recipeId: 'r9', recipeName: 'Dal', created: false, undo }));
    expect(text()).toContain('Dal is already in your recipes');
    expect(() => hostByLabel('Undo')).toThrow();
    tapToast('View recipe');
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]', params: { id: 'r9' } });
  });

  test('a result for another list is left for that list', () => {
    setRecipeAddResult({ kind: 'toRecipe', listId: 'other', recipeId: 'r1', recipeName: 'Pancakes', count: 1 });
    render();
    expect(text()).not.toContain('Pancakes');
  });

  test('Siri adds show one toast', () => {
    render();
    act(() => mockSiriListeners.forEach((l) => l(2)));
    expect(text()).toContain('Siri added 2 items');
  });

  test('shared recipes: one shows its own toast, several one summary', () => {
    const undo = jest.fn();
    render();
    act(() => mockShareListeners.forEach((l) => l([{ recipeId: 'r1', recipeName: 'Dal', added: 3, undo }])));
    expect(text()).toContain('Dal');
    tapToast('Undo');
    expect(undo).toHaveBeenCalled();
    act(() =>
      mockShareListeners.forEach((l) =>
        l([
          { recipeId: 'r1', recipeName: 'Dal', added: 3, undo },
          { recipeId: 'r2', recipeName: 'Soup', added: 2, undo },
        ]),
      ),
    );
    expect(text()).toContain('Added 2 recipes');
    expect(text()).not.toContain('Dal');
  });

  test('recipe-only shares show no list toast, and don’t count toward the summary', () => {
    const undo = jest.fn();
    render();
    const recipeOnly = { recipeId: 'r3', recipeName: 'Tikka', listId: null, created: true, added: 0, undo };
    act(() => mockShareListeners.forEach((l) => l([recipeOnly])));
    expect(text()).not.toContain('Tikka');
    expect(text()).not.toContain('Added');

    act(() =>
      mockShareListeners.forEach((l) => l([recipeOnly, { recipeId: 'r1', recipeName: 'Dal', listId: 'l1', added: 3, undo }])),
    );
    expect(text()).toContain('Dal');
    expect(text()).not.toContain('Added 2 recipes');
    expect(text()).not.toContain('Tikka');
  });
});

describe('keeping the screen on (spec 4.1)', () => {
  const appStateListeners = new Set<(state: AppStateStatus) => void>();
  beforeEach(() => {
    mockAwake.clear();
    jest.mocked(activateKeepAwakeAsync).mockClear();
    appStateListeners.clear();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      appStateListeners.add(listener as (state: AppStateStatus) => void);
      return { remove: () => void appStateListeners.delete(listener as (state: AppStateStatus) => void) } as never;
    });
  });
  const appGoes = (state: AppStateStatus) => act(() => appStateListeners.forEach((l) => l(state)));
  const awake = () => mockAwake.size > 0;

  test('a list with unchecked items keeps it on, under a tag for this list', () => {
    put('milk');
    render();
    expect(awake()).toBe(true);
    expect([...mockAwake][0]).toMatch(new RegExp(`^list:${listId}:`));
  });

  test('an empty list, or one with everything checked, does not', () => {
    render();
    expect(awake()).toBe(false);
    act(() => tree!.unmount());
    tree = null;
    const { itemId } = put('milk')!;
    setItemChecked(itemId, true, USER);
    render();
    expect(awake()).toBe(false);
    expect(activateKeepAwakeAsync).not.toHaveBeenCalled();
  });

  test('checking off the last item lets it lock; adding one keeps it on again', () => {
    put('milk');
    render();
    act(() => row('milk').props.onToggle());
    expect(awake()).toBe(false);
    add('eggs');
    expect(awake()).toBe(true);
  });

  test("stays on over this list's sheets and Your lists, and lets go elsewhere", () => {
    put('milk');
    render();
    mockPath.current = `/list/${listId}/item/x`;
    refresh();
    expect(awake()).toBe(true);
    mockPath.current = '/lists-sheet';
    refresh();
    expect(awake()).toBe(true);
    mockPath.current = '/recipes';
    refresh();
    expect(awake()).toBe(false);
    mockPath.current = '/import-recipe';
    refresh();
    expect(awake()).toBe(false);
    mockPath.current = '/list/other/item/x';
    refresh();
    expect(awake()).toBe(false);
    mockPath.current = '/lists';
    refresh();
    expect(awake()).toBe(true);
  });

  test('lets go in the background and takes it again in the foreground', () => {
    put('milk');
    render();
    appGoes('background');
    expect(awake()).toBe(false);
    appGoes('active');
    expect(awake()).toBe(true);
  });

  test('lets go when the screen goes away', () => {
    put('milk');
    render();
    act(() => tree!.unmount());
    tree = null;
    expect(awake()).toBe(false);
  });

  test('with the setting off from the start, never keeps it on', () => {
    setKeepScreenOn(false);
    put('milk');
    render();
    expect(awake()).toBe(false);
    expect(activateKeepAwakeAsync).not.toHaveBeenCalled();
  });

  test('switching the setting off while the list is open lets go at once, and on takes it again', () => {
    put('milk');
    render();
    act(() => setKeepScreenOn(false));
    expect(awake()).toBe(false);
    act(() => setKeepScreenOn(true));
    expect(awake()).toBe(true);
  });
});

describe('the list screen in Spanish', () => {
  // Unmount before switching back, so the screen doesn't re-render outside act.
  afterEach(() => {
    act(() => tree?.unmount());
    tree = null;
    initI18n('en');
  });

  test('an empty list says so in Spanish', () => {
    initI18n('es');
    render();
    expect(lines()).toEqual(
      expect.arrayContaining([
        'Tu lista está vacía',
        'Agrega lo que necesitas o trae los ingredientes de una receta de una vez.',
        'Agregar un artículo',
        'Agregar de una receta',
      ]),
    );
  });

  test('the header, switcher and ⋯ menu', () => {
    put('milk');
    mockInvites.current = [{ id: 'inv-1', householdName: 'Los López' } as MyInvite];
    initI18n('es');
    render();
    expect(pressable('Groceries, cambiar de lista, 1 invitación pendiente, 1 por comprar').props.accessibilityHint).toBe(
      'Muestra tus otras listas',
    );
    expect(hostByLabel('Acciones de la lista')).toBeDefined();
    expect(all('ToolbarMenuAction', moreMenu()).map((n) => n.props.children)).toEqual([
      'Seleccionar artículos',
      'Compartir lista',
      'Editar lista…',
    ]);
    setView('category');
    expect(menuAction('Reordenar pasillos…')).toBeDefined();
  });

  test('the Checked section, its menu and its toasts, with Spanish plurals', () => {
    const a = put('milk')!;
    const b = put('eggs')!;
    put('bread');
    setItemChecked(a.itemId, true, USER);
    setItemChecked(b.itemId, true, USER);
    initI18n('es');
    const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((options) => {
      expect(options.options).toEqual(['Borrar 2 artículos marcados', 'Desmarcar todo', 'Cancelar']);
    });
    render();
    expect(lines()).toContain('Marcados · 2');
    act(() => pressable('Marcados, 2 artículos').props.onLongPress());
    expect(sheet).toHaveBeenCalled();
    expect(pressable('Desmarcar todo')).toBeDefined();
    act(() => hostByLabel('Borrar 2 artículos marcados').props.onClick());
    expect(text()).toContain('Se borraron 2 artículos');
    tapToast('Deshacer');
    refresh();
    press(pressable('Desmarcar todo'));
    expect(text()).toContain('Se desmarcaron 2 artículos');
  });

  test('a section’s Check all and an item delete', () => {
    put('milk');
    put('eggs');
    initI18n('es');
    render();
    setView('category');
    const dairy = sections().find((s) => s.props.actions)!;
    expect(dairy.props.actions.map((a: { label: string }) => a.label)).toEqual(['Marcar todo']);
    act(() => dairy.props.actions[0].onPress());
    expect(text()).toContain('Se marcaron 2 artículos');
    refresh();
    put('bread');
    refresh();
    act(() => row('bread').props.onDelete());
    expect(text()).toContain('Se eliminó Bread');
  });

  test('Select mode', () => {
    put('milk');
    initI18n('es');
    render();
    press(menuAction('Seleccionar artículos'));
    expect(text()).toContain('Toca artículos para seleccionarlos');
    act(() => row('milk').props.onToggle());
    expect(text()).toContain('1 seleccionado');
    expect(pressable('Agregar a receta')).toBeDefined();
    expect(all('ToolbarButton').map((n) => n.props.children)).toContain('Listo');
  });

  test('Share list keeps its layout', () => {
    put('2 milk');
    initI18n('es');
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    render();
    press(menuAction('Compartir lista'));
    expect(share).toHaveBeenCalledWith({ message: 'Groceries\n- 2 Milk' });
  });
});

describe('since you looked (spec 4.1)', () => {
  const ALEX = 'user-alex';
  const SAM = 'user-sam';
  /** An add by another member, as pull leaves it, `minutesAgo` before now by the server's clock. */
  function addAs(value: string, by: string, minutesAgo: number) {
    const result = addItem(listId, value, by)!;
    db.update(listItemContributions)
      .set({ createdAt: new Date(Date.now() - minutesAgo * 60_000) })
      .where(eq(listItemContributions.id, result.contributionId))
      .run();
    return result;
  }
  /** Lets the visit's one news read settle. */
  const settle = () => act(async () => {});
  // The card had a Dismiss action; nothing on the screen does now.
  const cards = () =>
    tree!.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityActions?.[0]?.name === 'dismiss');
  const newRows = () => rows().filter((r) => r.props.isNew).map((r) => r.props.item.displayName as string);
  const lookedAgo = (minutes: number) => markListSeen(listId, new Date(Date.now() - minutes * 60_000));
  /** A row's view as the list measures it, `y` down the window, 50 pt tall. */
  const at = (y: number) => {
    const node = { y, measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(0, node.y, 390, 50) };
    return node;
  };
  /** The row's view, put where the list will find it, then laid out. */
  const place = (name: string, node: ReturnType<typeof at>) => {
    act(() => row(name).props.newRef(node));
    act(() => row(name).props.onNewLayout());
  };
  const scroll = (y: number) => act(() => tree!.root.findByType(FlatList).props.onScroll({ nativeEvent: { contentOffset: { y } } }));
  /** The screen with its list 600 pt tall, 100 pt down the window. */
  function renderMeasured() {
    render();
    const viewport = tree!.root.find((n) => typeof n.type !== 'string' && n.props.testID === 'list-viewport');
    viewport.instance.measureInWindow = (cb: (x: number, y: number, w: number, h: number) => void) => cb(0, 100, 390, 600);
  }

  beforeEach(() => {
    const householdId = getList(listId)!.householdId;
    for (const [userId, displayName] of [
      [USER, 'Me Myself'],
      [ALEX, 'Alex Rivera'],
      [SAM, 'Sam Lee'],
    ]) {
      db.insert(householdMemberNames).values({ householdId, userId, displayName, joinedAt: '2026-01-01T00:00:00Z' }).run();
    }
    lookedAgo(120);
  });

  test('no card, and NEW rows with no name line, in every view mode', async () => {
    put('bread');
    addAs('eggs', ALEX, 60);
    addAs('limes', ALEX, 50);
    addAs('corn tortillas', ALEX, 40);
    addAs('milk', ALEX, 30);
    for (const mode of ['category', 'newest', 'recipe'] as const) {
      setDeviceSetting(viewModeKey(listId), mode);
      render();
      await settle();
      expect(cards()).toHaveLength(0);
      expect(text()).not.toContain('Alex added');
      expect(text()).not.toContain('Since you looked');
      // My own add isn't news.
      expect(newRows().sort()).toEqual(['corn tortillas', 'eggs', 'limes', 'milk']);
      expect(row('bread').props.isNew).toBe(false);
      // The row's second line is only its own: nothing says who or when.
      expect(row('eggs').props.hint).toBeUndefined();
      expect(row('eggs').props).not.toHaveProperty('news');
      expect(text()).not.toContain('Alex · today');
      // Closing the screen moves the marker; put it back for the next mode.
      act(() => tree!.unmount());
      tree = null;
      lookedAgo(120);
    }
  });

  test("two members, and another member's Combine into my item: what they added, not NEW", async () => {
    put('bread');
    addAs('eggs', ALEX, 60);
    addAs('bread', SAM, 50);
    render();
    await settle();
    expect(newRows()).toEqual(['eggs']);
    expect(row('bread').props.added).toBe('1');
    expect(row('eggs').props.added).toBeUndefined();
    expect(all('View').filter((n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('news-avatar-'))).toHaveLength(0);
  });

  test('what was new on open stays so for the visit; a live add is NEW as an arrival', async () => {
    addAs('eggs', ALEX, 60);
    render();
    await settle();
    expect(newRows()).toEqual(['eggs']);
    addAs('limes', ALEX, 0);
    refresh();
    await settle();
    expect(newRows().sort()).toEqual(['eggs', 'limes']);
    expect(cards()).toHaveLength(0);
  });

  test("a badge goes 10 s after its row is first in sight; one below keeps its badge until it's scrolled to", async () => {
    setDeviceSetting(viewModeKey(listId), 'newest');
    addAs('eggs', ALEX, 60);
    addAs('limes', ALEX, 50);
    renderMeasured();
    await settle();
    expect(newRows().sort()).toEqual(['eggs', 'limes']);
    const limes = at(900);
    place('eggs', at(300));
    place('limes', limes);
    // Loading isn't seeing: limes is below the list's frame.
    act(() => void jest.advanceTimersByTime(9_999));
    expect(newRows().sort()).toEqual(['eggs', 'limes']);
    act(() => void jest.advanceTimersByTime(1));
    expect(newRows()).toEqual(['limes']);
    expect(row('eggs').props.isNew).toBe(false);
    // Long after, limes comes into sight: its own 10 s start then.
    act(() => void jest.advanceTimersByTime(60_000));
    expect(newRows()).toEqual(['limes']);
    limes.y = 400;
    scroll(500);
    act(() => void jest.advanceTimersByTime(9_999));
    expect(newRows()).toEqual(['limes']);
    act(() => void jest.advanceTimersByTime(1));
    expect(newRows()).toEqual([]);
    // It doesn't come back during the visit.
    scroll(0);
    refresh();
    expect(newRows()).toEqual([]);
  });

  test("a row the list hasn't drawn (a folded section, or far off) isn't in sight: its clock waits", async () => {
    addAs('limes', ALEX, 60);
    renderMeasured();
    await settle();
    scroll(10);
    act(() => void jest.advanceTimersByTime(30_000));
    expect(newRows()).toEqual(['limes']);
    // Drawn, in sight, then gone from the list's views again (folded): the clock it started runs on.
    place('limes', at(300));
    act(() => row('limes').props.newRef(null));
    act(() => void jest.advanceTimersByTime(10_000));
    expect(newRows()).toEqual([]);
  });

  test('leaving clears the badges, even one not yet faded; coming back shows only what came since', async () => {
    addAs('eggs', ALEX, 60);
    render();
    await settle();
    expect(newRows()).toEqual(['eggs']);
    mockPath.current = '/recipes';
    refresh();
    expect(newRows()).toEqual([]);
    jest.setSystemTime(Date.now() + 10 * 60_000);
    addAs('limes', SAM, 0);
    mockPath.current = '/lists';
    refresh();
    await settle();
    expect(newRows()).toEqual(['limes']);
  });

  test('a list with no marker shows nothing, and is marked', async () => {
    db.delete(deviceSettings).where(eq(deviceSettings.key, listSeenAtKey(listId))).run();
    addAs('eggs', ALEX, 60);
    render();
    await settle();
    expect(newRows()).toEqual([]);
    expect(getListSeenAt(listId)).not.toBeNull();
  });

  test('no news shows nothing at all', async () => {
    put('bread');
    addAs('eggs', ALEX, 600);
    render();
    await settle();
    expect(cards()).toHaveLength(0);
    expect(newRows()).toEqual([]);
    expect(text()).not.toContain('Since you looked');
  });

  test('a new item checked off during the visit loses its badge', async () => {
    addAs('eggs', ALEX, 60);
    render();
    await settle();
    act(() => row('eggs').props.onToggle());
    refresh();
    expect(row('eggs').props.news).toBeUndefined();
  });
});

describe('a row that arrives while you look (spec 4.1)', () => {
  const ALEX = 'user-alex';
  const SAM = 'user-sam';
  /** Another member's add reaching this device, a second after the last, made `minutesAgo` on the server. */
  function addAs(value: string, by: string, minutesAgo = 0) {
    jest.setSystemTime(Date.now() + 1000);
    const result = addItem(listId, value, by)!;
    if (minutesAgo > 0) {
      db.update(listItemContributions)
        .set({ createdAt: new Date(Date.now() - minutesAgo * 60_000) })
        .where(eq(listItemContributions.id, result.contributionId))
        .run();
    }
    return result;
  }
  // An arrival's row is NEW; it grows in if it wasn't on the list to get.
  const cued = () => rows().filter((r) => r.props.isNew).map((r) => r.props.item.displayName as string);
  const list = () => tree!.root.findByType(FlatList);
  /** A row's view as the list measures it, `y` down the window, 50 pt tall. */
  const at = (y: number) => {
    const node = { y, measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(0, node.y, 390, 50) };
    return node;
  };
  /** The row's view, put where the list will find it, then laid out. */
  const place = (name: string, node: ReturnType<typeof at>) => {
    act(() => row(name).props.newRef(node));
    act(() => row(name).props.onNewLayout());
  };
  const scroll = (y: number) => act(() => list().props.onScroll({ nativeEvent: { contentOffset: { y } } }));
  // What the pill and name tag left behind, if anything did.
  const leftovers = () =>
    tree!.root.findAll(
      (n) =>
        typeof n.type === 'string' &&
        (n.props.testID === 'arrival-tag' || n.props.testID === 'arrival-flash' || /\d+ new\b/.test(String(n.props.accessibilityLabel ?? ''))),
    );
  /** The screen with its list 600 pt tall, 100 pt down the window. */
  function renderMeasured() {
    render();
    const viewport = tree!.root.find((n) => typeof n.type !== 'string' && n.props.testID === 'list-viewport');
    viewport.instance.measureInWindow = (cb: (x: number, y: number, w: number, h: number) => void) => cb(0, 100, 390, 600);
  }

  beforeEach(() => {
    const householdId = getList(listId)!.householdId;
    for (const [userId, displayName] of [
      [USER, 'Me Myself'],
      [ALEX, 'Alex Rivera'],
      [SAM, 'Sam Lee'],
    ]) {
      db.insert(householdMemberNames).values({ householdId, userId, displayName, joinedAt: '2026-01-01T00:00:00Z' }).run();
    }
  });

  test("another member's new item grows in with a NEW badge and no name tag; what was there doesn't", () => {
    put('bread');
    render();
    expect(cued()).toEqual([]);
    addAs('limes', ALEX);
    refresh();
    expect(cued()).toEqual(['limes']);
    expect(row('limes').props.grow).toBe(true);
    expect(row('limes').props).not.toHaveProperty('tag');
    expect(row('limes').props).not.toHaveProperty('arrival');
    expect(row('bread').props.isNew).toBe(false);
    expect(row('bread').props.grow).toBeUndefined();
    expect(text()).not.toContain('Alex');
    expect(leftovers()).toHaveLength(0);
  });

  test("another member's Combine into an item shows what they added, without growing", () => {
    put('milk');
    render();
    const more = addAs('2 milk', SAM);
    expect(more.kind).toBe('combine');
    refresh();
    expect(row('milk').props.isNew).toBe(false);
    expect(row('milk').props.added).toBe('2');
    expect(row('milk').props.grow).toBe(false);
    // Another while you look: their adds this visit, summed.
    addAs('milk', ALEX);
    refresh();
    expect(row('milk').props.added).toBe('3');
  });

  test('a Combine into a row that arrived NEW this visit keeps it NEW', () => {
    render();
    addAs('eggs', ALEX);
    refresh();
    expect(cued()).toEqual(['eggs']);
    addAs('6 eggs', SAM);
    refresh();
    expect(cued()).toEqual(['eggs']);
    expect(row('eggs').props.added).toBeUndefined();
    expect(row('eggs').props.grow).toBe(true);
  });

  test('my own add that merges keeps its merge tint; an arrival gets none', () => {
    put('limes');
    render();
    add('limes');
    expect(row('limes').props.tint).toBeDefined();
    addAs('eggs', ALEX);
    refresh();
    expect(row('eggs').props.tint).toBeUndefined();
  });

  test('my own adds never get it, from the add bar or another of my devices', () => {
    render();
    add('eggs');
    put('limes');
    put('eggs');
    refresh();
    expect(cued()).toEqual([]);
  });

  test("the first load and pull catching up on what was there before the list was shown don't get it", () => {
    addAs('eggs', ALEX);
    render();
    expect(cued()).toEqual([]);
    // Pull brings an add Alex made 10 minutes ago, before the list was on screen.
    addAs('limes', ALEX, 10);
    refresh();
    expect(cued()).toEqual([]);
  });

  test('in every view mode', () => {
    render();
    for (const mode of ['category', 'newest', 'recipe'] as const) {
      setView(mode);
      addAs(`bread ${mode}`, ALEX);
      refresh();
      expect(cued()).toContain(`bread ${mode}`);
    }
  });

  test("an arrival's badge goes 10 s after it's in sight; a drag doesn't touch it", () => {
    renderMeasured();
    addAs('limes', ALEX);
    refresh();
    expect(list().props.onScrollBeginDrag).toBeUndefined();
    place('limes', at(300));
    act(() => void jest.advanceTimersByTime(9_999));
    expect(cued()).toEqual(['limes']);
    act(() => void jest.advanceTimersByTime(1));
    expect(cued()).toEqual([]);
    // Another add to it during the visit doesn't bring the badge back.
    addAs('2 limes', SAM);
    refresh();
    expect(cued()).toEqual([]);
  });

  test('leaving the list ends it, and what came while away gets none on return', () => {
    render();
    addAs('limes', ALEX);
    refresh();
    mockPath.current = '/recipes';
    refresh();
    expect(cued()).toEqual([]);
    addAs('eggs', ALEX);
    mockPath.current = '/lists';
    refresh();
    expect(cued()).toEqual([]);
    // The list's own sheets still count as on screen.
    mockPath.current = `/list/${listId}/edit`;
    refresh();
    addAs('corn', ALEX);
    refresh();
    expect(cued()).toEqual(['corn']);
  });

  test('the app in the background ends it too', () => {
    let listener: ((state: AppStateStatus) => void) | undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, l) => {
      listener = l as (state: AppStateStatus) => void;
      return { remove: () => {} } as never;
    });
    render();
    addAs('limes', ALEX);
    refresh();
    act(() => listener!('background'));
    expect(cued()).toEqual([]);
  });

  test('a checked-off arrival loses its cue', () => {
    render();
    addAs('limes', ALEX);
    refresh();
    act(() => row('limes').props.onToggle());
    jest.advanceTimersByTime(5000);
    refresh();
    expect(row('limes').props.isNew).toBe(false);
    expect(row('limes').props.grow).toBeUndefined();
  });

  test('rows that land out of sight: no pill, no scrolling; each keeps its badge until it is scrolled into sight', () => {
    const scrollTo = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
    const scrollToIndex = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
    setDeviceSetting(viewModeKey(listId), 'newest');
    renderMeasured();
    const corn = at(1100);
    addAs('limes', ALEX);
    addAs('eggs', ALEX);
    addAs('corn', SAM);
    refresh();
    place('limes', at(300));
    place('eggs', at(1000));
    place('corn', corn);
    expect(leftovers()).toHaveLength(0);
    expect(text()).not.toContain('3 new');
    expect(text()).not.toContain('new from');
    act(() => void jest.advanceTimersByTime(10_000));
    expect(cued().sort()).toEqual(['corn', 'eggs']);
    corn.y = 400;
    scroll(700);
    act(() => void jest.advanceTimersByTime(10_000));
    expect(cued()).toEqual(['eggs']);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  test("VoiceOver hears who added what, at most once every 5 s, grouped; no haptic", () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    // jest-expo's own mock may already be there, with earlier tests' calls.
    announce.mockClear();
    jest.mocked(Haptics.selectionAsync).mockClear();
    jest.mocked(Haptics.impactAsync).mockClear();
    render();
    addAs('limes', ALEX);
    refresh();
    expect(announce.mock.calls).toEqual([['Alex added limes']]);
    addAs('eggs', ALEX);
    refresh();
    addAs('corn tortillas', ALEX);
    refresh();
    expect(announce).toHaveBeenCalledTimes(1);
    // 5 s after the first, which was a second before eggs came.
    act(() => jest.advanceTimersByTime(3999));
    expect(announce).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(1));
    expect(announce.mock.calls[1]).toEqual(['Alex added 2 items']);
    // Two people within the window: a sentence each.
    addAs('milk', SAM);
    refresh();
    addAs('bread', ALEX);
    refresh();
    act(() => jest.advanceTimersByTime(5000));
    expect(announce.mock.calls[2]).toEqual(['Sam added milk. Alex added bread']);
    // Long after: at once again.
    act(() => jest.advanceTimersByTime(10_000));
    addAs('banana', SAM);
    refresh();
    expect(announce.mock.calls[3]).toEqual(['Sam added banana']);
    expect(announce).toHaveBeenCalledTimes(4);
    expect(Haptics.selectionAsync).not.toHaveBeenCalled();
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
  });

  test('what was waiting to be announced is dropped on leaving; my adds are never announced', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    announce.mockClear();
    render();
    add('eggs');
    expect(announce).not.toHaveBeenCalled();
    addAs('limes', ALEX);
    refresh();
    addAs('corn', ALEX);
    refresh();
    mockPath.current = '/recipes';
    refresh();
    act(() => jest.advanceTimersByTime(10_000));
    expect(announce.mock.calls).toEqual([['Alex added limes']]);
  });
});

describe('"Alex is adding" (spec 4.1)', () => {
  const ALEX = 'user-alex';
  const SAM = 'user-sam';
  const JO = 'user-jo';
  const appStateListeners = new Set<(state: AppStateStatus) => void>();
  const appGoes = (state: AppStateStatus) => act(() => appStateListeners.forEach((l) => l(state)));
  /** The list's presence channel, while joined. */
  const channel = (): FakeChannel => {
    const open = openChannels().filter((c) => c.name === `list:${listId}`);
    expect(open).toHaveLength(1);
    return open[0];
  };
  /** The channel's presence: me, plus `userIds`, all adding. */
  const others = (...userIds: string[]) =>
    act(() => setPresence(channel(), Object.fromEntries([USER, ...userIds].map((id) => [id, [{ user_id: id, adding: true }]]))));
  const pills = () => tree!.root.findAll((n) => typeof n.type === 'string' && n.props.testID === 'adding-pill');
  const pillText = () => (pills().length === 0 ? null : (pills()[0].props.accessibilityLabel as string));

  beforeEach(() => {
    resetSupabase();
    appStateListeners.clear();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      appStateListeners.add(listener as (state: AppStateStatus) => void);
      return { remove: () => void appStateListeners.delete(listener as (state: AppStateStatus) => void) } as never;
    });
    const householdId = getList(listId)!.householdId;
    for (const [userId, displayName] of [
      [USER, 'Me Myself'],
      [ALEX, 'Alex Rivera'],
      [SAM, 'Sam Lee'],
      [JO, 'Jo Park'],
    ]) {
      db.insert(householdMemberNames).values({ householdId, userId, displayName, joinedAt: '2026-01-01T00:00:00Z' }).run();
    }
  });

  test('the list on screen joins its private presence topic; nothing shows while no one else is adding', () => {
    render();
    expect(channel().opts).toEqual({ config: { private: true, presence: { key: USER, enabled: true } } });
    expect(pillText()).toBeNull();
    // Only me adding (on another device, say) shows nothing.
    others();
    expect(pillText()).toBeNull();
  });

  test("the pill names one, two, or counts three or more, with the first adder's avatar", () => {
    render();
    others(ALEX);
    expect(pillText()).toBe('Alex is adding');
    expect(lines()).toContain('Alex is adding');
    const avatar = tree!.root.find((n) => typeof n.type === 'string' && n.props.testID === `adding-avatar-${ALEX}`);
    expect(textOf(avatar.findByType('Text' as never))).toBe('A');
    others(ALEX, SAM);
    expect(pillText()).toBe('Alex and Sam are adding');
    others(ALEX, SAM, JO);
    expect(pillText()).toBe('3 people are adding');
    others();
    expect(pills()).toHaveLength(0);
  });

  test('VoiceOver: a static text element, never announced', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    announce.mockClear();
    render();
    others(ALEX);
    const pill = pills()[0];
    expect(pill.props.accessible).toBe(true);
    expect(pill.props.accessibilityRole).toBe('text');
    expect(pill.props.accessibilityLiveRegion).toBeUndefined();
    expect(pill.props.onPress).toBeUndefined();
    act(() => jest.advanceTimersByTime(10_000));
    expect(announce).not.toHaveBeenCalled();
  });

  test('in add mode the pill goes with the header, and the compact title says it in place of "N to get"', () => {
    render();
    others(ALEX);
    onBar((bar) => bar.props.onFocusChange(true));
    expect(pills()).toHaveLength(0);
    expect(hostByLabel('Groceries, Alex is adding')).toBeDefined();
    expect(tree!.root.findAll((n) => typeof n.type === 'string' && n.props.testID === 'compact-adding')).toHaveLength(1);
    // No one else adding: back to the count and view.
    others();
    expect(tree!.root.findAll((n) => typeof n.type === 'string' && n.props.testID === 'compact-adding')).toHaveLength(0);
    expect(tree!.root.findAll((n) => n.props.accessibilityLabel === 'Groceries, Alex is adding')).toHaveLength(0);
    others(ALEX);
    onBar((bar) => bar.props.onFocusChange(false));
    expect(pillText()).toBe('Alex is adding');
  });

  test('tracks adding while the add field is focused and for 10 s after the last add, at most once a second', () => {
    render();
    const ch = channel();
    act(() => setChannelStatus('SUBSCRIBED', ch));
    expect(ch.tracked).toEqual([{ user_id: USER, adding: false }]);
    onBar((bar) => bar.props.onFocusChange(true));
    // Within a second of the last update: held back, then sent.
    expect(ch.tracked.map((p) => p.adding)).toEqual([false]);
    act(() => jest.advanceTimersByTime(1000));
    expect(ch.tracked.map((p) => p.adding)).toEqual([false, true]);
    onBar((bar) => bar.props.onAdd('limes'));
    onBar((bar) => bar.props.onFocusChange(false));
    act(() => jest.advanceTimersByTime(9_999));
    expect(ch.tracked.map((p) => p.adding)).toEqual([false, true]);
    act(() => jest.advanceTimersByTime(1));
    expect(ch.tracked.map((p) => p.adding)).toEqual([false, true, false]);
    // What was typed never goes out.
    expect(JSON.stringify(ch.tracked)).not.toContain('limes');
  });

  test('another tab leaves the channel and the pill goes; coming back joins again', async () => {
    render();
    others(ALEX);
    const first = channel();
    mockPath.current = '/recipes';
    refresh();
    expect(first.removed).toBe(true);
    expect(pills()).toHaveLength(0);
    await act(async () => {});
    mockPath.current = '/lists';
    refresh();
    expect(channel()).not.toBe(first);
    expect(pills()).toHaveLength(0);
  });

  test("the list's own sheets still count as on screen", () => {
    render();
    const first = channel();
    mockPath.current = `/list/${listId}/edit`;
    refresh();
    expect(first.removed).toBe(false);
  });

  test('the app in the background leaves the channel', () => {
    render();
    others(ALEX);
    const first = channel();
    appGoes('background');
    expect(first.removed).toBe(true);
    expect(openChannels()).toEqual([]);
    expect(pills()).toHaveLength(0);
  });

  test('leaving the screen leaves the channel', () => {
    render();
    const first = channel();
    act(() => tree!.unmount());
    tree = null;
    expect(first.removed).toBe(true);
    expect(realtimeChannels).toHaveLength(1);
  });
});
