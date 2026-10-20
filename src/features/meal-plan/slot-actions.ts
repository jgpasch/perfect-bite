// Filling and clearing slots from the week (spec 4.16, board 2 F): an empty slot opens the slot sheet,
// a slot with recipes the meal sheet (board D), and a note a native menu (Replace…, Edit note…, Clear
// with Undo).
import { router } from 'expo-router';
import { ActionSheetIOS, Alert } from 'react-native';

import type { ToastAction } from '@/components/toast';
import type { MealPlanEntry } from '@/db';
import { searchRecipes } from '@/features/recipes/recipe-search';
import { currentLanguage, i18n, type Language } from '@/i18n';
import type { RecipeTags } from '@/shared/recipe-tags';

import type { PlanEntry } from './queries';
import type { Day, Meal } from './week';
import { slotAccessibilityLabel, slotName } from './week-view';
import { clearSlot, NOTE_MAX_LENGTH, restoreEntries, restoreSlot, setSlot } from './write';

/** A toast for the screen showing the week, or null to take it down. */
export type SlotToast = { key: string; message: string; emphasis?: string; actions: ToastAction[] };

/**
 * The slot sheet's recipes: the household's recipes tagged with the meal, or all of them with Show all
 * recipes or while searching (names only, ignoring case and accents, as the Recipes tab), A–Z.
 */
export function slotSheetRecipes<R extends { id: string; name: string; householdId: string; tags: RecipeTags | null }>(
  recipes: readonly R[],
  { householdId, meal, query, showAll }: { householdId: string; meal: Meal; query: string; showAll: boolean },
  language: Language = currentLanguage(),
): R[] {
  const own = recipes.filter((r) => r.householdId === householdId);
  const all = showAll || query.trim() !== '';
  const shown = all ? own : own.filter((r) => (r.tags?.meal ?? []).includes(meal));
  return searchRecipes(shown, [], query)
    .map(({ recipe }) => recipe)
    .sort((a, b) => a.name.localeCompare(b.name, language, { sensitivity: 'base' }));
}

export type SlotMenuAction = 'replace' | 'editNote' | 'clear';

/** A note's menu (Leftovers, Eating out or free text): Replace…, Edit note… (free text) and Clear. */
export function slotMenuActions(kind: PlanEntry['kind']): SlotMenuAction[] {
  return ['replace', ...(kind === 'note' ? (['editNote'] as const) : []), 'clear'];
}

const MENU_LABELS = {
  replace: 'mealPlan.replace',
  editNote: 'mealPlan.editNote',
  clear: 'mealPlan.clear',
} as const satisfies Record<SlotMenuAction, string>;

/**
 * Asks for a free-text note with the system prompt, up to 60 characters. A longer one asks again with
 * what was typed; a blank one is dropped. TODO(M9): Alert.prompt is iOS-only; use a sheet if Android ships.
 */
export function promptNote(current: string, onSave: (note: string) => void, message?: string): void {
  Alert.prompt(
    i18n.t('mealPlan.notePrompt'),
    message ?? i18n.t('mealPlan.noteMessage', { max: NOTE_MAX_LENGTH }),
    [
      { text: i18n.t('common.cancel'), style: 'cancel' },
      {
        text: i18n.t('common.save'),
        isPreferred: true,
        onPress: (text?: string) => {
          const note = text?.trim() ?? '';
          if (!note) return;
          if (note.length > NOTE_MAX_LENGTH) {
            return promptNote(note, onSave, i18n.t('mealPlan.noteTooLong', { count: note.length, max: NOTE_MAX_LENGTH }));
          }
          onSave(note);
        },
      },
    ],
    'plain-text',
    current,
  );
}

/** Opens the slot sheet for the slot (empty, or Replace…). */
export function openSlotSheet(householdId: string, day: Day, meal: Meal): void {
  router.push({ pathname: '/plan-slot', params: { householdId, day, meal } });
}

/** The add sheet (board E): the slot sheet adding a recipe beside the slot's, back to the meal sheet. */
export function openAddSheet(householdId: string, day: Day, meal: Meal): void {
  router.push({ pathname: '/plan-slot', params: { householdId, day, meal, mode: 'add' } });
}

// The meal sheet is a route, so the week that opened it hands over where its Cleared toast goes.
let weekToastTarget: ((toast: SlotToast | null) => void) | null = null;

/** Opens the meal sheet (board D) for a slot with recipes; its Cleared toast shows through `onToast`. */
export function openMealSheet(householdId: string, day: Day, meal: Meal, onToast: (toast: SlotToast | null) => void): void {
  weekToastTarget = onToast;
  router.push({ pathname: '/plan-meal', params: { householdId, day, meal } });
}

/** Shows (or, with null, takes down) a toast on the week that opened the meal sheet; nowhere if none did. */
export function weekToast(toast: SlotToast | null): void {
  weekToastTarget?.(toast);
}

/**
 * "Cleared Thursday dinner" with Undo, which puts the `removed` entries back, taking out whatever has
 * filled the slot since.
 */
export function clearedToast(
  householdId: string,
  day: Day,
  meal: Meal,
  removed: readonly Pick<MealPlanEntry, 'id'>[],
  onToast: (toast: SlotToast | null) => void,
): SlotToast {
  return {
    key: `cleared-${day}-${meal}-${Date.now()}`,
    message: i18n.t('mealPlan.cleared', { slot: slotName(day, meal) }),
    actions: [
      {
        label: i18n.t('common.undo'),
        onPress: () => {
          restoreSlot(householdId, day, meal, removed);
          onToast(null);
        },
      },
    ],
  };
}

/** The meal sheet's "Removed Caesar salad" with Undo, which puts the recipe back in its place. */
export function removedToast(name: string, removed: Pick<MealPlanEntry, 'id'>, onToast: (toast: SlotToast | null) => void): SlotToast {
  return {
    key: `removed-${removed.id}-${Date.now()}`,
    message: i18n.t('mealPlan.removedRecipe', { name }),
    emphasis: name,
    actions: [
      {
        label: i18n.t('common.undo'),
        onPress: () => {
          restoreEntries([removed]);
          onToast(null);
        },
      },
    ],
  };
}

/** Clear: empties the slot and shows "Cleared Thursday dinner" with Undo, which puts every entry back. */
export function clearSlotWithUndo(householdId: string, day: Day, meal: Meal, onToast: (toast: SlotToast | null) => void): void {
  const removed = clearSlot(householdId, day, meal);
  if (removed.length === 0) return;
  onToast(clearedToast(householdId, day, meal, removed, onToast));
}

/**
 * Tapping a slot: the slot sheet when it's empty (past days too), the meal sheet when it holds recipes
 * (`entry` is its first), else the note's native menu.
 */
export function openSlot(
  householdId: string,
  day: Day,
  meal: Meal,
  entry: PlanEntry | null,
  onToast: (toast: SlotToast | null) => void,
): void {
  if (!entry) return openSlotSheet(householdId, day, meal);
  if (entry.kind === 'recipe') return openMealSheet(householdId, day, meal, onToast);
  const actions = slotMenuActions(entry.kind);
  const options = [...actions.map((a) => i18n.t(MENU_LABELS[a])), i18n.t('common.cancel')];
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title: slotAccessibilityLabel(day, meal, entry),
      options,
      destructiveButtonIndex: actions.indexOf('clear'),
      cancelButtonIndex: actions.length,
    },
    (index) => {
      switch (actions[index]) {
        case 'replace':
          return openSlotSheet(householdId, day, meal);
        case 'editNote':
          return promptNote(entry.note ?? '', (note) => void setSlot(householdId, day, meal, { kind: 'note', note }));
        case 'clear':
          return clearSlotWithUndo(householdId, day, meal, onToast);
      }
    },
  );
}
