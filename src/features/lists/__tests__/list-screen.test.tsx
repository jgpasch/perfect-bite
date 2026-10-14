// The list screen (spec 4.1, 4.2, 4.4, 4.5, 4.6), the List tab's root, rendered against the real in-memory database. The row,
// add bar, view button and section header are host stand-ins, so the test reads the props the screen gives
// them and calls their callbacks as a tap, swipe or add would.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as Haptics from 'expo-haptics';
import { StatusBar } from 'expo-status-bar';
import { activateKeepAwakeAsync } from 'expo-keep-awake';
import { AccessibilityInfo, ActionSheetIOS, AppState, Share, StyleSheet, type ActionSheetIOSOptions, type AppStateStatus } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { categories, db, ingredients } from '@/db';
import { categorizePending } from '@/features/categories/categorization';
import { setFeatures } from '@/features/plans/features';
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
import { SYSTEM_CATEGORIES } from '@/shared';
import { resetDb } from '@/test/db';

import { addItem, listItemsQuery, moveItemToList, setItemChecked } from '../items';
import type { RowMove } from '../item-row';
import { addedAt, collapsedSectionsKey, manualOrderKey, viewModeKey } from '../list-view';
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
    useReducedMotion: () => false,
    useAnimatedRef: () => require('react').useRef(null),
    useAnimatedStyle: (fn: () => object) => fn(),
    useSharedValue: (value: unknown) => ({ value }),
    withTiming: (value: unknown) => value,
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
jest.mock('@/features/lists/view-menu-button', () => {
  const { createElement } = require('react');
  return { ViewMenuButton: (props: object) => createElement('ViewMenuButton', props) };
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

const mockPath: { current: string } = { current: '/lists' };
const mockPush = jest.fn();
const mockBack = jest.fn();
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
    router: { push: (...args: unknown[]) => mockPush(...args), back: () => mockBack() },
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
  setFeatures(['categorize']);
  listId = getDefaultListId(USER)!;
  shownId = listId;
  mockPath.current = '/lists';
  mockInvites.current = [];
  mockPush.mockClear();
  mockBack.mockClear();
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
const addBar = () => all('ItemAddBar')[0];
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
// Braces: an onPress that returns a promise (Share.share) would make act async.
const press = (n: ReactTestInstance) =>
  act(() => {
    n.props.onPress();
  });
const tapToast = (label: string) => act(() => hostByLabel(label).props.onClick());
/** An add from the bar; the live query then re-reads, as it would on the write. */
const add = (value: string) => {
  act(() => addBar().props.onAdd(value));
  refresh();
};
const fold = () => all('ViewMenuButton')[0].props.fold as
  | { canCollapse: boolean; canExpand: boolean; onCollapseAll: () => void; onExpandAll: () => void }
  | undefined;
const setView = (mode: string) => act(() => all('ViewMenuButton')[0].props.onChange(mode));

describe('the list', () => {
  test('a missing list renders nothing', () => {
    shownId = 'gone';
    render();
    expect(rows()).toHaveLength(0);
    expect(all('ItemAddBar')).toHaveLength(0);
  });

  test('an empty list says so and offers the add bar', () => {
    render();
    expect(text()).toContain('Nothing on this list yet. Add an item below.');
    expect(addBar().props.placeholder).toBeTruthy();
    // The list's id, so its empty field offers the usual items (spec 4.2).
    expect(addBar().props.listId).toBe(listId);
    expect(lines()).toContain('Groceries');
    expect(text()).not.toContain('to get');
  });

  test('the name is the list switcher, opening Your lists', () => {
    put('milk');
    render();
    const switcher = pressable('Groceries, switch list');
    expect(switcher.props.accessibilityHint).toBe('Shows your other lists');
    expect(switcher.props.accessibilityRole).toBe('button');
    expect(inviteDots(switcher)).toHaveLength(0);
    // The count and the view button sit under it.
    expect(text()).toContain('1 to get');
    expect(all('ViewMenuButton')).toHaveLength(1);
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
    expect(all('ViewMenuButton')[0].props.value).toBe('newest');
    expect(sections()).toHaveLength(0);
    expect(rowNames()).toEqual(['kombucha', 'bananas', 'milk']);
    expect(row('milk').props.aisle).toEqual({ name: 'Dairy & Eggs' });
    // Not categorized yet: Sorting….
    expect(row('kombucha').props.sorting).toBe(true);
    expect(text()).toContain('3 to get');
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
    expect(all('ViewMenuButton')[0].props.value).toBe('category');
  });

  test('without categorize, new names go to Other instead of Sorting…', () => {
    setFeatures([]);
    put('kombucha');
    render();
    setView('category');
    expect(sections().map((s) => s.props.title)).toEqual(['Other']);
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
    act(() => jest.advanceTimersByTime(1000));
    expect(rowNames()).toEqual(['eggs']);
    expect(text()).toContain('1 to get');
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
    act(() => jest.advanceTimersByTime(1000));
    expect(row('milk').props.item.checkedAt).toBeNull();
    expect(text()).not.toContain('Checked,');
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
    act(() => addBar().props.onFocusChange(true));
    act(() => addBar().props.onTextChange('2 mil'));
    expect(hostByLabel('Groceries, 2 to get · As added')).toBeDefined();
    // The big switcher title leaves the header's left slot while the compact one stands in.
    expect(tree!.root.findAll((n) => n.props.accessibilityLabel === 'Groceries, switch list')).toHaveLength(0);
    // Part of a word marks nothing; the whole word does.
    expect(row('milk').props.alreadyOnList).toBeUndefined();
    act(() => addBar().props.onTextChange('2 Milk'));
    expect(row('milk').props.alreadyOnList).toEqual({ query: 'milk' });
    expect(row('eggs').props.alreadyOnList).toBeUndefined();
    act(() => addBar().props.onFocusChange(false));
    expect(row('milk').props.alreadyOnList).toBeUndefined();
  });

  test('a recipe chip adds the whole recipe with Undo and Adjust', () => {
    const recipeId = createRecipe('Tacos', getList(listId)!.householdId);
    addRecipeIngredient(recipeId, 'tortillas');
    addRecipeIngredient(recipeId, 'limes');
    render();
    act(() => addBar().props.onAddRecipe({ id: recipeId, name: 'Tacos', ingredientCount: 2 }));
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
    act(() => addBar().props.onAddRecipe({ id: recipeId, name: 'Tacos', ingredientCount: 4 }));
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
    act(() => addBar().props.onAddRecipe({ id: recipeId, name: 'Tacos', ingredientCount: 5 }));
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
    act(() => addBar().props.onAddRecipe({ id: recipeId, name: 'Tacos', ingredientCount: 1 }));
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
    act(() => addBar().props.onAddRecipe({ id: recipeId, name: 'Tacos', ingredientCount: 2 }));
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
    act(() => addBar().props.onAddRecipe({ id: recipeId, name: 'Tacos', ingredientCount: 1 }));
    tapToast('Undo');
    expect(rows()).toHaveLength(0);
  });

  test('a recipe gone since is ignored', () => {
    render();
    act(() => addBar().props.onAddRecipe({ id: 'gone', name: 'Gone', ingredientCount: 1 }));
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
    expect(all('ItemAddBar')).toHaveLength(1);
    expect(row('milk').props.selected).toBeUndefined();
  });

  test('coming back from Add to recipe leaves Select mode, shows By recipe and the toast', () => {
    put('milk');
    render();
    act(() => row('milk').props.onSelect());
    act(() => setRecipeAddResult({ kind: 'toRecipe', listId, recipeId: 'r1', recipeName: 'Pancakes', count: 1 }));
    expect(all('ItemAddBar')).toHaveLength(1);
    expect(all('ViewMenuButton')[0].props.value).toBe('recipe');
    expect(getDeviceSetting(viewModeKey(listId), null)).toBe('recipe');
    expect(text()).toContain('Added 1 item to Pancakes');
    tapToast('View recipe');
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]', params: { id: 'r1' } });
  });
});

describe('dragging in As added (spec 4.6)', () => {
  const drag = () => all('ReorderableRows')[0];
  const viewMenu = () => all('ViewMenuButton')[0];
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
    act(() => addBar().props.onFocusChange(true));
    expect(drag().props.draggable).toEqual([false, false, false]);
    expect(row('milk').props.reorderable).toBe(false);
    act(() => addBar().props.onFocusChange(false));
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
    act(() => viewMenu().props.onResetOrder());
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
    act(() => viewMenu().props.onResetOrder());
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

    // In the view button's menu.
    act(() => fold()!.onCollapseAll());
    expect(rows()).toHaveLength(0);
    expect(fold()!.canCollapse).toBe(false);
    act(() => fold()!.onExpandAll());
    expect(rowNames()).toEqual(['bananas', 'milk']);
    expect(fold()!.canExpand).toBe(false);
  });

  test('an add into a folded section opens it', () => {
    put('milk');
    render();
    setView('category');
    act(() => section('Dairy & Eggs').props.onToggle());
    add('eggs');
    expect(section('Dairy & Eggs').props.collapsed).toBe(false);
  });

  test('As added has no Collapse all', () => {
    render();
    expect(fold()).toBeUndefined();
  });
});

describe('the list menu', () => {
  test('Select items, Share list, then Edit list… in its own group', () => {
    render();
    const groups = all('ToolbarMenu').filter((m) => m.props.inline);
    expect(groups.map((g) => g.findAll((n) => n.type === ('ToolbarMenuAction' as never)).map((n) => n.props.children))).toEqual([
      ['Select items', 'Share list'],
      ['Edit list…'],
    ]);
    expect(all('ToolbarMenuAction')).toHaveLength(3);
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
    act(() => jest.advanceTimersByTime(1000));
    expect(rowNames()).toEqual(['milk']);
    expect(pressable('Checked, 1 item').props.accessibilityState).toEqual({ expanded: true });
    expect(text()).toContain('All done');
    put('eggs');
    refresh();
    expect(rowNames()).toEqual(['eggs']);
    expect(text()).toContain('1 to get');
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
  test('By aisle ends with Reorder aisles, which opens the aisle order', () => {
    put('milk');
    render();
    expect(tree!.root.findAll((n) => n.props.accessibilityLabel === 'Reorder aisles')).toHaveLength(0);
    setView('category');
    press(pressable('Reorder aisles'));
    expect(mockPush).toHaveBeenCalledWith('/category-order');
  });

  test('By recipe has none', () => {
    put('milk');
    render();
    setView('recipe');
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
