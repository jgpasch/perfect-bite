// Writing the meal plan (spec 4.16), through the sync helpers (outbox, spec 7.1). Setting a slot
// soft-deletes its live entries and inserts the new one, so two devices filling the same slot
// offline both keep their rows (the slot shows the newer), and the next change clears both.
import { and, eq, isNull } from 'drizzle-orm';

import { db, mealPlanEntries, recipes, type MealPlanEntry } from '@/db';
import { newId } from '@/lib/id';
import type { Exec } from '@/sync/clock';
import { insertRow, updateRows } from '@/sync/mutate';

import type { Day, Meal } from './week';

/** The longest note (spec 5). */
export const NOTE_MAX_LENGTH = 60;

/** What goes in a slot: a recipe of the household, Leftovers, Eating out or a free-text note. */
export type EntryInput =
  | { kind: 'recipe'; recipeId: string }
  | { kind: 'leftovers' }
  | { kind: 'eating-out' }
  | { kind: 'note'; note: string };

/** One slot's change for `applyPlanChanges`: an entry to put there, or null to clear it. */
export type PlanChange = { householdId: string; day: Day; meal: Meal; entry: EntryInput | null };

/** The note as stored: trimmed, 1 to 60 characters, kept as typed. Throws otherwise. */
export function cleanNote(note: string): string {
  const trimmed = note.trim();
  if (trimmed.length === 0 || trimmed.length > NOTE_MAX_LENGTH) {
    throw new Error(`A note is 1 to ${NOTE_MAX_LENGTH} characters`);
  }
  return trimmed;
}

const slotWhere = (householdId: string, day: Day, meal: Meal) =>
  and(
    eq(mealPlanEntries.householdId, householdId),
    eq(mealPlanEntries.planDate, day),
    eq(mealPlanEntries.meal, meal),
    isNull(mealPlanEntries.deletedAt),
  );

function clearIn(tx: Exec, householdId: string, day: Day, meal: Meal): MealPlanEntry[] {
  return updateRows(tx, mealPlanEntries, slotWhere(householdId, day, meal), { deletedAt: new Date() });
}

function setIn(tx: Exec, householdId: string, day: Day, meal: Meal, entry: EntryInput): MealPlanEntry {
  if (entry.kind === 'recipe') {
    const recipe = tx
      .select({ householdId: recipes.householdId })
      .from(recipes)
      .where(and(eq(recipes.id, entry.recipeId), isNull(recipes.deletedAt)))
      .get();
    if (recipe?.householdId !== householdId) throw new Error(`Recipe ${entry.recipeId} isn't in household ${householdId}`);
  }
  const note = entry.kind === 'note' ? cleanNote(entry.note) : null;
  clearIn(tx, householdId, day, meal);
  return insertRow(tx, mealPlanEntries, {
    id: newId(),
    householdId,
    planDate: day,
    meal,
    position: 0,
    kind: entry.kind,
    recipeId: entry.kind === 'recipe' ? entry.recipeId : null,
    note,
  });
}

/** Puts `entry` in the slot, replacing what's there, in one transaction. Returns the new row. */
export function setSlot(householdId: string, day: Day, meal: Meal, entry: EntryInput, exec: Exec = db): MealPlanEntry {
  return exec.transaction((tx) => setIn(tx, householdId, day, meal, entry));
}

/** Empties the slot. Returns the entries it took out (none for an empty slot), for Undo. */
export function clearSlot(householdId: string, day: Day, meal: Meal, exec: Exec = db): MealPlanEntry[] {
  return exec.transaction((tx) => clearIn(tx, householdId, day, meal));
}

/** The plan modal's Done: every slot's change in one transaction, in order. Nothing is written if one fails. */
export function applyPlanChanges(changes: readonly PlanChange[], exec: Exec = db): void {
  if (changes.length === 0) return;
  exec.transaction((tx) => {
    for (const { householdId, day, meal, entry } of changes) {
      if (entry) setIn(tx, householdId, day, meal, entry);
      else clearIn(tx, householdId, day, meal);
    }
  });
}
