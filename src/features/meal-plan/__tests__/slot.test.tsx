// Filling and clearing slots from the week (spec 4.16, board 2 F): the slot sheet, a filled slot's menu,
// the note prompt, and Clear with Undo, against the in-memory database on Thursday, October 15, 2026.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { ActionSheetIOS, Alert, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { Palette, Sizes } from '@/constants/theme';
import { db, households, recipes } from '@/db';
import { ensureStarterData, getDefaultListId, getList } from '@/features/lists/lists';
import type { FavoritesByRecipe } from '@/features/recipes/favorites';
import {
  activeFilterCount,
  noRecipeFilters,
  toggleRecipeFilter,
  untaggedOnlyFilters,
  type RecipeFilters,
} from '@/features/recipes/recipe-filters';
import { setMyFavorite } from '@/features/recipes/favorites';
import { createRecipe, recipesQuery } from '@/features/recipes/recipes';
import { setDeviceSetting, PLAN_VIEW_KEY } from '@/features/settings/device-settings';
import { emptyRecipeTags, type RecipeTags } from '@/shared/recipe-tags';
import { resetDb } from '@/test/db';

import PlanScreen from '@/app/(tabs)/plan/index';
import PlanMealSheet from '@/app/plan-meal';
import PlanSlotSheet from '@/app/plan-slot';
import { i18n } from '@/i18n';

import { groupWeek, weekEntriesQuery } from '../queries';
import {
  openAddSheet,
  openMealSheet,
  openSlotSheet,
  promptNote,
  quickChipOn,
  recipeAddedLabel,
  type SlotToast,
  slotMenuActions,
  slotSheetRecipes,
  toggleQuickChip,
} from '../slot-actions';
import type { Meal } from '../week';
import { addRecipeToSlot, setSlot } from '../write';

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
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const builder: object = new Proxy({}, { get: () => () => builder });
  return {
    __esModule: true,
    default: { View },
    FadeIn: builder,
    FadeInDown: builder,
    FadeOut: builder,
    LinearTransition: builder,
    ReduceMotion: { Never: 'never' },
    useReducedMotion: () => false,
  };
});
jest.mock('@expo/ui/swift-ui', () => {
  const { createElement } = require('react');
  const host = (type: string) =>
    function Host({ children, ...props }: { children?: unknown }) {
      return createElement(type, props, children);
    };
  return {
    Group: host('SwiftGroup'),
    Host: host('SwiftHost'),
    List: Object.assign(host('SwiftList'), { ForEach: host('SwiftForEach') }),
    Menu: ({ label, children, ...props }: { label?: unknown; children?: unknown }) => createElement('SwiftMenu', props, label, children),
    RNHostView: host('RNHostView'),
    Section: host('SwiftSection'),
    Toggle: host('SwiftToggle'),
  };
});
jest.mock('@expo/ui/swift-ui/modifiers', () => ({
  accessibilityLabel: (value: string) => ({ accessibilityLabel: value }),
  accessibilityHint: (value: string) => ({ accessibilityHint: value }),
  deleteDisabled: () => ({ deleteDisabled: true }),
  environment: (key: string, value: string) => ({ environment: [key, value] }),
  listRowBackground: (color: string) => ({ listRowBackground: color }),
  listRowInsets: (insets: object) => ({ listRowInsets: insets }),
  listRowSeparatorTint: (color: string) => ({ listRowSeparatorTint: color }),
  listStyle: (style: string) => ({ listStyle: style }),
  scrollContentBackground: (value: string) => ({ scrollContentBackground: value }),
  scrollDisabled: (value: boolean) => ({ scrollDisabled: value }),
}));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
const mockParams: { householdId?: string; day?: string; meal?: string; mode?: string } = {};
const mockPush = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
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
    Stack: { Toolbar },
    usePathname: () => '/plan',
    useLocalSearchParams: () => mockParams,
    router: {
      push: (...args: unknown[]) => mockPush(...args),
      back: () => mockBack(),
      replace: (...args: unknown[]) => mockReplace(...args),
      navigate: () => {},
    },
  };
});
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const THURSDAY = '2026-10-15';
const SUNDAY = '2026-10-11';

let home: string;
let other: string;
let tacos: string;
let ensalada: string;
let pancakes: string;
let tree: ReactTestRenderer | null = null;

function tag(recipeId: string, meal: string[], totalMinutes: number | null = null) {
  const tags: RecipeTags = { ...emptyRecipeTags(), meal };
  db.update(recipes).set({ tags, totalMinutes }).where(eq(recipes.id, recipeId)).run();
}

/** The slot's entries as `weekEntriesQuery` reads them, the shown one first. */
function slotNow(day: string, meal: Meal) {
  return groupWeek(weekEntriesQuery(home, SUNDAY).all()).slotEntries(day, meal);
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date(2026, 9, 15, 12, 0) });
  resetDb();
  ensureStarterData('user-1');
  home = getList(getDefaultListId('user-1')!)!.householdId;
  other = 'household-2';
  db.insert(households).values({ id: other, name: 'Beach house' }).run();
  tacos = createRecipe('Chicken tacos', home);
  ensalada = createRecipe('Énsalada verde', home);
  pancakes = createRecipe('Pancakes', home);
  createRecipe('Jalapeño poppers', home); // untagged
  tag(tacos, ['dinner'], 35);
  tag(ensalada, ['lunch', 'dinner']);
  tag(pancakes, ['breakfast'], 20);
  createRecipe('Beach chili', other);
  mockPush.mockClear();
  mockBack.mockClear();
  mockReplace.mockClear();
  for (const key of Object.keys(mockParams)) delete mockParams[key as keyof typeof mockParams];
});

afterEach(() => {
  const shown = tree;
  tree = null;
  act(() => shown?.unmount());
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const textOf = (n: ReactTestInstance): string =>
  n.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
const lines = () => tree!.root.findAll((n) => n.type === ('Text' as never)).map(textOf);
/** The Pressable (not its host view) with this VoiceOver label. */
const button = (label: string) =>
  tree!.root.find((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function' && typeof n.type !== 'string');
const press = (label: string) => act(() => button(label).props.onPress());
const recipeRows = () =>
  tree!.root
    .findAll((n) => typeof n.type !== 'string' && /^slot-recipe-/.test(n.props.testID ?? '') && typeof n.props.onPress === 'function')
    .map((n) => n.props.accessibilityLabel as string);

describe('slotSheetRecipes', () => {
  const tags = (t: Partial<RecipeTags>): RecipeTags => ({ ...emptyRecipeTags(), ...t });
  const at = (day: number, hour = 12) => new Date(2026, 9, day, hour);
  const all = () => [
    { id: 't', name: 'Chicken tacos', householdId: 'h', tags: tags({ meal: ['dinner'] }), totalMinutes: 25, createdAt: at(10) },
    {
      id: 'e',
      name: 'Énsalada verde',
      householdId: 'h',
      tags: tags({ meal: ['lunch', 'dinner'], saved: ['want-to-try'] }),
      totalMinutes: null,
      createdAt: at(14),
    },
    { id: 'a', name: 'apple crumble', householdId: 'h', tags: tags({ meal: ['dinner'] }), totalMinutes: 90, createdAt: at(10) },
    { id: 'j', name: 'Jalapeño poppers', householdId: 'h', tags: null, totalMinutes: null, createdAt: at(15, 9) },
    { id: 'x', name: 'Beach chili', householdId: 'other', tags: tags({ meal: ['dinner'] }), totalMinutes: null, createdAt: at(15, 11) },
  ];
  const ids = (r: { id: string }[]) => r.map((x) => x.id);
  const none = noRecipeFilters();
  const list = (opts: Partial<{ query: string; filters: RecipeFilters; sort: 'recent' | 'name' }>, favorites?: FavoritesByRecipe) =>
    ids(slotSheetRecipes(all(), { householdId: 'h', query: '', filters: none, sort: 'recent', ...opts }, favorites, 'en'));

  test("Newest first: every recipe of the household (tagged or not), newest added first, ties A–Z ignoring case and accents", () => {
    expect(list({})).toEqual(['j', 'e', 'a', 't']);
  });

  test('A–Z ignores case and accents, and never shows another household', () => {
    expect(list({ sort: 'name' })).toEqual(['a', 't', 'e', 'j']);
  });

  test('A–Z breaks a tie on the name by the other names around it (stable, same name together)', () => {
    const twins = [
      { id: '1', name: 'Tacos', householdId: 'h', tags: null, totalMinutes: null, createdAt: at(1) },
      { id: '2', name: 'tacos', householdId: 'h', tags: null, totalMinutes: null, createdAt: at(3) },
      { id: '3', name: 'Apple', householdId: 'h', tags: null, totalMinutes: null, createdAt: at(2) },
    ];
    expect(ids(slotSheetRecipes(twins, { householdId: 'h', query: '', filters: none, sort: 'name' }, undefined, 'en'))).toEqual([
      '3',
      '1',
      '2',
    ]);
    // Newest first with the same time: A–Z.
    const sameTime = twins.map((r) => ({ ...r, createdAt: at(5) }));
    expect(ids(slotSheetRecipes(sameTime, { householdId: 'h', query: '', filters: none, sort: 'recent' }, undefined, 'en'))).toEqual([
      '3',
      '1',
      '2',
    ]);
  });

  test('search looks through the household’s recipes by name, ignoring case and accents', () => {
    expect(list({ query: 'JALAPENO' })).toEqual(['j']);
    expect(list({ query: 'ensalada' })).toEqual(['e']);
    expect(list({ query: 'p', sort: 'name' })).toEqual(['a', 'j']);
    expect(list({ query: 'chili' })).toEqual([]);
    expect(list({ query: '  ' })).toEqual(['j', 'e', 'a', 't']); // blank: everything
  });

  test('filters narrow the list and combine with search and the sort', () => {
    const dinner = toggleQuickChip(none, 'meal', 'dinner');
    expect(list({ filters: dinner })).toEqual(['e', 'a', 't']);
    expect(list({ filters: dinner, sort: 'name' })).toEqual(['a', 't', 'e']);
    expect(list({ filters: toggleQuickChip(none, 'meal', 'breakfast') })).toEqual([]);
    expect(list({ filters: toggleQuickChip(dinner, 'want-to-try', 'dinner') })).toEqual(['e']);
    expect(list({ filters: toggleRecipeFilter(dinner, 'time', 'under-30') })).toEqual(['t']);
    expect(list({ filters: dinner, query: 'c' })).toEqual(['a', 't']);
    expect(list({ filters: dinner, query: 'poppers' })).toEqual([]);
    expect(list({ filters: untaggedOnlyFilters() })).toEqual(['j']);
  });

  test("Favorites matches anyone's favorite in the household, from the favorites data", () => {
    const favorites: FavoritesByRecipe = new Map([
      ['t', { mine: false, others: ['user-2'] }],
      ['j', { mine: true, others: [] }],
      ['x', { mine: true, others: [] }],
    ]);
    const fav = toggleQuickChip(none, 'favorites', 'dinner');
    expect(list({ filters: fav }, favorites)).toEqual(['j', 't']);
    expect(list({ filters: fav })).toEqual([]); // no favorites data: none
    expect(list({ filters: toggleRecipeFilter(none, 'saved', 'my-favorites') }, favorites)).toEqual(['j']);
    expect(list({ filters: toggleQuickChip(fav, 'meal', 'dinner') }, favorites)).toEqual(['t']);
  });
});

describe('quick chips', () => {
  const none = noRecipeFilters();

  test('the meal chip is tags.meal holding the slot’s meal, on and off', () => {
    const on = toggleQuickChip(none, 'meal', 'lunch');
    expect(on.tags.meal).toEqual(['lunch']);
    expect(quickChipOn(on, 'meal', 'lunch')).toBe(true);
    expect(quickChipOn(on, 'meal', 'dinner')).toBe(false);
    expect(on).toEqual({ ...none, tags: { ...none.tags, meal: ['lunch'] } });
    const off = toggleQuickChip(on, 'meal', 'lunch');
    expect(off).toEqual(none);
    expect(quickChipOn(off, 'meal', 'lunch')).toBe(false);
  });

  test('Favorites is the Favorites filter value, not a tag, and leaves My favorites alone', () => {
    const mine = toggleRecipeFilter(none, 'saved', 'my-favorites');
    const on = toggleQuickChip(mine, 'favorites', 'dinner');
    expect(on.favorites).toEqual(['my-favorites', 'favorites']);
    expect(on.tags.saved).toEqual([]);
    expect(quickChipOn(on, 'favorites', 'dinner')).toBe(true);
    expect(quickChipOn(mine, 'favorites', 'dinner')).toBe(false);
    const off = toggleQuickChip(on, 'favorites', 'dinner');
    expect(off.favorites).toEqual(['my-favorites']);
  });

  test('Want to try is tags.saved want-to-try, and keeps the favorites values in the same facet', () => {
    let filters = toggleRecipeFilter(none, 'saved', 'my-favorites');
    filters = toggleRecipeFilter(filters, 'saved', 'favorites');
    const on = toggleQuickChip(filters, 'want-to-try', 'dinner');
    expect(on.tags.saved).toEqual(['want-to-try']);
    expect(on.favorites).toEqual(['my-favorites', 'favorites']);
    expect(quickChipOn(on, 'want-to-try', 'dinner')).toBe(true);
    expect(quickChipOn(on, 'favorites', 'dinner')).toBe(true);
    const off = toggleQuickChip(on, 'want-to-try', 'dinner');
    expect(off.tags.saved).toEqual([]);
    expect(off.favorites).toEqual(['my-favorites', 'favorites']);
    expect(quickChipOn(off, 'want-to-try', 'dinner')).toBe(false);
  });

  test("recipesQuery gives each recipe's createdAt", () => {
    const row = recipesQuery()
      .all()
      .find((r) => r.id === tacos)!;
    expect(row.createdAt).toEqual(new Date(2026, 9, 15, 12, 0));
  });

  test('a chip leaves the other facets, the time and the other chips as they were, and counts in Filters', () => {
    let filters = toggleRecipeFilter(none, 'cuisine', 'mexican');
    filters = toggleRecipeFilter(filters, 'time', 'under-30');
    filters = toggleRecipeFilter(filters, 'meal', 'breakfast');
    const on = toggleQuickChip(toggleQuickChip(filters, 'meal', 'dinner'), 'want-to-try', 'dinner');
    expect(on.tags.cuisine).toEqual(['mexican']);
    expect(on.time).toEqual(['under-30']);
    expect(on.tags.meal).toEqual(['breakfast', 'dinner']);
    expect(activeFilterCount(on)).toBe(5);
    expect(quickChipOn(on, 'favorites', 'dinner')).toBe(false);
    expect(toggleQuickChip(toggleQuickChip(on, 'meal', 'dinner'), 'want-to-try', 'dinner')).toEqual(filters);
  });

  test('a chip turns Untagged off', () => {
    const on = toggleQuickChip(untaggedOnlyFilters(), 'meal', 'dinner');
    expect(on.untagged).toBe(false);
    expect(on.tags.meal).toEqual(['dinner']);
  });
});

describe('recipeAddedLabel', () => {
  afterEach(() => void i18n.changeLanguage('en'));
  const now = new Date(2026, 9, 22, 0, 5); // Thu Oct 22, just after midnight

  test('today and yesterday by the local calendar day, around midnight', () => {
    expect(recipeAddedLabel(new Date(2026, 9, 22, 0, 0), now)).toBe('Added today');
    expect(recipeAddedLabel(new Date(2026, 9, 21, 23, 59), now)).toBe('Added yesterday');
    expect(recipeAddedLabel(new Date(2026, 9, 21, 0, 0), now)).toBe('Added yesterday');
    expect(recipeAddedLabel(new Date(2026, 9, 20, 23, 59), now)).toBe('Added Tue');
    expect(recipeAddedLabel(new Date(2026, 9, 21, 23, 59), new Date(2026, 9, 21, 23, 59, 30))).toBe('Added today');
    // A clock that's behind: today.
    expect(recipeAddedLabel(new Date(2026, 9, 23, 8), now)).toBe('Added today');
  });

  test('the weekday for the last seven days, then the date', () => {
    expect(recipeAddedLabel(new Date(2026, 9, 19, 9), now)).toBe('Added Mon');
    expect(recipeAddedLabel(new Date(2026, 9, 16, 9), now)).toBe('Added Fri');
    expect(recipeAddedLabel(new Date(2026, 9, 15, 23, 59), now)).toBe('Added Oct 15');
    expect(recipeAddedLabel(new Date(2026, 9, 12, 9), now)).toBe('Added Oct 12');
  });

  test('the year only in another year, across the year boundary', () => {
    const newYear = new Date(2027, 0, 1, 0, 1);
    expect(recipeAddedLabel(new Date(2026, 11, 31, 23, 59), newYear)).toBe('Added yesterday');
    expect(recipeAddedLabel(new Date(2026, 11, 28, 10), newYear)).toBe('Added Mon');
    expect(recipeAddedLabel(new Date(2026, 11, 24, 10), newYear)).toBe('Added Dec 24, 2026');
    expect(recipeAddedLabel(new Date(2025, 9, 12, 10), now)).toBe('Added Oct 12, 2025');
  });

  test('in Spanish', async () => {
    await i18n.changeLanguage('es');
    expect(recipeAddedLabel(new Date(2026, 9, 22, 0, 0), now)).toBe('Agregada hoy');
    expect(recipeAddedLabel(new Date(2026, 9, 21, 23, 59), now)).toBe('Agregada ayer');
    expect(recipeAddedLabel(new Date(2026, 9, 19, 9), now)).toBe('Agregada el lun');
    expect(recipeAddedLabel(new Date(2026, 9, 12, 9), now)).toBe('Agregada el 12 oct');
    expect(recipeAddedLabel(new Date(2025, 9, 12, 9), now)).toBe('Agregada el 12 oct 2025');
  });
});

describe('slotMenuActions', () => {
  test('each note kind gets its items, with no Open recipe', () => {
    expect(slotMenuActions('leftovers')).toEqual(['replace', 'clear']);
    expect(slotMenuActions('eating-out')).toEqual(['replace', 'clear']);
    expect(slotMenuActions('note')).toEqual(['replace', 'editNote', 'clear']);
  });
});

describe('promptNote', () => {
  type Buttons = { text?: string; onPress?: (text?: string) => void }[];
  function spyPrompt() {
    return jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
  }
  const save = (prompt: ReturnType<typeof spyPrompt>, call: number, text: string) =>
    act(() => (prompt.mock.calls[call][2] as Buttons).find((b) => b.text === 'Save')!.onPress!(text));

  test('asks for up to 60 characters, starting from the current note', () => {
    const prompt = spyPrompt();
    promptNote('Pizza night', () => {});
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0][0]).toBe('Note');
    expect(prompt.mock.calls[0][1]).toBe('Up to 60 characters');
    expect(prompt.mock.calls[0][3]).toBe('plain-text');
    expect(prompt.mock.calls[0][4]).toBe('Pizza night');
  });

  test('60 characters is saved, trimmed', () => {
    const prompt = spyPrompt();
    const onSave = jest.fn();
    promptNote('', onSave);
    save(prompt, 0, `  ${'a'.repeat(60)}  `);
    expect(onSave).toHaveBeenCalledWith('a'.repeat(60));
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  test('61 characters asks again with what was typed; a blank note is dropped', () => {
    const prompt = spyPrompt();
    const onSave = jest.fn();
    promptNote('', onSave);
    save(prompt, 0, 'b'.repeat(61));
    expect(onSave).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[1][1]).toBe('That’s 61 characters. Notes are up to 60.');
    expect(prompt.mock.calls[1][4]).toBe('b'.repeat(61));
    save(prompt, 1, '   ');
    expect(onSave).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(2);
  });
});

describe('the slot sheet', () => {
  function open(day: string, meal: string, householdId = home) {
    Object.assign(mockParams, { householdId, day, meal });
    act(() => {
      tree = create(
        <SafeAreaProvider initialMetrics={METRICS}>
          <PlanSlotSheet />
        </SafeAreaProvider>,
      );
    });
  }
  const ALL = [
    'Chicken tacos, 35 min · Added today',
    'Énsalada verde, Added today',
    'Jalapeño poppers, Added today',
    'Pancakes, 20 min · Added today',
  ];
  /** The quick chip or panel value (a `Pill`'s Pressable) with this label. */
  const pill = (label: string) => button(label);
  const selected = (label: string) => pill(label).props.accessibilityState.selected as boolean;
  const removeChips = () =>
    tree!.root
      .findAll((n) => typeof n.type !== 'string' && /^Remove .* filter$/.test(n.props.accessibilityLabel ?? '') && typeof n.props.onPress === 'function')
      .map((n) => n.props.accessibilityLabel as string);
  const showRecipes = () =>
    act(() =>
      tree!.root
        .find((n) => typeof n.type !== 'string' && /^Show \d+ recipes?$/.test(n.props.label ?? '') && typeof n.props.onPress === 'function')
        .props.onPress(),
    );
  const sortTo = (label: string) =>
    act(() => tree!.root.find((n) => n.type === ('SwiftToggle' as never) && n.props.label === label).props.onIsOnChange(true));

  test('titled with the day over the meal; opens on every recipe, newest first, with "All recipes"', () => {
    open(THURSDAY, 'dinner');
    expect(lines().slice(0, 2)).toEqual(['Thursday 15', 'Dinner']);
    expect(lines()).toContain('All recipes');
    expect(lines()).toContain('Newest first');
    expect(recipeRows()).toEqual(ALL); // all added together: A–Z
    expect(lines()).not.toContain('Show all recipes');
    expect(lines()).not.toContain('Clear filters');
  });

  test('a new recipe without tags comes first, its second line saying when it was added', () => {
    jest.setSystemTime(new Date(2026, 9, 15, 18, 0));
    createRecipe('Zucchini fritters', home);
    jest.setSystemTime(new Date(2026, 9, 16, 9, 0));
    open(THURSDAY, 'breakfast');
    expect(recipeRows()).toEqual([
      'Zucchini fritters, Added yesterday',
      'Chicken tacos, 35 min · Added yesterday',
      'Énsalada verde, Added yesterday',
      'Jalapeño poppers, Added yesterday',
      'Pancakes, 20 min · Added yesterday',
    ]);
    expect(lines()).toContain('20 min · Added yesterday');
  });

  test('the sort menu switches to A–Z and back to Newest first', () => {
    jest.setSystemTime(new Date(2026, 9, 15, 13, 0));
    createRecipe('Apple crumble', home);
    open(THURSDAY, 'dinner');
    expect(recipeRows()[0]).toBe('Apple crumble, Added today');
    expect(tree!.root.find((n) => n.type === ('SwiftMenu' as never)).props.modifiers).toContainEqual({
      accessibilityLabel: 'Sort: Newest first',
    });
    sortTo('A–Z');
    expect(recipeRows().map((r) => r.split(',')[0])).toEqual(['Apple crumble', 'Chicken tacos', 'Énsalada verde', 'Jalapeño poppers', 'Pancakes']);
    expect(lines()).toContain('A–Z');
    sortTo('Newest first');
    expect(recipeRows()[0]).toBe('Apple crumble, Added today');
  });

  test('the quick chips (the meal, Favorites, Want to try) narrow the list and toggle off', () => {
    setMyFavorite(pancakes, true);
    db.update(recipes).set({ tags: { ...emptyRecipeTags(), saved: ['want-to-try'] } }).where(eq(recipes.id, ensalada)).run();
    open(THURSDAY, 'dinner');
    expect(['Dinner', 'Favorites', 'Want to try'].map(selected)).toEqual([false, false, false]);

    press('Dinner');
    expect(selected('Dinner')).toBe(true);
    expect(recipeRows()).toEqual(['Chicken tacos, 35 min · Added today']);
    expect(lines()).toContain('1 recipe');
    press('Dinner');
    expect(selected('Dinner')).toBe(false);
    expect(recipeRows()).toEqual(ALL);
    expect(lines()).toContain('All recipes');

    press('Favorites');
    expect(recipeRows()).toEqual(['Pancakes, 20 min · Added today']);
    press('Favorites');
    press('Want to try');
    expect(selected('Want to try')).toBe(true);
    expect(recipeRows()).toEqual(['Énsalada verde, Added today']);
    press('Want to try');
    expect(recipeRows()).toEqual(ALL);
    // The quick chips count in "Filters · N" but aren't repeated as ✕ chips.
    press('Favorites');
    expect(button('Filters, 1 active')).toBeTruthy();
    expect(removeChips()).toEqual([]);
  });

  test('chips and search narrow together', () => {
    open(THURSDAY, 'lunch');
    press('Lunch');
    const field = tree!.root.find((n) => n.type === ('TextInput' as never) && n.props.accessibilityLabel === 'Search recipes');
    act(() => field.props.onChangeText('ENSA'));
    expect(recipeRows()).toEqual(['Énsalada verde, Added today']);
    act(() => field.props.onChangeText('tacos'));
    expect(recipeRows()).toEqual([]);
    expect(lines()).toContain('No recipes match');
    expect(lines()).toContain('0 recipes');
  });

  test('Filters opens the panel in the sheet; a picked value shows as a ✕ chip, and removing it widens the list', () => {
    open(THURSDAY, 'dinner');
    press('Filters');
    expect(recipeRows()).toEqual([]); // the panel shows in place of the list
    press('Breakfast');
    showRecipes();
    expect(recipeRows()).toEqual(['Pancakes, 20 min · Added today']);
    expect(removeChips()).toEqual(['Remove Breakfast filter']);
    expect(button('Filters, 1 active')).toBeTruthy();
    press('Remove Breakfast filter');
    expect(recipeRows()).toEqual(ALL);
    expect(removeChips()).toEqual([]);
  });

  test('the meal chip and the panel’s meal value stay in step', () => {
    open(THURSDAY, 'dinner');
    press('Dinner');
    press('Filters, 1 active');
    expect(selected('Dinner')).toBe(true);
    press('Dinner'); // off in the panel
    showRecipes();
    expect(selected('Dinner')).toBe(false);
    expect(recipeRows()).toEqual(ALL);
    press('Filters');
    press('Dinner'); // on in the panel
    showRecipes();
    expect(selected('Dinner')).toBe(true);
    expect(removeChips()).toEqual([]);
    expect(recipeRows()).toEqual(['Chicken tacos, 35 min · Added today', 'Énsalada verde, Added today']);
  });

  test('Clear filters (with anything on) turns every chip and filter off, keeping the search', () => {
    open(THURSDAY, 'dinner');
    expect(lines()).not.toContain('Clear filters');
    press('Dinner');
    press('Filters, 1 active');
    press('Under 1 hour');
    showRecipes();
    expect(recipeRows()).toEqual(['Chicken tacos, 35 min · Added today']);
    const field = tree!.root.find((n) => n.type === ('TextInput' as never) && n.props.accessibilityLabel === 'Search recipes');
    act(() => field.props.onChangeText('ensalada'));
    expect(lines()).toContain('No recipes match');
    expect(lines()).toContain('Clear filters');
    press('Clear filters');
    expect(recipeRows()).toEqual(['Énsalada verde, Added today']);
    act(() => field.props.onChangeText(''));
    expect(recipeRows()).toEqual(ALL);
    expect(selected('Dinner')).toBe(false);
    expect(lines()).not.toContain('Clear filters');
    expect(lines()).toContain('All recipes');
  });

  test('a household without recipes says "No recipes yet"', () => {
    db.insert(households).values({ id: 'household-3', name: 'Cabin' }).run();
    open(THURSDAY, 'dinner', 'household-3');
    expect(recipeRows()).toEqual([]);
    expect(lines()).toContain('No recipes yet');
  });

  test('search matches names across all recipes, ignoring case and accents', () => {
    open(THURSDAY, 'breakfast');
    const field = tree!.root.find((n) => n.type === ('TextInput' as never) && n.props.accessibilityLabel === 'Search recipes');
    act(() => field.props.onChangeText('JALAPENO'));
    expect(recipeRows()).toEqual(['Jalapeño poppers, Added today']);
    act(() => field.props.onChangeText('chili'));
    expect(recipeRows()).toEqual([]);
    expect(lines()).toContain('No recipes match');
  });

  test('the Not cooking? bar is pinned outside the list, with its three buttons', () => {
    open(THURSDAY, 'dinner');
    const bar = tree!.root.find((n) => n.props.testID === 'not-cooking' && typeof n.type === 'string');
    expect(bar.findAll((n) => n.type === ('Text' as never)).map(textOf)).toEqual(['Not cooking?', 'Leftovers', 'Eating out', 'Note…']);
    expect(bar.findAll((n) => n.type === ('Icon' as never)).map((n) => n.props.name)).toEqual([
      'takeoutbag.and.cup.and.straw',
      'fork.knife',
      'note.text',
    ]);
    const scroll = tree!.root.find((n) => n.type === ('RCTScrollView' as never) && n.props.contentInsetAdjustmentBehavior === 'automatic');
    expect(scroll.findAll((n) => n.props.testID === 'not-cooking')).toEqual([]);
  });

  test('ticking a recipe and Add to dinner fills the slot and closes', () => {
    open(THURSDAY, 'dinner');
    press('Chicken tacos, 35 min · Added today');
    expect(slotNow(THURSDAY, 'dinner')).toEqual([]);
    expect(mockBack).not.toHaveBeenCalled();
    press('Add to dinner');
    expect(slotNow(THURSDAY, 'dinner').map((e) => [e.kind, e.recipeId, e.note])).toEqual([['recipe', tacos, null]]);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('Leftovers and Eating out fill the slot, replacing what was there (a past day too)', () => {
    setSlot(home, '2026-10-12', 'lunch', { kind: 'recipe', recipeId: tacos });
    open('2026-10-12', 'lunch');
    press('Leftovers');
    expect(slotNow('2026-10-12', 'lunch').map((e) => e.kind)).toEqual(['leftovers']);
    act(() => tree!.unmount());
    open('2026-10-12', 'lunch');
    press('Eating out');
    expect(slotNow('2026-10-12', 'lunch').map((e) => e.kind)).toEqual(['eating-out']);
    expect(mockBack).toHaveBeenCalledTimes(2);
  });

  test('Note… asks for the note and fills the slot with it, as typed', () => {
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    open(THURSDAY, 'lunch');
    press('Note…');
    expect(mockBack).not.toHaveBeenCalled();
    act(() => (prompt.mock.calls[0][2] as { text?: string; onPress?: (t?: string) => void }[])[1].onPress!(' Pizza at Gran’s '));
    expect(slotNow(THURSDAY, 'lunch').map((e) => [e.kind, e.note])).toEqual([['note', 'Pizza at Gran’s']]);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('a bad slot shows nothing', () => {
    open(THURSDAY, 'snack');
    expect(lines()).toEqual([]);
  });
});

describe('tapping slots on the week', () => {
  function render() {
    act(() => {
      tree = create(
        <SafeAreaProvider initialMetrics={METRICS}>
          <PlanScreen />
        </SafeAreaProvider>,
      );
    });
  }
  const slot = (day: string, meal: Meal) =>
    tree!.root.find((n) => n.props.testID === `slot-${day}-${meal}` && typeof n.props.onPress === 'function' && typeof n.type !== 'string');
  const tap = (day: string, meal: Meal) => act(() => slot(day, meal).props.onPress());
  function spySheet() {
    return jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
  }
  const pick = (sheet: ReturnType<typeof spySheet>, label: string) => {
    const [options, callback] = sheet.mock.calls[sheet.mock.calls.length - 1];
    act(() => callback(options.options.indexOf(label)));
  };

  test('an empty grid cell opens the slot sheet, past days too', () => {
    render();
    tap(THURSDAY, 'breakfast');
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/plan-slot', params: { householdId: home, day: THURSDAY, meal: 'breakfast' } });
    tap('2026-10-12', 'dinner');
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/plan-slot', params: { householdId: home, day: '2026-10-12', meal: 'dinner' } });
  });

  test('an agenda "+ Add" line opens the slot sheet', () => {
    setDeviceSetting(PLAN_VIEW_KEY, 'agenda');
    render();
    tap('2026-10-16', 'lunch');
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/plan-slot', params: { householdId: home, day: '2026-10-16', meal: 'lunch' } });
  });

  test('a slot with recipes (one or more) opens the meal sheet, with no menu', () => {
    setSlot(home, THURSDAY, 'dinner', { kind: 'recipe', recipeId: tacos });
    addRecipeToSlot(home, '2026-10-16', 'lunch', ensalada);
    addRecipeToSlot(home, '2026-10-16', 'lunch', tacos);
    const sheet = spySheet();
    render();
    tap(THURSDAY, 'dinner');
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/plan-meal', params: { householdId: home, day: THURSDAY, meal: 'dinner' } });
    tap('2026-10-16', 'lunch');
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/plan-meal', params: { householdId: home, day: '2026-10-16', meal: 'lunch' } });
    expect(sheet).not.toHaveBeenCalled();
  });

  test('a note’s menu: Replace… opens the slot sheet; Cancel does nothing', () => {
    setSlot(home, THURSDAY, 'dinner', { kind: 'eating-out' });
    const sheet = spySheet();
    render();
    tap(THURSDAY, 'dinner');
    expect(mockPush).not.toHaveBeenCalled();
    expect(sheet.mock.calls[0][0]).toEqual({
      title: 'Thursday dinner, Eating out',
      options: ['Replace…', 'Clear', 'Cancel'],
      destructiveButtonIndex: 1,
      cancelButtonIndex: 2,
    });
    pick(sheet, 'Replace…');
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/plan-slot',
      params: { householdId: home, day: THURSDAY, meal: 'dinner', mode: 'replace' },
    });
    tap(THURSDAY, 'dinner');
    pick(sheet, 'Cancel');
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(slotNow(THURSDAY, 'dinner').map((e) => e.kind)).toEqual(['eating-out']);
  });

  test('Leftovers and Eating out: Replace… and Clear', () => {
    setSlot(home, THURSDAY, 'lunch', { kind: 'leftovers' });
    setSlot(home, THURSDAY, 'dinner', { kind: 'eating-out' });
    const sheet = spySheet();
    render();
    tap(THURSDAY, 'lunch');
    tap(THURSDAY, 'dinner');
    expect(sheet.mock.calls.map(([o]) => o.options)).toEqual([
      ['Replace…', 'Clear', 'Cancel'],
      ['Replace…', 'Clear', 'Cancel'],
    ]);
  });

  test('a note: Edit note… asks with the note and saves the new one', () => {
    setSlot(home, THURSDAY, 'lunch', { kind: 'note', note: 'Pizza' });
    const sheet = spySheet();
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    render();
    tap(THURSDAY, 'lunch');
    expect(sheet.mock.calls[0][0].options).toEqual(['Replace…', 'Edit note…', 'Clear', 'Cancel']);
    pick(sheet, 'Edit note…');
    expect(prompt.mock.calls[0][4]).toBe('Pizza');
    act(() => (prompt.mock.calls[0][2] as { onPress?: (t?: string) => void }[])[1].onPress!('Pizza at Gran’s'));
    expect(slotNow(THURSDAY, 'lunch').map((e) => [e.kind, e.note])).toEqual([['note', 'Pizza at Gran’s']]);
  });

  test('Clear empties the slot with "Cleared Thursday dinner", and Undo puts the entry back', () => {
    const entry = setSlot(home, THURSDAY, 'dinner', { kind: 'leftovers' });
    const sheet = spySheet();
    render();
    tap(THURSDAY, 'dinner');
    pick(sheet, 'Clear');
    expect(slotNow(THURSDAY, 'dinner')).toEqual([]);
    expect(lines()).toContain('Cleared Thursday dinner');
    press('Undo');
    expect(slotNow(THURSDAY, 'dinner').map((e) => [e.id, e.kind])).toEqual([[entry.id, 'leftovers']]);
    expect(lines()).not.toContain('Cleared Thursday dinner');
  });

  test('Undo takes out what filled the slot since', () => {
    const entry = setSlot(home, THURSDAY, 'dinner', { kind: 'note', note: 'Pizza' });
    const sheet = spySheet();
    render();
    tap(THURSDAY, 'dinner');
    pick(sheet, 'Clear');
    setSlot(home, THURSDAY, 'dinner', { kind: 'leftovers' });
    press('Undo');
    expect(slotNow(THURSDAY, 'dinner').map((e) => [e.id, e.note])).toEqual([[entry.id, 'Pizza']]);
  });
});

describe('the meal sheet (board D)', () => {
  let weekToasts: (SlotToast | null)[];

  /** Thursday dinner: tacos, ensalada, then pancakes, opened from the week (which takes its toasts). */
  function fill() {
    addRecipeToSlot(home, THURSDAY, 'dinner', tacos);
    addRecipeToSlot(home, THURSDAY, 'dinner', ensalada);
    addRecipeToSlot(home, THURSDAY, 'dinner', pancakes);
  }
  function open(day = THURSDAY, meal: string = 'dinner') {
    weekToasts = [];
    if (meal === 'dinner' || meal === 'lunch' || meal === 'breakfast') openMealSheet(home, day, meal, (t) => weekToasts.push(t));
    mockPush.mockClear();
    Object.assign(mockParams, { householdId: home, day, meal });
    act(() => {
      tree = create(<PlanMealSheet />);
    });
  }
  /** The live query re-reads on render; a write that changes no state needs one. */
  const refresh = () => act(() => tree!.update(<PlanMealSheet />));
  const rows = () =>
    tree!.root
      .findAll((n) => typeof n.type !== 'string' && Array.isArray(n.props.accessibilityActions) && typeof n.props.onPress === 'function')
      .map((n) => n.props.accessibilityLabel as string);
  const names = () => slotNow(THURSDAY, 'dinner').map((e) => e.recipeName);
  const forEach = () => tree!.root.find((n) => n.type === ('SwiftForEach' as never));

  test('titled as the slot sheet, it lists the slot’s recipes in order with their time, and its buttons', () => {
    fill();
    open();
    expect(lines().slice(0, 2)).toEqual(['Thursday 15', 'Dinner']);
    expect(rows()).toEqual(['Chicken tacos, 35 min', 'Énsalada verde', 'Pancakes, 20 min']);
    for (const label of ['Remove Chicken tacos', 'Remove Énsalada verde', 'Remove Pancakes', 'Add a recipe', 'Replace all…', 'Clear dinner']) {
      expect(button(label)).toBeTruthy();
    }
    expect(lines()).toContain('Tap a recipe to open it. Drag to change the order they show in.');
    // Native drag handles, no delete control.
    const list = tree!.root.find((n) => n.type === ('SwiftList' as never));
    expect(list.props.modifiers).toContainEqual({ environment: ['editMode', 'active'] });
    const groups = tree!.root.findAll((n) => n.type === ('SwiftGroup' as never));
    expect(groups).toHaveLength(3);
    for (const g of groups) expect(g.props.modifiers).toContainEqual({ deleteDisabled: true });
  });

  test('the slot’s order, not A–Z, and a lunch says Clear lunch', () => {
    addRecipeToSlot(home, THURSDAY, 'lunch', pancakes);
    addRecipeToSlot(home, THURSDAY, 'lunch', tacos);
    open(THURSDAY, 'lunch');
    expect(rows()).toEqual(['Pancakes, 20 min', 'Chicken tacos, 35 min']);
    expect(button('Clear lunch')).toBeTruthy();
  });

  test('tapping a recipe closes the sheet and opens it', () => {
    fill();
    open();
    press('Énsalada verde');
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/recipe/[id]', params: { id: ensalada } });
  });

  test('remove takes one recipe out with "Removed Énsalada verde", and Undo puts it back in its place', () => {
    fill();
    open();
    press('Remove Énsalada verde');
    expect(names()).toEqual(['Chicken tacos', 'Pancakes']);
    expect(rows()).toEqual(['Chicken tacos, 35 min', 'Pancakes, 20 min']);
    expect(lines()).toContain('Removed Énsalada verde');
    expect(mockBack).not.toHaveBeenCalled();
    expect(weekToasts).toEqual([]);
    press('Undo');
    expect(names()).toEqual(['Chicken tacos', 'Énsalada verde', 'Pancakes']);
    expect(rows()).toEqual(['Chicken tacos, 35 min', 'Énsalada verde', 'Pancakes, 20 min']);
    expect(lines()).not.toContain('Removed Énsalada verde');
  });

  test('removing the last recipe closes the sheet with the week’s Cleared toast, and Undo puts it back', () => {
    const entry = addRecipeToSlot(home, THURSDAY, 'dinner', tacos)!;
    open();
    press('Remove Chicken tacos');
    expect(slotNow(THURSDAY, 'dinner')).toEqual([]);
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(lines()).not.toContain('Removed Chicken tacos');
    expect(weekToasts).toHaveLength(1);
    expect(weekToasts[0]!.message).toBe('Cleared Thursday dinner');
    act(() => weekToasts[0]!.actions.find((a) => a.label === 'Undo')!.onPress());
    expect(slotNow(THURSDAY, 'dinner').map((e) => [e.id, e.recipeId])).toEqual([[entry.id, tacos]]);
    expect(weekToasts[1]).toBeNull();
  });

  test('dragging reorders through moveEntry (onMove’s destination is the index to insert before)', () => {
    fill();
    open();
    act(() => forEach().props.onMove([0], 3)); // tacos to the end
    expect(names()).toEqual(['Énsalada verde', 'Pancakes', 'Chicken tacos']);
    refresh();
    expect(rows()).toEqual(['Énsalada verde', 'Pancakes, 20 min', 'Chicken tacos, 35 min']);
    act(() => forEach().props.onMove([2], 0)); // tacos back to the top
    expect(names()).toEqual(['Chicken tacos', 'Énsalada verde', 'Pancakes']);
    refresh();
    act(() => forEach().props.onMove([1], 2)); // dropped just below itself: no change
    expect(names()).toEqual(['Chicken tacos', 'Énsalada verde', 'Pancakes']);
  });

  test('VoiceOver: Move up and Move down, none past the ends', () => {
    fill();
    open();
    const row = (label: string) =>
      tree!.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && Array.isArray(n.props.accessibilityActions));
    const actionNames = (label: string) => (row(label).props.accessibilityActions as { label: string }[]).map((a) => a.label);
    expect(actionNames('Chicken tacos, 35 min')).toEqual(['Move down']);
    expect(actionNames('Énsalada verde')).toEqual(['Move up', 'Move down']);
    expect(actionNames('Pancakes, 20 min')).toEqual(['Move up']);
    act(() => row('Pancakes, 20 min').props.onAccessibilityAction({ nativeEvent: { actionName: 'moveUp' } }));
    expect(names()).toEqual(['Chicken tacos', 'Pancakes', 'Énsalada verde']);
    refresh();
    act(() => row('Chicken tacos, 35 min').props.onAccessibilityAction({ nativeEvent: { actionName: 'moveDown' } }));
    expect(names()).toEqual(['Pancakes', 'Chicken tacos', 'Énsalada verde']);
  });

  test('Add a recipe opens the slot sheet in add mode', () => {
    fill();
    open();
    press('Add a recipe');
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/plan-slot',
      params: { householdId: home, day: THURSDAY, meal: 'dinner', mode: 'add' },
    });
  });

  test('Replace all… puts the slot sheet in its place', () => {
    fill();
    open();
    press('Replace all…');
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/plan-slot',
      params: { householdId: home, day: THURSDAY, meal: 'dinner', mode: 'replace' },
    });
    expect(names()).toEqual(['Chicken tacos', 'Énsalada verde', 'Pancakes']);
  });

  test('Clear dinner closes the sheet with "Cleared Thursday dinner", and Undo puts every recipe back', () => {
    fill();
    const before = slotNow(THURSDAY, 'dinner').map((e) => e.id);
    open();
    press('Clear dinner');
    expect(slotNow(THURSDAY, 'dinner')).toEqual([]);
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(weekToasts.map((t) => t?.message)).toEqual(['Cleared Thursday dinner']);
    act(() => weekToasts[0]!.actions[0].onPress());
    expect(slotNow(THURSDAY, 'dinner').map((e) => e.id)).toEqual(before);
    expect(weekToasts[1]).toBeNull();
  });

  test('a bad slot shows nothing', () => {
    open(THURSDAY, 'snack');
    expect(lines()).toEqual([]);
  });

  test('in Spanish', () => {
    fill();
    act(() => void i18n.changeLanguage('es'));
    try {
      open();
      expect(button('Quitar Chicken tacos')).toBeTruthy();
      expect(button('Agregar una receta')).toBeTruthy();
      expect(button('Reemplazar todo…')).toBeTruthy();
      expect(button('Quitar la cena')).toBeTruthy();
      expect(lines()).toContain('Toca una receta para abrirla. Arrástrala para cambiar el orden.');
      press('Quitar Pancakes');
      expect(lines()).toContain('Quitaste Pancakes');
    } finally {
      act(() => void i18n.changeLanguage('en'));
    }
  });
});

describe('the add sheet (board E)', () => {
  function open(meal = 'dinner') {
    Object.assign(mockParams, { householdId: home, day: THURSDAY, meal, mode: 'add' });
    act(() => {
      tree = create(
        <SafeAreaProvider initialMetrics={METRICS}>
          <PlanSlotSheet />
        </SafeAreaProvider>,
      );
    });
  }
  const row = (id: string) =>
    tree!.root.find((n) => typeof n.type !== 'string' && n.props.testID === `slot-recipe-${id}` && typeof n.props.onPress === 'function');

  test('"Add to dinner" under "Thursday 15 · Dinner", the slot’s recipes named, the chips, and no Not cooking? bar', () => {
    addRecipeToSlot(home, THURSDAY, 'dinner', ensalada);
    addRecipeToSlot(home, THURSDAY, 'dinner', pancakes);
    open();
    expect(lines().slice(0, 3)).toEqual(['Thursday 15 · Dinner', 'Add to dinner', 'With Énsalada verde, Pancakes']);
    const line = tree!.root.find((n) => n.props.testID === 'slot-with' && typeof n.type === 'string');
    expect(line.findAll((n) => n.type === ('Text' as never))[0].props.numberOfLines).toBe(1);
    for (const label of ['Not cooking?', 'Leftovers', 'Eating out', 'Note…']) expect(lines()).not.toContain(label);
    expect(tree!.root.findAll((n) => n.props.testID === 'not-cooking')).toEqual([]);
    for (const chip of ['Filters', 'Dinner', 'Favorites', 'Want to try']) expect(button(chip)).toBeTruthy();
    expect(lines()).not.toContain('Show all recipes');
  });

  test('the meal chip narrows the add sheet too, keeping the slot’s recipes ticked', () => {
    addRecipeToSlot(home, THURSDAY, 'dinner', tacos);
    open();
    expect(recipeRows()).toEqual([
      'Chicken tacos, Already in dinner',
      'Énsalada verde, Added today',
      'Jalapeño poppers, Added today',
      'Pancakes, 20 min · Added today',
    ]);
    act(() => button('Dinner').props.onPress());
    expect(recipeRows()).toEqual(['Chicken tacos, Already in dinner', 'Énsalada verde, Added today']);
    expect(row(tacos).props.disabled).toBe(true);
  });

  test('the slot’s recipes are ticked, disabled and captioned "Already in dinner"', () => {
    addRecipeToSlot(home, THURSDAY, 'dinner', ensalada);
    open();
    expect(recipeRows()).toEqual([
      'Chicken tacos, 35 min · Added today',
      'Énsalada verde, Already in dinner',
      'Jalapeño poppers, Added today',
      'Pancakes, 20 min · Added today',
    ]);
    expect(row(ensalada).props.disabled).toBe(true);
    expect(row(ensalada).props.accessibilityState).toEqual({ disabled: true, checked: true });
    expect(row(ensalada).findAll((n) => n.type === ('Icon' as never)).map((n) => n.props.name)).toEqual(['checkmark']);
    expect(row(tacos).props.disabled).toBe(false);
    expect(row(tacos).findAll((n) => n.type === ('Icon' as never))).toEqual([]);
  });

  test('ticking and Add to dinner adds the recipe last, keeping the others, and goes back to the meal sheet', () => {
    addRecipeToSlot(home, THURSDAY, 'dinner', ensalada);
    addRecipeToSlot(home, THURSDAY, 'dinner', pancakes);
    open();
    press('Chicken tacos, 35 min · Added today');
    press('Add to dinner');
    expect(slotNow(THURSDAY, 'dinner').map((e) => e.recipeName)).toEqual(['Énsalada verde', 'Pancakes', 'Chicken tacos']);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('an untagged recipe can be added from the full list', () => {
    addRecipeToSlot(home, THURSDAY, 'dinner', tacos);
    open();
    press('Jalapeño poppers, Added today');
    press('Add to dinner');
    expect(slotNow(THURSDAY, 'dinner').map((e) => e.recipeName)).toEqual(['Chicken tacos', 'Jalapeño poppers']);
  });

  test('in replace mode the slot sheet replaces (Replace all…)', () => {
    addRecipeToSlot(home, THURSDAY, 'dinner', ensalada);
    addRecipeToSlot(home, THURSDAY, 'dinner', pancakes);
    Object.assign(mockParams, { householdId: home, day: THURSDAY, meal: 'dinner', mode: 'replace' });
    act(() => {
      tree = create(
        <SafeAreaProvider initialMetrics={METRICS}>
          <PlanSlotSheet />
        </SafeAreaProvider>,
      );
    });
    expect(lines().slice(0, 2)).toEqual(['Thursday 15', 'Dinner']);
    expect(recipeRows()).toEqual([
      'Chicken tacos, 35 min · Added today',
      'Énsalada verde, Added today',
      'Jalapeño poppers, Added today',
      'Pancakes, 20 min · Added today',
    ]);
    press('Chicken tacos, 35 min · Added today');
    press('Replace dinner');
    expect(slotNow(THURSDAY, 'dinner').map((e) => e.recipeName)).toEqual(['Chicken tacos']);
  });

  test('in Spanish the meal’s gender is kept', () => {
    addRecipeToSlot(home, THURSDAY, 'lunch', ensalada);
    act(() => void i18n.changeLanguage('es'));
    try {
      open('lunch');
      expect(lines().slice(0, 3)).toEqual(['jueves 15 · Almuerzo', 'Agregar al almuerzo', 'Con Énsalada verde']);
      expect(recipeRows()).toContain('Énsalada verde, Ya está en el almuerzo');
      act(() => tree!.unmount());
      tree = null;
      open('dinner');
      expect(lines()[1]).toBe('Agregar a la cena');
    } finally {
      act(() => void i18n.changeLanguage('en'));
    }
  });
});

describe('picking several recipes (spec 4.16 Picking recipes)', () => {
  let toasts: (SlotToast | null)[];

  /** The slot sheet as the week opens it (`openSlotSheet`, which takes its toasts), or the add sheet from the meal sheet. */
  function open(meal: Meal = 'dinner', mode?: 'add' | 'replace') {
    toasts = [];
    if (mode === 'add') openAddSheet(home, THURSDAY, meal, (t) => toasts.push(t));
    else openSlotSheet(home, THURSDAY, meal, (t) => toasts.push(t), { replace: mode === 'replace' });
    Object.assign(mockParams, { householdId: home, day: THURSDAY, meal, ...(mode ? { mode } : {}) });
    act(() => {
      tree = create(
        <SafeAreaProvider initialMetrics={METRICS}>
          <PlanSlotSheet />
        </SafeAreaProvider>,
      );
    });
  }
  const row = (id: string) =>
    tree!.root.find((n) => typeof n.type !== 'string' && n.props.testID === `slot-recipe-${id}` && typeof n.props.onPress === 'function');
  const tick = (id: string) => act(() => row(id).props.onPress());
  const rowStyle = (id: string) => StyleSheet.flatten(row(id).props.style({ pressed: false }));
  const rowIcons = (id: string) => row(id).findAll((n) => n.type === ('Icon' as never)).map((n) => n.props.name);
  const bar = (testID: 'add-bar' | 'not-cooking') => tree!.root.findAll((n) => n.props.testID === testID && typeof n.type === 'string');
  /** The add bar's chips, in order, by their ✕'s VoiceOver label. */
  const chips = () =>
    bar('add-bar')[0]
      .findAll((n) => typeof n.type !== 'string' && /^(Remove|Quitar) /.test(n.props.accessibilityLabel ?? '') && typeof n.props.onPress === 'function')
      .map((n) => n.props.accessibilityLabel as string);
  /** The add bar's primary button: its label and VoiceOver label. */
  const cta = () => {
    const [b] = bar('add-bar')[0].findAll(
      (n) =>
        typeof n.type !== 'string' &&
        typeof n.props.onPress === 'function' &&
        n.props.accessibilityRole === 'button' &&
        !/^(Remove|Quitar) |^(Clear|Borrar)$/.test(n.props.accessibilityLabel),
    );
    return [textOf(b.findAll((n) => n.type === ('Text' as never))[0]), b.props.accessibilityLabel as string];
  };
  const search = (text: string) =>
    act(() => tree!.root.find((n) => n.type === ('TextInput' as never) && n.props.accessibilityLabel === 'Search recipes').props.onChangeText(text));
  const names = () => slotNow(THURSDAY, 'dinner').map((e) => e.recipeName);

  test('tapping a row ticks it (primarySoft, a filled circle, "selected") and tapping again unticks it', () => {
    open();
    expect(rowIcons(tacos)).toEqual([]);
    expect(rowStyle(tacos).backgroundColor).toBeUndefined();
    tick(tacos);
    expect(row(tacos).props.accessibilityLabel).toBe('Chicken tacos, selected, 35 min · Added today');
    expect(rowStyle(tacos).backgroundColor).toBe(Palette.light.primarySoft);
    expect(rowIcons(tacos)).toEqual(['checkmark']);
    expect(row(tacos).findAll((n) => n.type === ('Icon' as never))[0].props.color).toBe('onPrimary');
    expect(lines()).toContain('1 selected · All recipes');
    expect(slotNow(THURSDAY, 'dinner')).toEqual([]); // nothing written yet
    expect(mockBack).not.toHaveBeenCalled();

    tick(tacos);
    expect(row(tacos).props.accessibilityLabel).toBe('Chicken tacos, 35 min · Added today');
    expect(rowIcons(tacos)).toEqual([]);
    expect(lines()).toContain('All recipes');
    expect(lines().some((l) => l.includes('selected'))).toBe(false);
  });

  test('any number can be ticked; the add bar takes the Not cooking? bar’s place, its chips in the order ticked', () => {
    open();
    expect(bar('not-cooking')).toHaveLength(1);
    expect(bar('add-bar')).toEqual([]);
    tick(pancakes);
    expect(bar('not-cooking')).toEqual([]);
    expect(bar('add-bar')).toHaveLength(1);
    tick(tacos);
    tick(ensalada);
    const jalapeno = recipesQuery().all().find((r) => r.name === 'Jalapeño poppers')!.id;
    tick(jalapeno);
    expect(chips()).toEqual(['Remove Pancakes', 'Remove Chicken tacos', 'Remove Énsalada verde', 'Remove Jalapeño poppers']);
    expect(lines()).toContain('4 selected · All recipes');
    expect(bar('add-bar')[0].findAll((n) => n.type === ('Text' as never)).map(textOf).slice(0, 4)).toEqual([
      'Pancakes',
      'Chicken tacos',
      'Énsalada verde',
      'Jalapeño poppers',
    ]);
    expect(cta()).toEqual(['Add 4 to dinner', 'Add 4 recipes to dinner']);
  });

  test('ticks survive a search, chips, the filter panel and the sort, and the count joins the narrowed line', () => {
    open();
    tick(tacos);
    search('pan');
    expect(recipeRows()).toEqual(['Pancakes, 20 min · Added today']);
    expect(lines()).toContain('1 selected · 1 recipe');
    tick(pancakes);
    search('');
    expect(row(tacos).props.accessibilityLabel).toBe('Chicken tacos, selected, 35 min · Added today');
    expect(row(pancakes).props.accessibilityLabel).toBe('Pancakes, selected, 20 min · Added today');
    press('Dinner');
    expect(lines()).toContain('2 selected · 2 recipes');
    expect(chips()).toEqual(['Remove Chicken tacos', 'Remove Pancakes']); // Pancakes is filtered away but still ticked
    press('Filters, 1 active');
    press('Under 1 hour');
    act(() =>
      tree!.root
        .find((n) => typeof n.type !== 'string' && /^Show \d+ recipes?$/.test(n.props.label ?? '') && typeof n.props.onPress === 'function')
        .props.onPress(),
    );
    act(() => tree!.root.find((n) => n.type === ('SwiftToggle' as never) && n.props.label === 'A–Z').props.onIsOnChange(true));
    expect(chips()).toEqual(['Remove Chicken tacos', 'Remove Pancakes']);
    press('Clear filters');
    expect(lines()).toContain('2 selected · All recipes');
  });

  test('a chip’s ✕ unticks it; Clear unticks everything, and the Not cooking? bar comes back', () => {
    open();
    tick(tacos);
    tick(ensalada);
    tick(pancakes);
    press('Remove Énsalada verde');
    expect(chips()).toEqual(['Remove Chicken tacos', 'Remove Pancakes']);
    expect(row(ensalada).props.accessibilityLabel).toBe('Énsalada verde, Added today');
    expect(cta()).toEqual(['Add 2 to dinner', 'Add 2 recipes to dinner']);
    press('Clear');
    expect(bar('add-bar')).toEqual([]);
    expect(bar('not-cooking')).toHaveLength(1);
    expect(lines()).toContain('All recipes');
    // Unticking the last one by hand brings it back too.
    tick(tacos);
    expect(cta()).toEqual(['Add to dinner', 'Add to dinner']);
    press('Remove Chicken tacos');
    expect(bar('not-cooking')).toHaveLength(1);
    // Leftovers still fills the slot at once.
    press('Leftovers');
    expect(slotNow(THURSDAY, 'dinner').map((e) => e.kind)).toEqual(['leftovers']);
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([]);
  });

  test('Add 3 to dinner writes once, in the order ticked, closes, and toasts "Added 3 recipes to Thu dinner"; Undo empties it', () => {
    open();
    tick(pancakes);
    tick(tacos);
    tick(ensalada);
    press('Add 3 recipes to dinner');
    expect(names()).toEqual(['Pancakes', 'Chicken tacos', 'Énsalada verde']);
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(toasts.map((t) => t?.message)).toEqual(['Added 3 recipes to Thu dinner']);
    expect(toasts[0]!.emphasis).toBeUndefined();
    act(() => toasts[0]!.actions.find((a) => a.label === 'Undo')!.onPress());
    expect(slotNow(THURSDAY, 'dinner')).toEqual([]);
    expect(toasts[1]).toBeNull();
  });

  test('one recipe: "Added Chicken tacos to Thu dinner", and Undo puts back the note it took out', () => {
    const note = setSlot(home, THURSDAY, 'dinner', { kind: 'note', note: 'Pizza' });
    open(); // a slot filled since the sheet opened: the button still adds
    tick(tacos);
    press('Add to dinner');
    expect(slotNow(THURSDAY, 'dinner').map((e) => [e.kind, e.recipeId])).toEqual([['recipe', tacos]]);
    expect(toasts[0]).toMatchObject({ message: 'Added Chicken tacos to Thu dinner', emphasis: 'Chicken tacos' });
    act(() => toasts[0]!.actions[0].onPress());
    expect(slotNow(THURSDAY, 'dinner').map((e) => [e.id, e.note])).toEqual([[note.id, 'Pizza']]);
  });

  test('opened to replace: Replace dinner / Replace with 3 replaces everything, "Replaced Thu dinner", and Undo puts it back', () => {
    addRecipeToSlot(home, THURSDAY, 'dinner', tacos);
    addRecipeToSlot(home, THURSDAY, 'dinner', ensalada);
    const before = slotNow(THURSDAY, 'dinner').map((e) => e.id);
    open('dinner', 'replace');
    expect(lines().slice(0, 2)).toEqual(['Thursday 15', 'Dinner']);
    tick(pancakes);
    expect(cta()).toEqual(['Replace dinner', 'Replace dinner']);
    tick(tacos);
    const jalapeno = recipesQuery().all().find((r) => r.name === 'Jalapeño poppers')!.id;
    tick(jalapeno);
    expect(cta()).toEqual(['Replace with 3', 'Replace dinner with 3 recipes']);
    press('Replace dinner with 3 recipes');
    expect(names()).toEqual(['Pancakes', 'Chicken tacos', 'Jalapeño poppers']);
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(toasts.map((t) => t?.message)).toEqual(['Replaced Thu dinner']);
    act(() => toasts[0]!.actions[0].onPress());
    expect(slotNow(THURSDAY, 'dinner').map((e) => e.id)).toEqual(before);
    expect(names()).toEqual(['Chicken tacos', 'Énsalada verde']);
  });

  test('the add sheet: no bar until something’s ticked, its slot rows disabled and never counted', () => {
    addRecipeToSlot(home, THURSDAY, 'dinner', ensalada);
    open('dinner', 'add');
    expect(bar('add-bar')).toEqual([]);
    expect(bar('not-cooking')).toEqual([]);
    expect(rowIcons(ensalada)).toEqual(['checkmark']);
    const check = row(ensalada).findAll((n) => n.type === ('Icon' as never))[0];
    expect(check.props.color).toBe('inkSecondary');
    const circle = (id: string) =>
      row(id).find((n) => {
        const style = typeof n.type === 'string' ? StyleSheet.flatten(n.props.style) : undefined;
        return style?.width === Sizes.slotTick && style.borderWidth !== undefined;
      });
    expect(StyleSheet.flatten(circle(ensalada).props.style)).toMatchObject({ height: 26, borderWidth: 0, backgroundColor: Palette.light.surfaceMuted });
    expect(StyleSheet.flatten(circle(tacos).props.style)).toMatchObject({ borderWidth: 2, borderColor: Palette.light.controlBorder, backgroundColor: 'transparent' });
    tick(pancakes);
    expect(StyleSheet.flatten(circle(pancakes).props.style)).toMatchObject({ borderWidth: 0, backgroundColor: Palette.light.primary });
    tick(pancakes);
    expect(rowStyle(ensalada).opacity).toBeLessThan(1);
    expect(row(ensalada).props.disabled).toBe(true);
    tick(tacos);
    tick(pancakes);
    expect(lines()).toContain('2 selected · All recipes');
    expect(chips()).toEqual(['Remove Chicken tacos', 'Remove Pancakes']);
    expect(cta()).toEqual(['Add 2 to dinner', 'Add 2 recipes to dinner']);
    press('Clear');
    expect(bar('add-bar')).toEqual([]);
    expect(bar('not-cooking')).toEqual([]);
  });

  test('the add sheet’s Add 2 to dinner adds them last and goes back with "Added 2 recipes to dinner"; Undo takes them out', () => {
    const kept = addRecipeToSlot(home, THURSDAY, 'dinner', ensalada)!;
    open('dinner', 'add');
    tick(pancakes);
    tick(tacos);
    press('Add 2 recipes to dinner');
    expect(names()).toEqual(['Énsalada verde', 'Pancakes', 'Chicken tacos']);
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(toasts.map((t) => t?.message)).toEqual(['Added 2 recipes to dinner']);
    act(() => toasts[0]!.actions[0].onPress());
    expect(slotNow(THURSDAY, 'dinner').map((e) => e.id)).toEqual([kept.id]);
    expect(toasts[1]).toBeNull();
  });

  test('the add sheet with one: "Added Pancakes to lunch"', () => {
    addRecipeToSlot(home, THURSDAY, 'lunch', ensalada);
    open('lunch', 'add');
    tick(pancakes);
    expect(cta()).toEqual(['Add to lunch', 'Add to lunch']);
    press('Add to lunch');
    expect(toasts[0]).toMatchObject({ message: 'Added Pancakes to lunch', emphasis: 'Pancakes' });
  });

  test('the meal sheet shows the add sheet’s toast, and its Undo', () => {
    addRecipeToSlot(home, THURSDAY, 'dinner', ensalada);
    openMealSheet(home, THURSDAY, 'dinner', () => {});
    Object.assign(mockParams, { householdId: home, day: THURSDAY, meal: 'dinner' });
    act(() => {
      tree = create(<PlanMealSheet />);
    });
    press('Add a recipe');
    // The add sheet in a second renderer, as it opens over the meal sheet.
    Object.assign(mockParams, { mode: 'add' });
    let sheet: ReactTestRenderer;
    act(() => {
      sheet = create(
        <SafeAreaProvider initialMetrics={METRICS}>
          <PlanSlotSheet />
        </SafeAreaProvider>,
      );
    });
    const sheetRow = (id: string) =>
      sheet.root.find((n) => typeof n.type !== 'string' && n.props.testID === `slot-recipe-${id}` && typeof n.props.onPress === 'function');
    act(() => sheetRow(tacos).props.onPress());
    act(() => sheetRow(pancakes).props.onPress());
    act(() =>
      sheet.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === 'Add 2 recipes to dinner' && typeof n.props.onPress === 'function').props.onPress(),
    );
    act(() => sheet.unmount());
    expect(lines()).toContain('Added 2 recipes to dinner');
    press('Undo');
    expect(names()).toEqual(['Énsalada verde']);
    expect(lines()).not.toContain('Added 2 recipes to dinner');
  });

  test('the week shows the slot sheet’s toast from an empty slot, and its Undo', () => {
    act(() => {
      tree = create(
        <SafeAreaProvider initialMetrics={METRICS}>
          <PlanScreen />
        </SafeAreaProvider>,
      );
    });
    act(() =>
      tree!.root.find((n) => n.props.testID === `slot-${THURSDAY}-dinner` && typeof n.props.onPress === 'function' && typeof n.type !== 'string').props.onPress(),
    );
    Object.assign(mockParams, { householdId: home, day: THURSDAY, meal: 'dinner' });
    let sheet: ReactTestRenderer;
    act(() => {
      sheet = create(
        <SafeAreaProvider initialMetrics={METRICS}>
          <PlanSlotSheet />
        </SafeAreaProvider>,
      );
    });
    act(() => sheet.root.find((n) => typeof n.type !== 'string' && n.props.testID === `slot-recipe-${tacos}` && typeof n.props.onPress === 'function').props.onPress());
    act(() => sheet.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === 'Add to dinner' && typeof n.props.onPress === 'function').props.onPress());
    act(() => sheet.unmount());
    expect(names()).toEqual(['Chicken tacos']);
    expect(lines()).toContain('Added Chicken tacos to Thu dinner');
    press('Undo');
    expect(slotNow(THURSDAY, 'dinner')).toEqual([]);
  });

  test('in Spanish', () => {
    act(() => void i18n.changeLanguage('es'));
    try {
      open();
      tick(tacos);
      expect(row(tacos).props.accessibilityLabel).toBe('Chicken tacos, seleccionada, 35 min · Agregada hoy');
      expect(cta()).toEqual(['Agregar a la cena', 'Agregar a la cena']);
      tick(pancakes);
      expect(lines()).toContain('2 seleccionadas · Todas las recetas');
      expect(cta()).toEqual(['Agregar 2 a la cena', 'Agregar 2 recetas a la cena']);
      expect(chips()).toEqual(['Quitar Chicken tacos', 'Quitar Pancakes']);
      press('Agregar 2 recetas a la cena');
      expect(toasts[0]!.message).toBe('Agregaste 2 recetas a cena del jue');
    } finally {
      act(() => void i18n.changeLanguage('en'));
    }
  });
});
