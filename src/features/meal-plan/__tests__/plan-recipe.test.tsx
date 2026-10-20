// Planning a recipe (spec 4.16, the "Plan → tap a slot" prototype): the plan modal's taps kept in its
// state, Done and Cancel, and the recipe screen's plan badges, against the in-memory database on
// Thursday, October 15, 2026 (this week is Oct 11 – 17).
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { StyleSheet } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AisleColors, MealHues, Palette } from '@/constants/theme';
import { db, recipes } from '@/db';
import { ensureStarterData, getDefaultListId, getList } from '@/features/lists/lists';
import { createRecipe, deleteRecipe } from '@/features/recipes/recipes';
import { i18n } from '@/i18n';
import { emptyRecipeTags, type RecipeTags } from '@/shared/recipe-tags';
import { resetDb } from '@/test/db';
import { clearOutbox, outboxPatches } from '@/test/outbox';

import PlanRecipeSheet from '@/app/plan-recipe';

import { setPlanCellStyle } from '../cell-style';
import { PlanBadges } from '../plan-badges';
import {
  doneLabel,
  holdsRecipe,
  isPlaced,
  placedToast,
  planBadges,
  planChanges,
  type Placements,
  shortSlotName,
  slotHint,
  tapSlot,
  withPlacements,
} from '../plan-modal';
import { groupWeek, type PlanEntry, weekEntriesQuery } from '../queries';
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

/** The slot's recipes' names, in order, as the week reads them from the database. */
function namesNow(day: string, meal: Meal) {
  return groupWeek(weekEntriesQuery(home, day).all())
    .slotEntries(day, meal)
    .map((e) => e.recipeName ?? e.kind);
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
  setPlanCellStyle('split');
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
const toastMessage = () => lines().find((l) => /^(Planned|Replaced|Added|Already planned for)/.test(l)) ?? null;
const cta = () => tree!.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'button' && /^Done/.test(n.props.accessibilityLabel ?? ''));

function open() {
  act(() => {
    tree = create(<PlanRecipeSheet />);
  });
}

describe('the modal state', () => {
  const pastaShown = { kind: 'recipe' as const, recipeId: 'p', recipeName: 'Lemon ricotta pasta', note: null };

  const saladShown = { kind: 'recipe' as const, recipeId: 's', recipeName: 'Caesar salad', note: null };
  const tacosShown = { kind: 'recipe' as const, recipeId: 't', recipeName: 'Chicken tacos', note: null };
  const leftovers = { kind: 'leftovers' as const, recipeId: null, recipeName: null, note: null };
  const note = { kind: 'note' as const, recipeId: null, recipeName: null, note: 'Pizza night' };

  test('a tap places the recipe, keeping what the slot showed; a second tap takes it out', () => {
    let placements: Placements = [];
    placements = tapSlot(placements, THURSDAY, 'dinner', [], 't');
    placements = tapSlot(placements, SATURDAY, 'dinner', [pastaShown, saladShown], 't');
    expect(placements).toEqual([
      { day: THURSDAY, meal: 'dinner', previous: [] },
      { day: SATURDAY, meal: 'dinner', previous: [pastaShown, saladShown] },
    ]);
    expect(isPlaced(placements, THURSDAY, 'dinner')).toBe(true);
    expect(isPlaced(placements, THURSDAY, 'lunch')).toBe(false);
    placements = tapSlot(placements, THURSDAY, 'dinner', [], 't');
    expect(placements).toEqual([{ day: SATURDAY, meal: 'dinner', previous: [pastaShown, saladShown] }]);
  });

  test('a slot already holding the recipe takes no tap, wherever the recipe sits', () => {
    const placements: Placements = [{ day: THURSDAY, meal: 'dinner', previous: [] }];
    expect(tapSlot(placements, SATURDAY, 'dinner', [tacosShown], 't')).toBe(placements);
    expect(tapSlot(placements, SATURDAY, 'dinner', [pastaShown, tacosShown], 't')).toBe(placements);
    expect(tapSlot([], SATURDAY, 'dinner', [pastaShown, tacosShown], 't')).toEqual([]);
    // Another recipe's id is not this one.
    expect(tapSlot([], SATURDAY, 'dinner', [pastaShown], 't')).toHaveLength(1);
    expect(holdsRecipe([pastaShown, tacosShown], 't')).toBe(true);
    expect(holdsRecipe([pastaShown], 't')).toBe(false);
    expect(holdsRecipe([], 't')).toBe(false);
    expect(holdsRecipe([note], 't')).toBe(false);
  });

  test('the toasts: Planned for, Added to, Replaced … on, and Already planned for', () => {
    expect(placedToast({ day: THURSDAY, meal: 'dinner', previous: [] }, 't', THURSDAY)).toEqual({ message: 'Planned for Thu dinner' });
    expect(placedToast({ day: SATURDAY, meal: 'dinner', previous: [pastaShown] }, 't', THURSDAY)).toEqual({ message: 'Added to Sat dinner' });
    expect(placedToast({ day: SATURDAY, meal: 'dinner', previous: [pastaShown, saladShown] }, 't', THURSDAY)).toEqual({
      message: 'Added to Sat dinner',
    });
    expect(placedToast({ day: NEXT_MONDAY, meal: 'lunch', previous: [leftovers] }, 't', THURSDAY)).toEqual({
      message: 'Replaced Leftovers on Oct 19 lunch',
      emphasis: 'Leftovers',
    });
    const eatingOut = { kind: 'eating-out' as const, recipeId: null, recipeName: null, note: null };
    expect(placedToast({ day: SATURDAY, meal: 'dinner', previous: [eatingOut] }, 't', THURSDAY).message).toBe('Replaced Eating out on Sat dinner');
    expect(placedToast({ day: THURSDAY, meal: 'lunch', previous: [note] }, 't', THURSDAY).message).toBe('Replaced Pizza night on Thu lunch');
    expect(placedToast({ day: THURSDAY, meal: 'lunch', previous: [tacosShown] }, 't', THURSDAY)).toEqual({
      message: 'Already planned for Thu lunch',
    });
    expect(placedToast({ day: '2026-10-21', meal: 'dinner', previous: [pastaShown, tacosShown] }, 't', THURSDAY)).toEqual({
      message: 'Already planned for Oct 21 dinner',
    });
  });

  test('Done’s changes are adds, its label and VoiceOver’s hints', () => {
    const placements: Placements = [
      { day: THURSDAY, meal: 'dinner', previous: [] },
      { day: NEXT_MONDAY, meal: 'lunch', previous: [pastaShown] },
      { day: SATURDAY, meal: 'dinner', previous: [note] },
    ];
    expect(planChanges(placements, 'h', 't')).toEqual([
      { householdId: 'h', day: THURSDAY, meal: 'dinner', add: { recipeId: 't' } },
      { householdId: 'h', day: NEXT_MONDAY, meal: 'lunch', add: { recipeId: 't' } },
      { householdId: 'h', day: SATURDAY, meal: 'dinner', add: { recipeId: 't' } },
    ]);
    expect(planChanges([], 'h', 't')).toEqual([]);
    expect(doneLabel(0)).toBe('Done');
    expect(doneLabel(1)).toBe('Done · 1 planned');
    expect(doneLabel(2)).toBe('Done · 2 planned');
    expect(slotHint(false, [], 't')).toBe('Double-tap to plan');
    expect(slotHint(false, [pastaShown], 't')).toBe('Double-tap to add');
    expect(slotHint(false, [pastaShown, saladShown], 't')).toBe('Double-tap to add');
    expect(slotHint(false, [note], 't')).toBe('Double-tap to replace');
    expect(slotHint(false, [leftovers], 't')).toBe('Double-tap to replace');
    expect(slotHint(true, [pastaShown], 't')).toBe('Double-tap to remove');
    expect(slotHint(true, [], 't')).toBe('Double-tap to remove');
    expect(slotHint(false, [pastaShown, tacosShown], 't')).toBe('Already planned');
  });

  test('withPlacements: after the slot’s recipes, alone over a note or in an empty slot, once if already there', () => {
    const entry = (id: string, kind: PlanEntry['kind'], position: number, recipeId: string | null = null) =>
      ({ id, kind, position, recipeId, recipeName: id, note: null, planDate: SATURDAY, meal: 'dinner' }) as PlanEntry;
    const slots: Record<string, PlanEntry[]> = {
      [`${SATURDAY}-dinner`]: [entry('pasta', 'recipe', 0, 'p'), entry('salad', 'recipe', 4, 's')],
      [`${SATURDAY}-lunch`]: [entry('out', 'eating-out', 0)],
      [`${THURSDAY}-lunch`]: [entry('tacos', 'recipe', 0, 't')],
    };
    const plan = { slotEntries: (day: string, meal: Meal) => slots[`${day}-${meal}`] ?? [] };
    const recipe = { id: 't', name: 'Chicken tacos', totalMinutes: 20, imageUrl: null, photoPath: null };
    const placements: Placements = [SATURDAY, THURSDAY].flatMap((day) =>
      (['dinner', 'lunch'] as const).map((meal) => ({ day, meal, previous: [] })),
    );
    const shown = withPlacements(plan, placements, recipe, 'h');
    const summary = (day: string, meal: Meal) => shown.slotEntries(day, meal).map((e) => [e.id, e.recipeId, e.position]);
    expect(summary(SATURDAY, 'dinner')).toEqual([
      ['pasta', 'p', 0],
      ['salad', 's', 4],
      [`placed-${SATURDAY}-dinner`, 't', 5],
    ]);
    expect(summary(SATURDAY, 'lunch')).toEqual([[`placed-${SATURDAY}-lunch`, 't', 0]]);
    expect(summary(THURSDAY, 'dinner')).toEqual([[`placed-${THURSDAY}-dinner`, 't', 0]]);
    expect(summary(THURSDAY, 'lunch')).toEqual([['tacos', 't', 0]]);
    // An unplaced slot is the plan's.
    expect(summary(SATURDAY, 'breakfast')).toEqual([]);
    expect(withPlacements(plan, [], recipe, 'h').slotEntries(SATURDAY, 'dinner')).toBe(slots[`${SATURDAY}-dinner`]);
    expect(shown.slotEntries(SATURDAY, 'dinner')[2]).toMatchObject({ householdId: 'h', kind: 'recipe', recipeName: 'Chicken tacos', recipeTotalMinutes: 20 });
  });

  test('the new toasts and hints in Spanish', () => {
    void i18n.changeLanguage('es');
    try {
      expect(placedToast({ day: THURSDAY, meal: 'dinner', previous: [pastaShown] }, 't', THURSDAY).message).toBe('Agregada a cena del jue');
      expect(placedToast({ day: THURSDAY, meal: 'dinner', previous: [tacosShown] }, 't', THURSDAY).message).toBe(
        'Ya está planeada para cena del jue',
      );
      expect(slotHint(false, [pastaShown], 't')).toBe('Toca dos veces para agregar');
      expect(slotHint(false, [tacosShown], 't')).toBe('Ya está planeada');
    } finally {
      void i18n.changeLanguage('en');
    }
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

  test('beside a recipe the tap adds it after; taking the placement out restores the slot', () => {
    setSlot(home, SATURDAY, 'dinner', { kind: 'recipe', recipeId: pasta });
    open();
    expect(cellText(SATURDAY, 'dinner')).toBe('Lemon ricotta pasta');
    expect(cell(SATURDAY, 'dinner').props.accessibilityHint).toBe('Double-tap to add');
    tap(SATURDAY, 'dinner');
    expect(cellText(SATURDAY, 'dinner')).toBe('Lemon ricotta pastaChicken tacos');
    expect(cell(SATURDAY, 'dinner').props.accessibilityLabel).toBe('Saturday dinner, Lemon ricotta pasta, Chicken tacos');
    expect(toastMessage()).toBe('Added to Sat dinner');
    expect(cell(SATURDAY, 'dinner').props.accessibilityHint).toBe('Double-tap to remove');
    tap(SATURDAY, 'dinner');
    expect(isPlacedCell(SATURDAY, 'dinner')).toBe(false);
    expect(cellText(SATURDAY, 'dinner')).toBe('Lemon ricotta pasta');
    expect(toastMessage()).toBeNull();
    expect(cta().props.accessibilityLabel).toBe('Done');
  });

  test('a slot with two recipes gets a third; Done adds it and keeps both; tapping again takes it out', () => {
    const salad = createRecipe('Caesar salad', home);
    addRecipeToSlot(home, SATURDAY, 'dinner', pasta);
    addRecipeToSlot(home, SATURDAY, 'dinner', salad);
    open();
    expect(cell(SATURDAY, 'dinner').props.accessibilityHint).toBe('Double-tap to add');
    tap(SATURDAY, 'dinner');
    expect(isPlacedCell(SATURDAY, 'dinner')).toBe(true);
    expect(cell(SATURDAY, 'dinner').props.accessibilityLabel).toBe('Saturday dinner, Lemon ricotta pasta, Caesar salad, Chicken tacos');
    expect(toastMessage()).toBe('Added to Sat dinner');
    // Out again, then back in.
    tap(SATURDAY, 'dinner');
    expect(cell(SATURDAY, 'dinner').props.accessibilityLabel).toBe('Saturday dinner, Lemon ricotta pasta, Caesar salad');
    expect(cta().props.accessibilityLabel).toBe('Done');
    tap(SATURDAY, 'dinner');
    expect(namesNow(SATURDAY, 'dinner')).toEqual(['Lemon ricotta pasta', 'Caesar salad']);
    clearOutbox();
    act(() => cta().props.onPress());
    expect(namesNow(SATURDAY, 'dinner')).toEqual(['Lemon ricotta pasta', 'Caesar salad', 'Chicken tacos']);
    // One insert, nothing soft-deleted.
    expect(outboxPatches().map((m) => [m.fields.recipe_id, m.fields.position, m.fields.deleted_at])).toEqual([[tacos, 2, null]]);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('a slot already holding the recipe takes no tap and says so', () => {
    addRecipeToSlot(home, SATURDAY, 'dinner', pasta);
    addRecipeToSlot(home, SATURDAY, 'dinner', tacos);
    open();
    expect(cell(SATURDAY, 'dinner').props.accessibilityHint).toBe('Already planned');
    tap(SATURDAY, 'dinner');
    expect(isPlacedCell(SATURDAY, 'dinner')).toBe(false);
    expect(cell(SATURDAY, 'dinner').props.accessibilityLabel).toBe('Saturday dinner, Lemon ricotta pasta, Chicken tacos');
    expect(toastMessage()).toBe('Already planned for Sat dinner');
    // No Undo on it, and nothing to write.
    expect(tree!.root.findAll((n) => n.props.accessibilityLabel === 'Undo')).toHaveLength(0);
    expect(cta().props.accessibilityLabel).toBe('Done');
    // A second tap is still ignored, not taken as a placement to undo.
    tap(SATURDAY, 'dinner');
    expect(isPlacedCell(SATURDAY, 'dinner')).toBe(false);
    clearOutbox();
    act(() => cta().props.onPress());
    expect(outboxPatches()).toEqual([]);
  });

  test('a note is replaced, and Done soft-deletes it', () => {
    setSlot(home, SATURDAY, 'dinner', { kind: 'eating-out' });
    open();
    expect(cell(SATURDAY, 'dinner').props.accessibilityHint).toBe('Double-tap to replace');
    tap(SATURDAY, 'dinner');
    expect(cellText(SATURDAY, 'dinner')).toBe('Chicken tacos');
    expect(toastMessage()).toBe('Replaced Eating out on Sat dinner');
    act(() => cta().props.onPress());
    expect(namesNow(SATURDAY, 'dinner')).toEqual(['Chicken tacos']);
  });

  test('an empty slot is planned', () => {
    open();
    tap(SATURDAY, 'lunch');
    expect(toastMessage()).toBe('Planned for Sat lunch');
    act(() => cta().props.onPress());
    expect(namesNow(SATURDAY, 'lunch')).toEqual(['Chicken tacos']);
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
      [NEXT_MONDAY, 'lunch'],
    ] as const) {
      expect(shownNow(day, meal)).toMatchObject({ kind: 'recipe', recipeId: tacos, recipeName: 'Chicken tacos' });
    }
    expect(namesNow(SATURDAY, 'dinner')).toEqual(['Lemon ricotta pasta', 'Chicken tacos']);
    // The three inserts, pasta kept.
    expect(outboxPatches().map((m) => [m.fields.plan_date, m.fields.meal, m.fields.recipe_id ?? null, m.fields.deleted_at === null])).toEqual([
      [THURSDAY, 'dinner', tacos, true],
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

  describe('the grid', () => {
    const hostOf = (day: string, meal: Meal) =>
      tree!.root.find((n) => typeof n.type === 'string' && n.props.testID === `slot-${day}-${meal}`);
    const photosIn = (node: ReactTestInstance) => node.findAll((n) => n.type === ('ExpoImage' as never));

    test('placing beside another recipe draws both photos, split, in the placed look', () => {
      db.update(recipes).set({ imageUrl: 'https://example.com/pasta.jpg' }).where(eq(recipes.id, pasta)).run();
      db.update(recipes).set({ imageUrl: 'https://example.com/tacos.jpg' }).where(eq(recipes.id, tacos)).run();
      setSlot(home, SATURDAY, 'dinner', { kind: 'recipe', recipeId: pasta });
      open();
      expect(photosIn(hostOf(SATURDAY, 'dinner')).map((i) => i.props.source)).toEqual(['https://example.com/pasta.jpg']);
      tap(SATURDAY, 'dinner');
      expect(photosIn(hostOf(SATURDAY, 'dinner')).map((i) => i.props.source)).toEqual([
        'https://example.com/pasta.jpg',
        'https://example.com/tacos.jpg',
      ]);
      expect(hostOf(SATURDAY, 'dinner').findAll((n) => typeof n.type === 'string' && n.props.testID === 'plan-split-piece')).toHaveLength(2);
      expect(StyleSheet.flatten(hostOf(SATURDAY, 'dinner').props.style)).toMatchObject({
        borderColor: Palette.light.primary,
        backgroundColor: Palette.light.primarySoft,
      });
    });

    test('with Grid cells set to Stacked, the placed cell stacks the recipes', () => {
      setPlanCellStyle('stacked');
      setSlot(home, SATURDAY, 'dinner', { kind: 'recipe', recipeId: pasta });
      open();
      tap(SATURDAY, 'dinner');
      const host = hostOf(SATURDAY, 'dinner');
      expect(host.findAll((n) => typeof n.type === 'string' && n.props.testID === 'plan-stack-item')).toHaveLength(2);
      expect(StyleSheet.flatten(host.props.style).backgroundColor).toBe(Palette.light.primarySoft);
    });

    test('only the cells: no day opens, the labels are not buttons, and taps still place', () => {
      setSlot(home, SATURDAY, 'dinner', { kind: 'recipe', recipeId: pasta });
      open();
      // Today isn't opened as it is on the Plan tab, and no day label is a button.
      expect(tree!.root.findAll((n) => /^open-day-/.test(n.props.testID ?? ''))).toHaveLength(0);
      expect(tree!.root.findAll((n) => /^day-label-/.test(n.props.testID ?? ''))).toHaveLength(0);
      expect(tree!.root.findAll((n) => n.props.accessibilityState?.expanded !== undefined)).toHaveLength(0);
      // A photo strip over the name.
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
