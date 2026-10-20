// Filling and clearing slots from the week (spec 4.16, board 2 F): the slot sheet, a filled slot's menu,
// the note prompt, and Clear with Undo, against the in-memory database on Thursday, October 15, 2026.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { ActionSheetIOS, Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, households, recipes } from '@/db';
import { ensureStarterData, getDefaultListId, getList } from '@/features/lists/lists';
import { createRecipe } from '@/features/recipes/recipes';
import { setDeviceSetting, PLAN_VIEW_KEY } from '@/features/settings/device-settings';
import { emptyRecipeTags, type RecipeTags } from '@/shared/recipe-tags';
import { resetDb } from '@/test/db';

import PlanScreen from '@/app/(tabs)/plan/index';
import PlanMealSheet from '@/app/plan-meal';
import PlanSlotSheet from '@/app/plan-slot';
import { i18n } from '@/i18n';

import { groupWeek, weekEntriesQuery } from '../queries';
import { openMealSheet, promptNote, type SlotToast, slotMenuActions, slotSheetRecipes } from '../slot-actions';
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
  const all = () => [
    { id: 't', name: 'Chicken tacos', householdId: 'h', tags: { ...emptyRecipeTags(), meal: ['dinner'] } },
    { id: 'e', name: 'Énsalada verde', householdId: 'h', tags: { ...emptyRecipeTags(), meal: ['lunch', 'dinner'] } },
    { id: 'a', name: 'apple crumble', householdId: 'h', tags: { ...emptyRecipeTags(), meal: ['dinner'] } },
    { id: 'j', name: 'Jalapeño poppers', householdId: 'h', tags: null },
    { id: 'x', name: 'Beach chili', householdId: 'other', tags: { ...emptyRecipeTags(), meal: ['dinner'] } },
  ];
  const ids = (r: { id: string }[]) => r.map((x) => x.id);

  test("the household's recipes with the meal tag, A–Z ignoring case and accents", () => {
    expect(ids(slotSheetRecipes(all(), { householdId: 'h', meal: 'dinner', query: '', showAll: false }, 'en'))).toEqual(['a', 't', 'e']);
    expect(ids(slotSheetRecipes(all(), { householdId: 'h', meal: 'lunch', query: '', showAll: false }, 'en'))).toEqual(['e']);
    expect(ids(slotSheetRecipes(all(), { householdId: 'h', meal: 'breakfast', query: '', showAll: false }, 'en'))).toEqual([]);
  });

  test('Show all drops the meal filter, but never shows another household', () => {
    expect(ids(slotSheetRecipes(all(), { householdId: 'h', meal: 'breakfast', query: '', showAll: true }, 'en'))).toEqual([
      'a',
      't',
      'e',
      'j',
    ]);
  });

  test('search looks through all the household’s recipes by name, ignoring case and accents', () => {
    const search = (query: string) => ids(slotSheetRecipes(all(), { householdId: 'h', meal: 'breakfast', query, showAll: false }, 'en'));
    expect(search('JALAPENO')).toEqual(['j']);
    expect(search('ensalada')).toEqual(['e']);
    expect(search('p')).toEqual(['a', 'j']);
    expect(search('A')).toEqual(['a', 't', 'e', 'j']);
    expect(search('chili')).toEqual([]);
    expect(search('  ')).toEqual([]); // blank: the meal filter still applies
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
      tree = create(<PlanSlotSheet />);
    });
  }

  test('titled with the day over the meal, with the pills and the meal’s recipes A–Z with their time', () => {
    open(THURSDAY, 'dinner');
    expect(lines().slice(0, 2)).toEqual(['Thursday 15', 'Dinner']);
    for (const pill of ['Leftovers', 'Eating out', 'Note…', 'Show all recipes']) expect(button(pill)).toBeTruthy();
    expect(recipeRows()).toEqual(['Chicken tacos, 35 min', 'Énsalada verde']);
  });

  test('Show all recipes lists every recipe of the household, and goes', () => {
    open(THURSDAY, 'breakfast');
    expect(recipeRows()).toEqual(['Pancakes, 20 min']);
    press('Show all recipes');
    expect(recipeRows()).toEqual(['Chicken tacos, 35 min', 'Énsalada verde', 'Jalapeño poppers', 'Pancakes, 20 min']);
    expect(lines()).not.toContain('Show all recipes');
  });

  test('search matches names across all recipes, ignoring case and accents', () => {
    open(THURSDAY, 'breakfast');
    const field = tree!.root.find((n) => n.type === ('TextInput' as never) && n.props.accessibilityLabel === 'Search recipes');
    act(() => field.props.onChangeText('JALAPENO'));
    expect(recipeRows()).toEqual(['Jalapeño poppers']);
    act(() => field.props.onChangeText('chili'));
    expect(recipeRows()).toEqual([]);
    expect(lines()).toContain('No recipes match');
  });

  test('with no recipes tagged with the meal it says so, with Show all', () => {
    tag(pancakes, []);
    open(THURSDAY, 'breakfast');
    expect(recipeRows()).toEqual([]);
    expect(lines()).toContain('No recipes tagged Breakfast yet');
    expect(button('Show all recipes')).toBeTruthy();
  });

  test('picking a recipe fills the slot and closes', () => {
    open(THURSDAY, 'dinner');
    press('Chicken tacos, 35 min');
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
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/plan-slot', params: { householdId: home, day: THURSDAY, meal: 'dinner' } });
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
    expect(mockReplace).toHaveBeenCalledWith({ pathname: '/plan-slot', params: { householdId: home, day: THURSDAY, meal: 'dinner' } });
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
      tree = create(<PlanSlotSheet />);
    });
  }
  const row = (id: string) =>
    tree!.root.find((n) => typeof n.type !== 'string' && n.props.testID === `slot-recipe-${id}` && typeof n.props.onPress === 'function');

  test('"Add to dinner" under "Thursday 15 · Dinner", the slot’s recipes named, and no pills', () => {
    addRecipeToSlot(home, THURSDAY, 'dinner', ensalada);
    addRecipeToSlot(home, THURSDAY, 'dinner', pancakes);
    open();
    expect(lines().slice(0, 3)).toEqual(['Thursday 15 · Dinner', 'Add to dinner', 'With Énsalada verde, Pancakes']);
    const line = tree!.root.find((n) => n.props.testID === 'slot-with' && typeof n.type === 'string');
    expect(line.findAll((n) => n.type === ('Text' as never))[0].props.numberOfLines).toBe(1);
    for (const pill of ['Leftovers', 'Eating out', 'Note…']) expect(lines()).not.toContain(pill);
    expect(button('Show all recipes')).toBeTruthy();
  });

  test('the slot’s recipes are ticked, disabled and captioned "Already in dinner"', () => {
    addRecipeToSlot(home, THURSDAY, 'dinner', ensalada);
    open();
    expect(recipeRows()).toEqual(['Chicken tacos, 35 min', 'Énsalada verde, Already in dinner']);
    expect(row(ensalada).props.disabled).toBe(true);
    expect(row(ensalada).props.accessibilityState).toEqual({ disabled: true, checked: true });
    expect(row(ensalada).findAll((n) => n.type === ('Icon' as never)).map((n) => n.props.name)).toEqual(['checkmark']);
    expect(row(tacos).props.disabled).toBe(false);
    expect(row(tacos).findAll((n) => n.type === ('Icon' as never))).toEqual([]);
  });

  test('picking adds the recipe last, keeping the others, and goes back to the meal sheet', () => {
    addRecipeToSlot(home, THURSDAY, 'dinner', ensalada);
    addRecipeToSlot(home, THURSDAY, 'dinner', pancakes);
    open();
    press('Chicken tacos, 35 min');
    expect(slotNow(THURSDAY, 'dinner').map((e) => e.recipeName)).toEqual(['Énsalada verde', 'Pancakes', 'Chicken tacos']);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('Show all recipes there ticks the slot’s recipes too, and adds from all of them', () => {
    addRecipeToSlot(home, THURSDAY, 'dinner', tacos);
    open();
    press('Show all recipes');
    expect(recipeRows()).toEqual(['Chicken tacos, Already in dinner', 'Énsalada verde', 'Jalapeño poppers', 'Pancakes, 20 min']);
    press('Jalapeño poppers');
    expect(slotNow(THURSDAY, 'dinner').map((e) => e.recipeName)).toEqual(['Chicken tacos', 'Jalapeño poppers']);
  });

  test('without add mode the slot sheet still replaces (Replace all…)', () => {
    addRecipeToSlot(home, THURSDAY, 'dinner', ensalada);
    addRecipeToSlot(home, THURSDAY, 'dinner', pancakes);
    Object.assign(mockParams, { householdId: home, day: THURSDAY, meal: 'dinner' });
    act(() => {
      tree = create(<PlanSlotSheet />);
    });
    expect(lines().slice(0, 2)).toEqual(['Thursday 15', 'Dinner']);
    expect(recipeRows()).toEqual(['Chicken tacos, 35 min', 'Énsalada verde']);
    press('Chicken tacos, 35 min');
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
