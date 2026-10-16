// Shop this week (spec 4.16, board 3 G): which days and entries each week offers, the sheet's ticks, the
// one bulk add (staples left out, a recipe planned twice, merging across recipes and with the list), Undo,
// Review and the cart's disabled states, against the in-memory database on Thursday, October 15, 2026
// (this week is Oct 11 – 17).
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { PrimaryButton, SurfaceButton } from '@/components/button';
import { Pill } from '@/components/pill';
import { db, households } from '@/db';
import { setStaple } from '@/features/households/staples';
import { addItem, listItemsQuery, setItemChecked } from '@/features/lists/items';
import {
  createList,
  ensureStarterData,
  getDefaultListId,
  getList,
  LAST_OPENED_LIST_KEY,
  setListArchived,
} from '@/features/lists/lists';
import { addWholeRecipeToList } from '@/features/recipes/add-to-list';
import { addRecipeIngredient, createRecipe, deleteRecipe } from '@/features/recipes/recipes';
import { setDeviceSetting } from '@/features/settings/device-settings';
import { i18n } from '@/i18n';
import { resetDb } from '@/test/db';

import PlanShopSheet from '@/app/plan-shop';

import { groupWeek, weekEntriesQuery } from '../queries';
import { openShopSheet, shopDays, shopEntries, shopTitle, shopToastMessage } from '../shop';
import type { SlotToast } from '../slot-actions';
import { WeekPlan } from '../week-plan';
import { clearSlot, setSlot } from '../write';

const mockWindow = { width: 390, height: 844, scale: 3, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => mockWindow }));
jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => {
  const { createElement } = require('react');
  return { Icon: (props: object) => createElement('Icon', props) };
});
jest.mock('expo-image', () => {
  const { createElement } = require('react');
  return { Image: (props: object) => createElement('ExpoImage', props) };
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
    Toggle: host('SwiftToggle'),
  };
});
jest.mock('@expo/ui/swift-ui/modifiers', () => ({
  accessibilityLabel: (value: string) => ({ accessibilityLabel: value }),
}));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: { View } };
});
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
jest.mock('@/features/categories/categorization', () => ({ categorizePending: () => Promise.resolve() }));
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));
const mockParams: { householdId?: string; start?: string } = {};
const mockBack = jest.fn();
const mockPush = jest.fn();
const mockNavigate = jest.fn();
jest.mock('expo-router', () => {
  const { createElement, Fragment } = require('react');
  const Toolbar = Object.assign(
    function PassThrough({ children }: { children?: unknown }) {
      return createElement(Fragment, null, children);
    },
    {
      Button: function Host({ children, ...props }: { children?: unknown }) {
        return createElement('ToolbarButton', props, children);
      },
    },
  );
  return {
    Stack: { Toolbar, Screen: () => null },
    useLocalSearchParams: () => mockParams,
    usePathname: () => '/plan',
    router: { push: (to: unknown) => mockPush(to), back: () => mockBack(), navigate: (to: unknown) => mockNavigate(to) },
  };
});

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const THIS_WEEK = '2026-10-11';
const NEXT_WEEK = '2026-10-18';
const LAST_WEEK = '2026-10-04';

let home: string;
let groceries: string;
let tacos: string;
let pasta: string;
let soup: string;
let tree: ReactTestRenderer | null = null;
let toasts: (SlotToast | null)[];

function recipe(name: string, ingredients: string[]): string {
  const id = createRecipe(name, home);
  for (const text of ingredients) addRecipeIngredient(id, text);
  return id;
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date(2026, 9, 15, 12, 0) });
  resetDb();
  ensureStarterData('user-1');
  groceries = getDefaultListId('user-1')!;
  home = getList(groceries)!.householdId;
  tacos = recipe('Chicken tacos', ['1 lb ground beef', '1 onion', 'salt']);
  pasta = recipe('Lemon ricotta pasta', ['8 oz pasta', '1 onion', '2 tbsp olive oil']);
  soup = recipe('Carrot soup', ['3 carrots']);
  setStaple(home, 'salt', true, 'user-1');
  setStaple(home, 'olive oil', true, 'user-1');
  // Wednesday is before today; Friday lunch is a note; tacos twice.
  setSlot(home, '2026-10-14', 'dinner', { kind: 'recipe', recipeId: soup });
  setSlot(home, '2026-10-15', 'dinner', { kind: 'recipe', recipeId: tacos });
  setSlot(home, '2026-10-16', 'lunch', { kind: 'leftovers' });
  setSlot(home, '2026-10-16', 'dinner', { kind: 'recipe', recipeId: pasta });
  setSlot(home, '2026-10-17', 'dinner', { kind: 'recipe', recipeId: tacos });
  setSlot(home, '2026-10-19', 'lunch', { kind: 'recipe', recipeId: soup });
  mockBack.mockClear();
  mockPush.mockClear();
  mockNavigate.mockClear();
  toasts = [];
});

afterEach(() => {
  const shown = tree;
  tree = null;
  act(() => shown?.unmount());
  jest.useRealTimers();
});

const textOf = (n: ReactTestInstance): string =>
  n.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
const lines = () => tree!.root.findAll((n) => n.type === ('Text' as never)).map(textOf);
/** The Pressable (not its host view) with this VoiceOver label. */
const button = (label: string) =>
  tree!.root.find((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function' && typeof n.type !== 'string');
const press = (label: string) => act(() => button(label).props.onPress());
const checkboxes = () =>
  tree!.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'checkbox' && typeof n.props.onPress === 'function');
/** Each checkbox row's VoiceOver label and whether it's ticked. */
const rows = () => checkboxes().map((n) => [n.props.accessibilityLabel, n.props.accessibilityState.checked]);
const toggle = (label: string) => act(() => checkboxes().find((n) => n.props.accessibilityLabel === label)!.props.onPress());
const ctas = () =>
  tree!.root
    .findAll((n) => n.type === SurfaceButton || n.type === PrimaryButton)
    .map((n) => [n.props.label, !!n.props.disabled]);
/** The list picker's pills, in order, the chosen one marked. */
const pills = () => tree!.root.findAll((n) => n.type === Pill);
const pillLabels = () => pills().map((n) => n.props.label);
const toolbarButton = () => tree!.root.find((n) => n.type === ('ToolbarButton' as never));

/** The list's live amounts: item name, amount and recipe, in list order. */
function listAmounts(listId: string) {
  return listItemsQuery(listId)
    .all()
    .map((r) => [r.ingredientName, r.quantity === null ? null : `${r.quantity}${r.unit ? ` ${r.unit}` : ''}`, r.recipeName ?? r.source]);
}

/** Opens the sheet as the week's cart does, so its toast comes back here. */
function renderSheet(start = THIS_WEEK) {
  openShopSheet(home, start, (toast) => toasts.push(toast));
  mockParams.householdId = home;
  mockParams.start = start;
  act(() => {
    tree = create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <PlanShopSheet />
      </SafeAreaProvider>,
    );
  });
}

const entries = (start: string) => shopEntries(groupWeek(weekEntriesQuery(home, start).all()), shopDays(start, '2026-10-15'));

describe('which days and entries each week offers', () => {
  test('the current week: today to Saturday', () => {
    expect(shopDays(THIS_WEEK, '2026-10-15')).toEqual(['2026-10-15', '2026-10-16', '2026-10-17']);
    // On Sunday the rest of the week is all of it; on Saturday, Saturday.
    expect(shopDays(THIS_WEEK, '2026-10-11')).toHaveLength(7);
    expect(shopDays(THIS_WEEK, '2026-10-17')).toEqual(['2026-10-17']);
    // Any day of the week names it.
    expect(shopDays('2026-10-14', '2026-10-15')).toEqual(['2026-10-15', '2026-10-16', '2026-10-17']);
  });

  test('a future week: every day; a past week: none', () => {
    expect(shopDays(NEXT_WEEK, '2026-10-15')).toEqual([
      '2026-10-18',
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
    ]);
    expect(shopDays(LAST_WEEK, '2026-10-15')).toEqual([]);
  });

  test('the titles, in English and Spanish', () => {
    expect(shopTitle(THIS_WEEK, '2026-10-15')).toBe('Shop the rest of the week');
    expect(shopTitle(NEXT_WEEK, '2026-10-15')).toBe('Shop the week of Oct 18');
    expect(shopTitle('2026-10-28', '2026-10-15')).toBe('Shop the week of Oct 25');
    const before = i18n.language;
    void i18n.changeLanguage('es');
    try {
      expect(shopTitle(THIS_WEEK, '2026-10-15')).toBe('Comprar para el resto de la semana');
      expect(shopTitle(NEXT_WEEK, '2026-10-15')).toBe('Comprar para la semana del 18 oct');
      expect(shopToastMessage(1, 1)).toBe('Se agregaron 1 receta · 1 artículo');
    } finally {
      void i18n.changeLanguage(before);
    }
  });

  test('the recipe entries from today on, in day and meal order; notes and earlier days left out', () => {
    expect(entries(THIS_WEEK).map((e) => [e.day, e.meal, e.recipeName])).toEqual([
      ['2026-10-15', 'dinner', 'Chicken tacos'],
      ['2026-10-16', 'dinner', 'Lemon ricotta pasta'],
      ['2026-10-17', 'dinner', 'Chicken tacos'],
    ]);
    expect(entries(NEXT_WEEK).map((e) => [e.day, e.meal, e.recipeName])).toEqual([['2026-10-19', 'lunch', 'Carrot soup']]);
    expect(entries(LAST_WEEK)).toEqual([]);
  });

  test('a deleted recipe’s entries drop out', () => {
    deleteRecipe(pasta);
    expect(entries(THIS_WEEK).map((e) => e.recipeName)).toEqual(['Chicken tacos', 'Chicken tacos']);
  });

  test('the toast reads "Added 3 recipes · 18 items"', () => {
    expect(shopToastMessage(3, 18)).toBe('Added 3 recipes · 18 items');
    expect(shopToastMessage(1, 1)).toBe('Added 1 recipe · 1 item');
  });
});

describe('the sheet', () => {
  test('the title, the list picker and the entries with their day and meal, all ticked', () => {
    renderSheet();
    expect(lines()).toContain('Shop the rest of the week');
    expect(pills().map((n) => [n.props.label, n.props.selected])).toEqual([['Groceries', true]]);
    expect(rows()).toEqual([
      ['Chicken tacos, Thursday dinner', true],
      ['Lemon ricotta pasta, Friday dinner', true],
      ['Chicken tacos, Saturday dinner', true],
    ]);
    // Ground beef, onion and pasta: salt and olive oil are staples.
    expect(ctas()).toEqual([
      ['Review 3 items', false],
      ['Add 3 to Groceries', false],
    ]);
    expect(lines()).toContain('Ingredients are added for the recipe’s own servings, without what you always have.');
  });

  test('a future week offers every day', () => {
    renderSheet(NEXT_WEEK);
    expect(lines()).toContain('Shop the week of Oct 18');
    expect(rows()).toEqual([['Carrot soup, Monday lunch', true]]);
  });

  test('a recipe already on the chosen list starts unticked, marked "already on Groceries"', () => {
    addWholeRecipeToList(groceries, tacos, 'user-1');
    renderSheet();
    expect(rows()).toEqual([
      ['Chicken tacos, Thursday dinner · already on Groceries', false],
      ['Lemon ricotta pasta, Friday dinner', true],
      ['Chicken tacos, Saturday dinner · already on Groceries', false],
    ]);
    expect(lines()).toContain('Thursday dinner · already on Groceries');
    // Pasta and onion.
    expect(ctas()[1]).toEqual(['Add 2 to Groceries', false]);
  });

  test('a recipe only on a checked item isn’t already on the list', () => {
    const added = addWholeRecipeToList(groceries, tacos, 'user-1')!;
    for (const r of added.results) if (r) setItemChecked(r.itemId, true, 'user-1');
    renderSheet();
    expect(rows().map(([, on]) => on)).toEqual([true, true, true]);
  });

  test('the current list comes first, and picking another list re-reads what’s already on it', () => {
    const costco = createList('Costco', home);
    addWholeRecipeToList(groceries, tacos, 'user-1');
    setDeviceSetting(LAST_OPENED_LIST_KEY, costco);
    renderSheet();
    expect(pillLabels()).toEqual(['Costco', 'Groceries']);
    expect(rows().map(([, on]) => on)).toEqual([true, true, true]);
    expect(ctas()[1]).toEqual(['Add 3 to Costco', false]);

    act(() => pills()[1].props.onPress());
    expect(pills().map((n) => n.props.selected)).toEqual([false, true]);
    expect(rows().map(([, on]) => on)).toEqual([false, true, false]);
    expect(ctas()[1]).toEqual(['Add 2 to Groceries', false]);
  });

  test('another household’s lists and archived lists aren’t offered', () => {
    const old = createList('Old', home);
    setListArchived(old, true);
    db.insert(households).values({ id: 'cabin', name: 'Cabin', createdAt: new Date(2020, 0, 1) }).run();
    createList('Cabin list', 'cabin');
    renderSheet();
    expect(pillLabels()).toEqual(['Groceries']);
  });
});

describe('Add', () => {
  test('adds the ticked entries at 1× without the staples, a recipe planned twice twice, merged across recipes', () => {
    renderSheet();
    press('Add 3 to Groceries');
    expect(mockBack).toHaveBeenCalledTimes(1);
    const amounts = listAmounts(groceries);
    // Tacos on Thursday and Saturday, pasta on Friday: onion from all three, one item.
    expect(amounts.filter(([name]) => name === 'ground beef')).toEqual([
      ['ground beef', '1 lb', 'Chicken tacos'],
      ['ground beef', '1 lb', 'Chicken tacos'],
    ]);
    expect(amounts.filter(([name]) => name === 'onion')).toEqual([
      ['onion', '1', 'Chicken tacos'],
      ['onion', '1', 'Lemon ricotta pasta'],
      ['onion', '1', 'Chicken tacos'],
    ]);
    expect(amounts.filter(([name]) => name === 'pasta')).toEqual([['pasta', '8 oz', 'Lemon ricotta pasta']]);
    expect(amounts.map(([name]) => name)).not.toContain('salt');
    expect(amounts.map(([name]) => name)).not.toContain('olive oil');
    const items = new Set(listItemsQuery(groceries).all().map((r) => r.id));
    expect(items.size).toBe(3);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.message).toBe('Added 3 recipes · 3 items');
    expect(toasts[0]!.actions.map((a) => a.label)).toEqual(['Undo', 'Open list']);
  });

  test('combines with items already on the list', () => {
    addItem(groceries, '2 onions', 'user-1');
    const before = listItemsQuery(groceries).all();
    expect(before).toHaveLength(1);
    renderSheet();
    press('Add 3 to Groceries');
    const onion = listItemsQuery(groceries)
      .all()
      .filter((r) => r.id === before[0].id);
    expect(onion.map((r) => [r.quantity, r.recipeName ?? r.source])).toEqual([
      [2, 'manual'],
      [1, 'Chicken tacos'],
      [1, 'Lemon ricotta pasta'],
      [1, 'Chicken tacos'],
    ]);
    expect(new Set(listItemsQuery(groceries).all().map((r) => r.id)).size).toBe(3);
  });

  test('only the ticked entries', () => {
    renderSheet();
    toggle('Chicken tacos, Saturday dinner');
    toggle('Lemon ricotta pasta, Friday dinner');
    expect(ctas()[1]).toEqual(['Add 2 to Groceries', false]);
    press('Add 2 to Groceries');
    expect(listAmounts(groceries)).toEqual([
      ['ground beef', '1 lb', 'Chicken tacos'],
      ['onion', '1', 'Chicken tacos'],
    ]);
    expect(toasts[0]!.message).toBe('Added 1 recipe · 2 items');
  });

  test('Undo removes the whole add, leaving earlier items as they were', () => {
    addItem(groceries, '2 onions', 'user-1');
    const before = listAmounts(groceries);
    renderSheet();
    press('Add 3 to Groceries');
    expect(listAmounts(groceries)).toHaveLength(7);
    act(() => toasts[0]!.actions[0].onPress());
    expect(listAmounts(groceries)).toEqual(before);
    expect(toasts[1]).toBeNull();
  });

  test('Open list makes the list current and shows it', () => {
    renderSheet();
    press('Add 3 to Groceries');
    act(() => toasts[0]!.actions[1].onPress());
    expect(mockNavigate).toHaveBeenCalledWith('/lists');
    expect(toasts[1]).toBeNull();
  });

  test('nothing ticked: both CTAs disabled', () => {
    renderSheet();
    toggle('Chicken tacos, Thursday dinner');
    toggle('Lemon ricotta pasta, Friday dinner');
    toggle('Chicken tacos, Saturday dinner');
    expect(ctas()).toEqual([
      ['Review 0 items', true],
      ['Nothing selected', true],
    ]);
  });

  test('every ingredient a staple: nothing to add', () => {
    setStaple(home, 'ground beef', true, 'user-1');
    setStaple(home, 'onion', true, 'user-1');
    setStaple(home, 'pasta', true, 'user-1');
    renderSheet();
    expect(ctas()).toEqual([
      ['Review 0 items', false],
      ['Nothing selected', true],
    ]);
  });
});

describe('Review', () => {
  test('shows the merged ingredients with the staples unticked, and adds what’s ticked', () => {
    renderSheet();
    press('Review 3 items');
    expect(lines()).toContain('Review');
    expect(lines()).toContain('3 of 5');
    expect(rows()).toEqual([
      ['Ground beef, 2 lb', true],
      ['Onion, 3', true],
      ['Salt, Always have', false],
      ['Pasta, 8 oz', true],
      ['Olive oil, Always have, 2 tbsp', false],
    ]);
    toggle('Salt, Always have');
    toggle('Pasta, 8 oz');
    expect(ctas()).toEqual([['Add 3 to Groceries', false]]);
    press('Add 3 to Groceries');
    expect(listAmounts(groceries).map(([name]) => name)).toEqual(['ground beef', 'ground beef', 'onion', 'onion', 'onion', 'salt', 'salt']);
    expect(toasts[0]!.message).toBe('Added 3 recipes · 3 items');
  });

  test('Back returns to the entries, keeping their ticks', () => {
    renderSheet();
    toggle('Chicken tacos, Saturday dinner');
    press('Review 3 items');
    expect(toolbarButton().props.children).toBe('Back');
    act(() => toolbarButton().props.onPress());
    expect(rows().map(([, on]) => on)).toEqual([true, true, false]);
    expect(toolbarButton().props.children).toBe('Cancel');
    act(() => toolbarButton().props.onPress());
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});

describe('the cart', () => {
  function renderWeek() {
    act(() => {
      tree = create(
        <SafeAreaProvider initialMetrics={METRICS}>
          <WeekPlan onToast={(toast) => toasts.push(toast)} />
        </SafeAreaProvider>,
      );
    });
  }
  const cart = () => button('Shop this week');
  const cartDisabled = () =>
    tree!.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === 'Shop this week' && n.props.accessibilityState)
      .props.accessibilityState.disabled;

  test('opens the sheet for the household’s week', () => {
    renderWeek();
    expect(cartDisabled()).toBe(false);
    act(() => cart().props.onPress());
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/plan-shop', params: { householdId: home, start: THIS_WEEK } });
    press('Next week');
    expect(cartDisabled()).toBe(false);
    act(() => cart().props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/plan-shop', params: { householdId: home, start: NEXT_WEEK } });
  });

  test('disabled for a past week, even with recipes planned', () => {
    setSlot(home, '2026-10-06', 'dinner', { kind: 'recipe', recipeId: tacos });
    renderWeek();
    press('Previous week');
    expect(cartDisabled()).toBe(true);
  });

  test('disabled when the days it covers have no recipes', () => {
    clearSlot(home, '2026-10-15', 'dinner');
    clearSlot(home, '2026-10-16', 'dinner');
    clearSlot(home, '2026-10-17', 'dinner');
    // Wednesday's soup is before today, and Friday's Leftovers has nothing to buy.
    renderWeek();
    expect(cartDisabled()).toBe(true);
    // Two weeks on, nothing planned.
    press('Next week');
    expect(cartDisabled()).toBe(false);
    press('Next week');
    expect(cartDisabled()).toBe(true);
  });
});
