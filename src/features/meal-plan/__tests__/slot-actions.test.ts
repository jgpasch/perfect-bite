// The slot actions behind the week (spec 4.16): what the slot sheet's button writes and its toast's
// Undo, Clear and Remove with Undo, where a tapped slot goes, and where the sheets' toasts land.
// Thursday, October 15, 2026.
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ActionSheetIOS, Alert } from 'react-native';

import { ensureStarterData, getDefaultListId, getList } from '@/features/lists/lists';
import { createRecipe } from '@/features/recipes/recipes';
import { resetDb } from '@/test/db';

import { groupWeek, weekEntriesQuery, type PlanEntry } from '../queries';
import {
  clearSlotWithUndo,
  mealToast,
  openAddSheet,
  openMealSheet,
  openSlot,
  openSlotSheet,
  pickButtonLabels,
  pickChanges,
  pickRecipes,
  promptNote,
  removedToast,
  type SlotToast,
  weekToast,
} from '../slot-actions';
import type { Meal } from '../week';
import { addRecipeToSlot, removeEntry, setSlot } from '../write';

jest.mock('@/db/client', () => require('@/test/db'));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (...args: unknown[]) => mockPush(...args) } }));

const USER = 'user-1';
const TODAY = '2026-10-15';
let home: string;
let tacos: { id: string; name: string };
let soup: { id: string; name: string };
let salad: { id: string; name: string };

beforeEach(() => {
  resetDb();
  mockPush.mockReset();
  jest.restoreAllMocks();
  ensureStarterData(USER);
  home = getList(getDefaultListId(USER)!)!.householdId;
  [tacos, soup, salad] = ['Tacos', 'Soup', 'Caesar salad'].map((name) => ({ id: createRecipe(name, home), name }));
});

const entries = (day = TODAY, meal: Meal = 'dinner'): PlanEntry[] =>
  groupWeek(weekEntriesQuery(home, '2026-10-11').all()).slotEntries(day, meal);
const slot = (day = TODAY, meal: Meal = 'dinner') => entries(day, meal).map((e) => e.recipeName ?? e.note ?? e.kind);
const undo = (toast: SlotToast) => toast.actions.find((a) => a.label === 'Undo')!.onPress();

describe('pickChanges', () => {
  test('adds each ticked recipe in order; replace clears first', () => {
    const at = { householdId: home, day: TODAY, meal: 'dinner' as const };
    expect(pickChanges(home, TODAY, 'dinner', ['a', 'b'], 'fill')).toEqual([
      { ...at, add: { recipeId: 'a' } },
      { ...at, add: { recipeId: 'b' } },
    ]);
    expect(pickChanges(home, TODAY, 'dinner', ['a'], 'add')).toEqual([{ ...at, add: { recipeId: 'a' } }]);
    expect(pickChanges(home, TODAY, 'dinner', ['a'], 'replace')).toEqual([
      { ...at, entry: null },
      { ...at, add: { recipeId: 'a' } },
    ]);
  });

  test('replace with nothing ticked is just a clear', () => {
    expect(pickChanges(home, TODAY, 'lunch', [], 'replace')).toEqual([{ householdId: home, day: TODAY, meal: 'lunch', entry: null }]);
    expect(pickChanges(home, TODAY, 'lunch', [], 'fill')).toEqual([]);
  });
});

describe('pickButtonLabels', () => {
  test('one recipe and several, adding and replacing', () => {
    expect(pickButtonLabels('dinner', 1, 'fill')).toEqual({ label: 'Add to dinner', accessibilityLabel: 'Add to dinner' });
    expect(pickButtonLabels('lunch', 3, 'add')).toEqual({ label: 'Add 3 to lunch', accessibilityLabel: 'Add 3 recipes to lunch' });
    expect(pickButtonLabels('breakfast', 1, 'replace')).toEqual({
      label: 'Replace breakfast',
      accessibilityLabel: 'Replace breakfast',
    });
    expect(pickButtonLabels('dinner', 2, 'replace')).toEqual({
      label: 'Replace with 2',
      accessibilityLabel: 'Replace dinner with 2 recipes',
    });
  });
});

describe('pickRecipes', () => {
  test('one recipe in an empty slot: "Added Tacos to Thu dinner", and Undo empties it again', () => {
    const onToast = jest.fn();
    const toast = pickRecipes(home, TODAY, 'dinner', [tacos], 'fill', TODAY, onToast);
    expect(toast).toMatchObject({ message: 'Added Tacos to Thu dinner', emphasis: 'Tacos' });
    expect(toast.key).toMatch(/^picked-2026-10-15-dinner-\d+$/);
    expect(slot()).toEqual(['Tacos']);

    undo(toast);
    expect(slot()).toEqual([]);
    expect(onToast).toHaveBeenCalledWith(null);
  });

  test('several beside what is there, in the order ticked; Undo leaves the old ones', () => {
    addRecipeToSlot(home, TODAY, 'dinner', tacos.id);
    const toast = pickRecipes(home, TODAY, 'dinner', [salad, soup], 'fill', TODAY, jest.fn());
    expect(toast.message).toBe('Added 2 recipes to Thu dinner');
    expect(toast.emphasis).toBeUndefined();
    expect(slot()).toEqual(['Tacos', 'Caesar salad', 'Soup']);

    undo(toast);
    expect(slot()).toEqual(['Tacos']);
  });

  test("a slot after this week is named by its date", () => {
    expect(pickRecipes(home, '2026-10-21', 'lunch', [soup], 'fill', TODAY, jest.fn()).message).toBe('Added Soup to Oct 21 lunch');
  });

  test('replace over a note: "Replaced Thu dinner" with no emphasis, and Undo brings the note back', () => {
    setSlot(home, TODAY, 'dinner', { kind: 'note', note: 'Pizza night' });
    const toast = pickRecipes(home, TODAY, 'dinner', [tacos, soup], 'replace', TODAY, jest.fn());
    expect(toast).toMatchObject({ message: 'Replaced Thu dinner', emphasis: undefined });
    expect(slot()).toEqual(['Tacos', 'Soup']);

    undo(toast);
    expect(slot()).toEqual(['Pizza night']);
  });

  test("the add sheet's toast names just the meal", () => {
    addRecipeToSlot(home, TODAY, 'dinner', tacos.id);
    expect(pickRecipes(home, TODAY, 'dinner', [soup], 'add', TODAY, jest.fn())).toMatchObject({
      message: 'Added Soup to dinner',
      emphasis: 'Soup',
    });
    const toast = pickRecipes(home, TODAY, 'dinner', [salad, { id: tacos.id, name: 'Tacos' }], 'add', TODAY, jest.fn());
    expect(toast.message).toBe('Added 2 recipes to dinner');
    // Tacos was already there: skipped, so Undo leaves it.
    expect(slot()).toEqual(['Tacos', 'Soup', 'Caesar salad']);
    undo(toast);
    expect(slot()).toEqual(['Tacos', 'Soup']);
  });

  test('a recipe from another household writes nothing and throws', () => {
    expect(() =>
      pickRecipes(home, TODAY, 'dinner', [tacos, { id: 'not-a-recipe', name: 'X' }], 'fill', TODAY, jest.fn()),
    ).toThrow("Recipe not-a-recipe isn't in household");
    expect(slot()).toEqual([]);
  });
});

describe('clearSlotWithUndo', () => {
  test('"Cleared Thursday dinner"; Undo puts every entry back in order and takes the toast down', () => {
    addRecipeToSlot(home, TODAY, 'dinner', tacos.id);
    addRecipeToSlot(home, TODAY, 'dinner', soup.id);
    const onToast = jest.fn<(toast: SlotToast | null) => void>();

    clearSlotWithUndo(home, TODAY, 'dinner', onToast);
    expect(slot()).toEqual([]);
    expect(onToast).toHaveBeenCalledTimes(1);
    const toast = onToast.mock.calls[0][0]!;
    expect(toast.message).toBe('Cleared Thursday dinner');
    expect(toast.actions.map((a) => a.label)).toEqual(['Undo']);

    // Something filled the slot before Undo: it goes.
    addRecipeToSlot(home, TODAY, 'dinner', salad.id);
    undo(toast);
    expect(slot()).toEqual(['Tacos', 'Soup']);
    expect(onToast).toHaveBeenLastCalledWith(null);
  });

  test('an empty slot shows no toast', () => {
    const onToast = jest.fn();
    clearSlotWithUndo(home, TODAY, 'dinner', onToast);
    expect(onToast).not.toHaveBeenCalled();
  });
});

describe('removedToast', () => {
  test('"Removed Soup"; Undo puts it back in its place', () => {
    addRecipeToSlot(home, TODAY, 'dinner', tacos.id);
    const middle = addRecipeToSlot(home, TODAY, 'dinner', soup.id)!;
    addRecipeToSlot(home, TODAY, 'dinner', salad.id);
    const removed = removeEntry(middle.id)!;
    const onToast = jest.fn();

    const toast = removedToast('Soup', removed, onToast);
    expect(toast).toMatchObject({ message: 'Removed Soup', emphasis: 'Soup' });
    expect(toast.key).toMatch(new RegExp(`^removed-${middle.id}-\\d+$`));
    expect(slot()).toEqual(['Tacos', 'Caesar salad']);

    undo(toast);
    expect(slot()).toEqual(['Tacos', 'Soup', 'Caesar salad']);
    expect(onToast).toHaveBeenCalledWith(null);
  });
});

describe('the sheets and their toasts', () => {
  test('the slot sheet and meal sheet hand their toasts to the week that opened them', () => {
    const first = jest.fn();
    const second = jest.fn();
    const toast: SlotToast = { key: 'k', message: 'hi', actions: [] };

    openSlotSheet(home, TODAY, 'dinner', first);
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/plan-slot', params: { householdId: home, day: TODAY, meal: 'dinner' } });
    weekToast(toast);
    expect(first).toHaveBeenCalledWith(toast);

    openMealSheet(home, TODAY, 'lunch', second);
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/plan-meal', params: { householdId: home, day: TODAY, meal: 'lunch' } });
    weekToast(null);
    expect(second).toHaveBeenCalledWith(null);
    expect(first).toHaveBeenCalledTimes(1);
  });

  test("the add sheet hands its toasts to the meal sheet, apart from the week's", () => {
    const week = jest.fn();
    const meal = jest.fn();
    openSlotSheet(home, TODAY, 'dinner', week, { replace: true });
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/plan-slot',
      params: { householdId: home, day: TODAY, meal: 'dinner', mode: 'replace' },
    });
    openAddSheet(home, TODAY, 'dinner', meal);
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/plan-slot',
      params: { householdId: home, day: TODAY, meal: 'dinner', mode: 'add' },
    });

    mealToast(null);
    expect(meal).toHaveBeenCalledWith(null);
    expect(week).not.toHaveBeenCalled();
  });
});

describe('openSlot', () => {
  type SheetCallback = (index: number) => void;
  const sheet = () => {
    const spy = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    return {
      spy,
      options: () => spy.mock.calls[0][0],
      choose: (index: number) => (spy.mock.calls[0][1] as SheetCallback)(index),
    };
  };

  test('an empty slot opens the slot sheet, a slot with recipes the meal sheet', () => {
    const { spy } = sheet();
    openSlot(home, TODAY, 'dinner', null, jest.fn());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/plan-slot', params: { householdId: home, day: TODAY, meal: 'dinner' } });

    addRecipeToSlot(home, TODAY, 'dinner', tacos.id);
    openSlot(home, TODAY, 'dinner', entries()[0], jest.fn());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/plan-meal', params: { householdId: home, day: TODAY, meal: 'dinner' } });
    expect(spy).not.toHaveBeenCalled();
  });

  test("a note's menu: Replace…, Edit note…, Clear (destructive), Cancel", () => {
    setSlot(home, TODAY, 'dinner', { kind: 'note', note: 'Pizza night' });
    const { options } = sheet();
    openSlot(home, TODAY, 'dinner', entries()[0], jest.fn());
    expect(options()).toMatchObject({
      options: ['Replace…', 'Edit note…', 'Clear', 'Cancel'],
      destructiveButtonIndex: 2,
      cancelButtonIndex: 3,
    });
    expect(options().title).toContain('Pizza night');
  });

  test('Leftovers has no Edit note…', () => {
    setSlot(home, TODAY, 'lunch', { kind: 'leftovers' });
    const { options } = sheet();
    openSlot(home, TODAY, 'lunch', entries(TODAY, 'lunch')[0], jest.fn());
    expect(options()).toMatchObject({ options: ['Replace…', 'Clear', 'Cancel'], destructiveButtonIndex: 1, cancelButtonIndex: 2 });
  });

  test('Replace… opens the slot sheet to replace', () => {
    setSlot(home, TODAY, 'dinner', { kind: 'eating-out' });
    const { choose } = sheet();
    openSlot(home, TODAY, 'dinner', entries()[0], jest.fn());
    choose(0);
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/plan-slot',
      params: { householdId: home, day: TODAY, meal: 'dinner', mode: 'replace' },
    });
  });

  test('Edit note… prompts with the note and saves the new one', () => {
    setSlot(home, TODAY, 'dinner', { kind: 'note', note: 'Pizza night' });
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const { choose } = sheet();
    openSlot(home, TODAY, 'dinner', entries()[0], jest.fn());
    choose(1);

    expect(prompt.mock.calls[0][3]).toBe('plain-text');
    expect(prompt.mock.calls[0][4]).toBe('Pizza night');
    const save = (prompt.mock.calls[0][2] as { text: string; onPress?: (t?: string) => void }[]).find((b) => b.text === 'Save')!;
    save.onPress!('  Taco Tuesday  ');
    expect(slot()).toEqual(['Taco Tuesday']);
  });

  test('Clear empties the slot with an Undo toast; Cancel does nothing', () => {
    setSlot(home, TODAY, 'dinner', { kind: 'note', note: 'Pizza night' });
    const onToast = jest.fn<(toast: SlotToast | null) => void>();
    const { choose } = sheet();
    openSlot(home, TODAY, 'dinner', entries()[0], onToast);

    choose(3);
    expect(slot()).toEqual(['Pizza night']);
    expect(onToast).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();

    choose(2);
    expect(slot()).toEqual([]);
    expect(onToast.mock.calls[0][0]!.message).toBe('Cleared Thursday dinner');
    undo(onToast.mock.calls[0][0]!);
    expect(slot()).toEqual(['Pizza night']);
  });
});

describe('promptNote', () => {
  type Button = { text: string; onPress?: (t?: string) => void };
  const save = (call: unknown[]) => (call[2] as Button[]).find((b) => b.text === 'Save')!.onPress!;

  test('saves the trimmed note; a blank one is dropped', () => {
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const onSave = jest.fn();
    promptNote('', onSave);
    expect(prompt.mock.calls[0].slice(0, 2)).toEqual(['Note', 'Up to 60 characters']);

    save(prompt.mock.calls[0])('   ');
    save(prompt.mock.calls[0])(undefined);
    expect(onSave).not.toHaveBeenCalled();
    save(prompt.mock.calls[0])('  Soup  ');
    expect(onSave).toHaveBeenCalledWith('Soup');
  });

  test('a note over 60 characters asks again with what was typed; 60 is fine', () => {
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const onSave = jest.fn();
    promptNote('', onSave);

    save(prompt.mock.calls[0])('x'.repeat(61));
    expect(onSave).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[1][1]).toBe('That’s 61 characters. Notes are up to 60.');
    expect(prompt.mock.calls[1][4]).toBe('x'.repeat(61));

    save(prompt.mock.calls[1])('x'.repeat(60));
    expect(onSave).toHaveBeenCalledWith('x'.repeat(60));
  });
});
