// Planning a recipe (spec 4.16, the "Plan → tap a slot" prototype): the plan modal's taps kept in its
// state, Done and Cancel, and the recipe screen's plan badges, against the in-memory database on
// Thursday, October 15, 2026 (this week is Oct 11 – 17).
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { StyleSheet } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AisleColors, MealHues, Palette } from '@/constants/theme';
import { db, recipes } from '@/db';
import { recipeHue } from '@/domain/aisle-color';
import { ensureStarterData, getDefaultListId, getList } from '@/features/lists/lists';
import { createRecipe, deleteRecipe } from '@/features/recipes/recipes';
import { emptyRecipeTags, type RecipeTags } from '@/shared/recipe-tags';
import { resetDb } from '@/test/db';
import { clearOutbox, outboxPatches } from '@/test/outbox';

import PlanRecipeSheet from '@/app/plan-recipe';

import { setPlanGridStyle } from '../grid-style';
import { PlanBadges } from '../plan-badges';
import {
  doneLabel,
  isPlaced,
  placedToast,
  planBadges,
  planChanges,
  type Placements,
  shortSlotName,
  slotHint,
  tapSlot,
} from '../plan-modal';
import { groupWeek, weekEntriesQuery } from '../queries';
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
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
const mockParams: { recipeId?: string } = {};
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
    Stack: { Toolbar, Screen: () => null },
    useLocalSearchParams: () => mockParams,
    router: { push: () => {}, back: () => mockBack(), navigate: () => {} },
  };
});

const THURSDAY = '2026-10-15';
const SATURDAY = '2026-10-17';
const NEXT_MONDAY = '2026-10-19';

let home: string;
let tacos: string;
let pasta: string;
let tree: ReactTestRenderer | null = null;

function tag(recipeId: string, meal: string[]) {
  const tags: RecipeTags = { ...emptyRecipeTags(), meal };
  db.update(recipes).set({ tags }).where(eq(recipes.id, recipeId)).run();
}

/** The slot's shown entry as the week reads it from the database. */
function shownNow(day: string, meal: Meal) {
  const entries = weekEntriesQuery(home, day).all();
  return groupWeek(entries).slotEntries(day, meal)[0] ?? null;
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date(2026, 9, 15, 12, 0) });
  resetDb();
  ensureStarterData('user-1');
  home = getList(getDefaultListId('user-1')!)!.householdId;
  tacos = createRecipe('Chicken tacos', home);
  pasta = createRecipe('Lemon ricotta pasta', home);
  tag(tacos, ['lunch', 'dinner']);
  mockBack.mockClear();
  mockParams.recipeId = tacos;
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
const cell = (day: string, meal: Meal) =>
  tree!.root.find((n) => n.props.testID === `slot-${day}-${meal}` && typeof n.props.onPress === 'function' && typeof n.type !== 'string');
const tap = (day: string, meal: Meal) => act(() => cell(day, meal).props.onPress());
const cellText = (day: string, meal: Meal) => textOf(cell(day, meal));
const isPlacedCell = (day: string, meal: Meal) => cell(day, meal).props.accessibilityState?.selected === true;
const toastMessage = () => lines().find((l) => /^(Planned|Replaced)/.test(l)) ?? null;
const cta = () => tree!.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'button' && /^Done/.test(n.props.accessibilityLabel ?? ''));

function open() {
  act(() => {
    tree = create(<PlanRecipeSheet />);
  });
}

describe('the modal state', () => {
  const pastaShown = { kind: 'recipe' as const, recipeId: 'p', recipeName: 'Lemon ricotta pasta', note: null };

  test('a tap places the recipe, keeping what the slot showed; a second tap takes it out', () => {
    let placements: Placements = [];
    placements = tapSlot(placements, THURSDAY, 'dinner', null);
    placements = tapSlot(placements, SATURDAY, 'dinner', pastaShown);
    expect(placements).toEqual([
      { day: THURSDAY, meal: 'dinner', previous: null },
      { day: SATURDAY, meal: 'dinner', previous: pastaShown },
    ]);
    expect(isPlaced(placements, THURSDAY, 'dinner')).toBe(true);
    expect(isPlaced(placements, THURSDAY, 'lunch')).toBe(false);
    placements = tapSlot(placements, THURSDAY, 'dinner', null);
    expect(placements).toEqual([{ day: SATURDAY, meal: 'dinner', previous: pastaShown }]);
  });

  test('the toasts: Planned for, Replaced … on, and Planned again over the same recipe', () => {
    expect(placedToast({ day: THURSDAY, meal: 'dinner', previous: null }, 't', THURSDAY)).toEqual({ message: 'Planned for Thu dinner' });
    expect(placedToast({ day: SATURDAY, meal: 'dinner', previous: pastaShown }, 't', THURSDAY)).toEqual({
      message: 'Replaced Lemon ricotta pasta on Sat dinner',
      emphasis: 'Lemon ricotta pasta',
    });
    const leftovers = { kind: 'leftovers' as const, recipeId: null, recipeName: null, note: null };
    expect(placedToast({ day: NEXT_MONDAY, meal: 'lunch', previous: leftovers }, 't', THURSDAY).message).toBe(
      'Replaced Leftovers on Oct 19 lunch',
    );
    const note = { kind: 'note' as const, recipeId: null, recipeName: null, note: 'Pizza night' };
    expect(placedToast({ day: THURSDAY, meal: 'lunch', previous: note }, 't', THURSDAY).message).toBe('Replaced Pizza night on Thu lunch');
    expect(placedToast({ day: THURSDAY, meal: 'lunch', previous: { ...pastaShown, recipeId: 't' } }, 't', THURSDAY)).toEqual({
      message: 'Planned for Thu lunch',
    });
  });

  test('Done’s changes, its label and VoiceOver’s hints', () => {
    const placements: Placements = [
      { day: THURSDAY, meal: 'dinner', previous: null },
      { day: NEXT_MONDAY, meal: 'lunch', previous: pastaShown },
    ];
    expect(planChanges(placements, 'h', 't')).toEqual([
      { householdId: 'h', day: THURSDAY, meal: 'dinner', entry: { kind: 'recipe', recipeId: 't' } },
      { householdId: 'h', day: NEXT_MONDAY, meal: 'lunch', entry: { kind: 'recipe', recipeId: 't' } },
    ]);
    expect(planChanges([], 'h', 't')).toEqual([]);
    expect(doneLabel(0)).toBe('Done');
    expect(doneLabel(1)).toBe('Done · 1 planned');
    expect(doneLabel(2)).toBe('Done · 2 planned');
    expect(slotHint(false, null)).toBe('Double-tap to plan');
    expect(slotHint(false, pastaShown)).toBe('Double-tap to replace');
    expect(slotHint(true, pastaShown)).toBe('Double-tap to remove');
  });

  test('short slot names: the weekday through Saturday, the date from next Sunday, across a year', () => {
    expect(shortSlotName(THURSDAY, 'dinner', THURSDAY, 'en')).toBe('Thu dinner');
    expect(shortSlotName(SATURDAY, 'breakfast', THURSDAY, 'en')).toBe('Sat breakfast');
    expect(shortSlotName('2026-10-18', 'dinner', THURSDAY, 'en')).toBe('Oct 18 dinner');
    expect(shortSlotName('2026-10-21', 'dinner', THURSDAY, 'en')).toBe('Oct 21 dinner');
    expect(shortSlotName('2027-01-02', 'lunch', '2026-12-31', 'en')).toBe('Sat lunch');
    expect(shortSlotName('2027-01-03', 'lunch', '2026-12-31', 'en')).toBe('Jan 3 lunch');
  });
});

describe('the plan modal', () => {
  test('the recipe on the green header, the hint, the week, its meals highlighted, and Done', () => {
    open();
    expect(lines().slice(0, 3)).toEqual(['Chicken tacos', 'Tap a slot to plan it', 'Oct 11 – 17']);
    const headers = tree!.root.findAll((n) => typeof n.type === 'string' && /^meal-header-/.test(n.props.testID ?? ''));
    expect(headers.map((h) => h.props.testID)).toEqual([
      'meal-header-breakfast',
      'meal-header-lunch-highlighted',
      'meal-header-dinner-highlighted',
    ]);
    expect(StyleSheet.flatten(headers[2].props.style)).toMatchObject({ borderColor: AisleColors.light[MealHues.dinner].strong });
    expect(StyleSheet.flatten(headers[0].props.style).borderWidth).toBeUndefined();
    expect(cta().props.accessibilityLabel).toBe('Done');
    expect(cell(THURSDAY, 'dinner').props.accessibilityHint).toBe('Double-tap to plan');
  });

  test('a tap places the recipe, primarySoft with a primary border, with "Planned for Thu dinner"', () => {
    open();
    tap(THURSDAY, 'dinner');
    expect(isPlacedCell(THURSDAY, 'dinner')).toBe(true);
    expect(cellText(THURSDAY, 'dinner')).toBe('Chicken tacos');
    const host = tree!.root.find((n) => typeof n.type === 'string' && n.props.testID === `slot-${THURSDAY}-dinner`);
    expect(StyleSheet.flatten(host.props.style)).toMatchObject({ backgroundColor: Palette.light.primarySoft, borderColor: Palette.light.primary });
    expect(cell(THURSDAY, 'dinner').props.accessibilityHint).toBe('Double-tap to remove');
    expect(toastMessage()).toBe('Planned for Thu dinner');
    expect(cta().props.accessibilityLabel).toBe('Done · 1 planned');
    // Nothing is written yet.
    expect(shownNow(THURSDAY, 'dinner')).toBeNull();
  });

  test('replacing names what was there; taking the placement out restores it', () => {
    setSlot(home, SATURDAY, 'dinner', { kind: 'recipe', recipeId: pasta });
    open();
    expect(cellText(SATURDAY, 'dinner')).toBe('Lemon ricotta pasta');
    expect(cell(SATURDAY, 'dinner').props.accessibilityHint).toBe('Double-tap to replace');
    tap(SATURDAY, 'dinner');
    expect(cellText(SATURDAY, 'dinner')).toBe('Chicken tacos');
    expect(toastMessage()).toBe('Replaced Lemon ricotta pasta on Sat dinner');
    tap(SATURDAY, 'dinner');
    expect(isPlacedCell(SATURDAY, 'dinner')).toBe(false);
    expect(cellText(SATURDAY, 'dinner')).toBe('Lemon ricotta pasta');
    expect(toastMessage()).toBeNull();
    expect(cta().props.accessibilityLabel).toBe('Done');
  });

  test('Undo takes the last placement out and restores the slot', () => {
    setSlot(home, SATURDAY, 'dinner', { kind: 'leftovers' });
    open();
    tap(THURSDAY, 'lunch');
    tap(SATURDAY, 'dinner');
    expect(toastMessage()).toBe('Replaced Leftovers on Sat dinner');
    press('Undo');
    expect(toastMessage()).toBeNull();
    expect(cellText(SATURDAY, 'dinner')).toBe('Leftovers');
    expect(isPlacedCell(SATURDAY, 'dinner')).toBe(false);
    expect(isPlacedCell(THURSDAY, 'lunch')).toBe(true);
    expect(cta().props.accessibilityLabel).toBe('Done · 1 planned');
  });

  test('changing weeks keeps the placements', () => {
    open();
    tap(THURSDAY, 'dinner');
    press('Next week');
    expect(lines()).toContain('Oct 18 – 24');
    expect(isPlacedCell(NEXT_MONDAY, 'lunch')).toBe(false);
    tap(NEXT_MONDAY, 'lunch');
    expect(toastMessage()).toBe('Planned for Oct 19 lunch');
    expect(cta().props.accessibilityLabel).toBe('Done · 2 planned');
    press('Previous week');
    expect(lines()).toContain('Oct 11 – 17');
    expect(isPlacedCell(THURSDAY, 'dinner')).toBe(true);
    press('Next week');
    expect(isPlacedCell(NEXT_MONDAY, 'lunch')).toBe(true);
  });

  test('Done writes every change in one transaction and closes', () => {
    setSlot(home, SATURDAY, 'dinner', { kind: 'recipe', recipeId: pasta });
    clearOutbox();
    open();
    tap(THURSDAY, 'dinner');
    tap(SATURDAY, 'dinner');
    press('Next week');
    tap(NEXT_MONDAY, 'lunch');
    const transaction = jest.spyOn(db, 'transaction');
    act(() => cta().props.onPress());
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(mockBack).toHaveBeenCalledTimes(1);
    for (const [day, meal] of [
      [THURSDAY, 'dinner'],
      [SATURDAY, 'dinner'],
      [NEXT_MONDAY, 'lunch'],
    ] as const) {
      expect(shownNow(day, meal)).toMatchObject({ kind: 'recipe', recipeId: tacos, recipeName: 'Chicken tacos' });
    }
    // Pasta's row soft-deleted, then the three inserts.
    expect(outboxPatches().map((m) => [m.fields.plan_date, m.fields.meal, m.fields.recipe_id ?? null, m.fields.deleted_at === null])).toEqual([
      [THURSDAY, 'dinner', tacos, true],
      [undefined, undefined, null, false],
      [SATURDAY, 'dinner', tacos, true],
      [NEXT_MONDAY, 'lunch', tacos, true],
    ]);
  });

  test('a placement taken out writes nothing for its slot; Done with none writes nothing', () => {
    open();
    tap(THURSDAY, 'dinner');
    tap(THURSDAY, 'dinner');
    clearOutbox();
    act(() => cta().props.onPress());
    expect(outboxPatches()).toEqual([]);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('Cancel writes nothing', () => {
    open();
    tap(THURSDAY, 'dinner');
    tap(SATURDAY, 'lunch');
    clearOutbox();
    const transaction = jest.spyOn(db, 'transaction');
    const cancel = tree!.root.find((n) => n.type === ('ToolbarButton' as never));
    expect(textOf(cancel)).toBe('Cancel');
    act(() => cancel.props.onPress());
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(transaction).not.toHaveBeenCalled();
    expect(outboxPatches()).toEqual([]);
    expect(shownNow(THURSDAY, 'dinner')).toBeNull();
  });

  test('a deleted recipe shows nothing', () => {
    deleteRecipe(tacos);
    open();
    expect(lines()).toEqual([]);
  });

  describe('in the photo grid style', () => {
    const hostOf = (day: string, meal: Meal) =>
      tree!.root.find((n) => typeof n.type === 'string' && n.props.testID === `slot-${day}-${meal}`);
    const photosIn = (node: ReactTestInstance) => node.findAll((n) => n.type === ('ExpoImage' as never));

    beforeEach(() => setPlanGridStyle('photo'));

    test('a placed cell keeps the photo, with the primary border over it, and the name on the band', () => {
      db.update(recipes).set({ imageUrl: 'https://example.com/tacos.jpg' }).where(eq(recipes.id, tacos)).run();
      open();
      expect(StyleSheet.flatten(hostOf(THURSDAY, 'dinner').props.style)).toMatchObject({ borderStyle: 'dashed', minHeight: 84 });
      tap(THURSDAY, 'dinner');
      expect(isPlacedCell(THURSDAY, 'dinner')).toBe(true);
      const style = StyleSheet.flatten(hostOf(THURSDAY, 'dinner').props.style);
      expect(style).toMatchObject({ borderColor: Palette.light.primary, borderWidth: 2, overflow: 'hidden', minHeight: 84 });
      expect(style.borderStyle).toBeUndefined();
      // The photo over the recipe's tile colour fills the cell, not primarySoft (which green's tile shares).
      expect(style.backgroundColor).toBe(AisleColors.light[recipeHue(tacos)].soft);
      expect(photosIn(hostOf(THURSDAY, 'dinner')).map((i) => i.props.source)).toEqual(['https://example.com/tacos.jpg']);
      const band = hostOf(THURSDAY, 'dinner').find((n) => n.props.testID === 'photo-band' && typeof n.type === 'string');
      expect(textOf(band)).toBe('Chicken tacos');
      expect(cell(THURSDAY, 'dinner').props.accessibilityHint).toBe('Double-tap to remove');

      // Taken out again: no border, what was there (an empty slot).
      tap(THURSDAY, 'dinner');
      expect(isPlacedCell(THURSDAY, 'dinner')).toBe(false);
      expect(photosIn(hostOf(THURSDAY, 'dinner'))).toHaveLength(0);
      expect(StyleSheet.flatten(hostOf(THURSDAY, 'dinner').props.style)).toMatchObject({ borderStyle: 'dashed' });
    });

    test('placing over another recipe shows the placed recipe’s photo', () => {
      db.update(recipes).set({ imageUrl: 'https://example.com/pasta.jpg' }).where(eq(recipes.id, pasta)).run();
      db.update(recipes).set({ imageUrl: 'https://example.com/tacos.jpg' }).where(eq(recipes.id, tacos)).run();
      setSlot(home, SATURDAY, 'dinner', { kind: 'recipe', recipeId: pasta });
      open();
      expect(photosIn(hostOf(SATURDAY, 'dinner')).map((i) => i.props.source)).toEqual(['https://example.com/pasta.jpg']);
      tap(SATURDAY, 'dinner');
      expect(photosIn(hostOf(SATURDAY, 'dinner')).map((i) => i.props.source)).toEqual(['https://example.com/tacos.jpg']);
      expect(StyleSheet.flatten(hostOf(SATURDAY, 'dinner').props.style).borderColor).toBe(Palette.light.primary);
    });
  });

  describe('in the expand grid style', () => {
    const hostOf = (day: string, meal: Meal) =>
      tree!.root.find((n) => typeof n.type === 'string' && n.props.testID === `slot-${day}-${meal}`);

    beforeEach(() => setPlanGridStyle('expand'));

    test('only the compact rows: no day opens, the labels are not buttons, and taps still place', () => {
      setSlot(home, SATURDAY, 'dinner', { kind: 'recipe', recipeId: pasta });
      open();
      // Today isn't opened as it is on the Plan tab, and no day label is a button.
      expect(tree!.root.findAll((n) => /^open-day-/.test(n.props.testID ?? ''))).toHaveLength(0);
      expect(tree!.root.findAll((n) => /^day-label-/.test(n.props.testID ?? ''))).toHaveLength(0);
      expect(tree!.root.findAll((n) => n.props.accessibilityState?.expanded !== undefined)).toHaveLength(0);
      // The expand style's compact cells: a photo strip over the name.
      expect(StyleSheet.flatten(hostOf(SATURDAY, 'dinner').props.style)).toMatchObject({ minHeight: 104 });
      expect(hostOf(SATURDAY, 'dinner').findAll((n) => n.props.testID === 'plan-photo' && typeof n.type === 'string')).toHaveLength(1);

      tap(THURSDAY, 'dinner');
      expect(isPlacedCell(THURSDAY, 'dinner')).toBe(true);
      const style = StyleSheet.flatten(hostOf(THURSDAY, 'dinner').props.style);
      expect(style).toMatchObject({ borderColor: Palette.light.primary, backgroundColor: Palette.light.primarySoft, minHeight: 104 });
      expect(hostOf(THURSDAY, 'dinner').findAll((n) => n.props.testID === 'plan-photo' && typeof n.type === 'string')).toHaveLength(1);
      expect(cell(THURSDAY, 'dinner').props.accessibilityHint).toBe('Double-tap to remove');
    });
  });
});

describe('the plan badges', () => {
  function render() {
    const onOpen = jest.fn();
    act(() => {
      tree = create(<PlanBadges recipeId={tacos} onOpen={onOpen} />);
    });
    return onOpen;
  }
  const badges = () =>
    tree!.root
      .findAll((n) => typeof n.type !== 'string' && /^plan-badge-/.test(n.props.testID ?? '') && typeof n.props.onPress === 'function')
      .map((n) => [textOf(n), n.props.accessibilityLabel as string]);

  test('none when the recipe is not planned from today on', () => {
    setSlot(home, '2026-10-14', 'dinner', { kind: 'recipe', recipeId: tacos }); // yesterday
    setSlot(home, THURSDAY, 'dinner', { kind: 'recipe', recipeId: pasta });
    render();
    expect(tree!.toJSON()).toBeNull();
  });

  test('soonest first, "Thu dinner" this week and "Oct 21 dinner" after, in the meal’s strong hue', () => {
    setSlot(home, '2026-10-21', 'dinner', { kind: 'recipe', recipeId: tacos });
    setSlot(home, THURSDAY, 'dinner', { kind: 'recipe', recipeId: tacos });
    setSlot(home, THURSDAY, 'lunch', { kind: 'recipe', recipeId: tacos });
    const onOpen = render();
    expect(badges()).toEqual([
      ['Thu lunch', 'Planned for Thu lunch'],
      ['Thu dinner', 'Planned for Thu dinner'],
      ['Oct 21 dinner', 'Planned for Oct 21 dinner'],
    ]);
    const lunch = tree!.root.findAll((n) => typeof n.type === 'string' && /^plan-badge-/.test(n.props.testID ?? ''))[0];
    expect(StyleSheet.flatten(lunch.props.style)).toMatchObject({ backgroundColor: AisleColors.light[MealHues.lunch].strong });
    act(() => tree!.root.find((n) => n.props.accessibilityLabel === 'Planned for Oct 21 dinner' && typeof n.type !== 'string').props.onPress());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test('the first three, then "+N", which opens the modal too', () => {
    for (const day of ['2026-10-16', '2026-10-17', '2026-10-24', '2026-11-02']) setSlot(home, day, 'dinner', { kind: 'recipe', recipeId: tacos });
    setSlot(home, THURSDAY, 'breakfast', { kind: 'recipe', recipeId: tacos });
    const onOpen = render();
    expect(badges()).toEqual([
      ['Thu breakfast', 'Planned for Thu breakfast'],
      ['Fri dinner', 'Planned for Fri dinner'],
      ['Sat dinner', 'Planned for Sat dinner'],
      ['+2', '2 more planned'],
    ]);
    act(() => tree!.root.find((n) => n.props.accessibilityLabel === '2 more planned' && typeof n.type !== 'string').props.onPress());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test('a replaced or cleared entry drops out', () => {
    setSlot(home, THURSDAY, 'dinner', { kind: 'recipe', recipeId: tacos });
    setSlot(home, SATURDAY, 'dinner', { kind: 'recipe', recipeId: tacos });
    setSlot(home, THURSDAY, 'dinner', { kind: 'eating-out' });
    render();
    expect(badges().map(([text]) => text)).toEqual(['Sat dinner']);
  });

  test('planBadges counts the rest past three, and none for no entries', () => {
    const e = (id: string, planDate: string, meal: Meal) => ({ id, planDate, meal });
    expect(planBadges([], THURSDAY)).toEqual({ badges: [], more: 0 });
    expect(planBadges([e('a', THURSDAY, 'lunch'), e('b', '2026-10-30', 'dinner')], THURSDAY)).toEqual({
      badges: [
        { key: 'a', label: 'Thu lunch', meal: 'lunch' },
        { key: 'b', label: 'Oct 30 dinner', meal: 'dinner' },
      ],
      more: 0,
    });
    const four = [e('a', THURSDAY, 'lunch'), e('b', THURSDAY, 'dinner'), e('c', SATURDAY, 'lunch'), e('d', SATURDAY, 'dinner')];
    expect(planBadges(four, THURSDAY).more).toBe(1);
    expect(planBadges(four, THURSDAY).badges.map((b) => b.key)).toEqual(['a', 'b', 'c']);
  });
});
