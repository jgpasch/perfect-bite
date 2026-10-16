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
import PlanSlotSheet from '@/app/plan-slot';

import { groupWeek, weekEntriesQuery } from '../queries';
import { promptNote, slotMenuActions, slotSheetRecipes } from '../slot-actions';
import type { Meal } from '../week';
import { setSlot } from '../write';

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
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
const mockParams: { householdId?: string; day?: string; meal?: string } = {};
const mockPush = jest.fn();
const mockBack = jest.fn();
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
    router: { push: (...args: unknown[]) => mockPush(...args), back: () => mockBack(), navigate: () => {} },
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
  test('each kind gets its items', () => {
    expect(slotMenuActions('recipe')).toEqual(['open', 'replace', 'clear']);
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

  test('a recipe’s menu: Open recipe, Replace…, Clear', () => {
    setSlot(home, THURSDAY, 'dinner', { kind: 'recipe', recipeId: tacos });
    const sheet = spySheet();
    render();
    tap(THURSDAY, 'dinner');
    expect(mockPush).not.toHaveBeenCalled();
    expect(sheet.mock.calls[0][0]).toEqual({
      title: 'Thursday dinner, Chicken tacos',
      options: ['Open recipe', 'Replace…', 'Clear', 'Cancel'],
      destructiveButtonIndex: 2,
      cancelButtonIndex: 3,
    });
    pick(sheet, 'Open recipe');
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/recipe/[id]', params: { id: tacos } });
    tap(THURSDAY, 'dinner');
    pick(sheet, 'Replace…');
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/plan-slot', params: { householdId: home, day: THURSDAY, meal: 'dinner' } });
    tap(THURSDAY, 'dinner');
    pick(sheet, 'Cancel');
    expect(mockPush).toHaveBeenCalledTimes(2);
    expect(slotNow(THURSDAY, 'dinner')).toHaveLength(1);
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
    const entry = setSlot(home, THURSDAY, 'dinner', { kind: 'recipe', recipeId: tacos });
    const sheet = spySheet();
    render();
    tap(THURSDAY, 'dinner');
    pick(sheet, 'Clear');
    expect(slotNow(THURSDAY, 'dinner')).toEqual([]);
    expect(lines()).toContain('Cleared Thursday dinner');
    press('Undo');
    expect(slotNow(THURSDAY, 'dinner').map((e) => [e.id, e.kind, e.recipeId])).toEqual([[entry.id, 'recipe', tacos]]);
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
