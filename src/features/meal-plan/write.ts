// Writing the meal plan (spec 4.16), through the sync helpers (outbox, spec 7.1). A slot holds any
// number of recipes, ordered by `position`, or one note. Adding a recipe puts it last and takes out a
// note there; setting a slot soft-deletes its live entries and inserts the new one. Two devices filling
// the same slot offline both keep their rows, and the next note or clear takes them all out.
import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';

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

/**
 * One slot's change for `applyPlanChanges`: an entry to put there (replacing what's there), null to
 * clear it, or a recipe to add beside the slot's recipes.
 */
export type PlanChange = { householdId: string; day: Day; meal: Meal } & (
  | { entry: EntryInput | null }
  | { add: { recipeId: string } }
);

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

/** Throws unless the recipe is a live one of the household. */
function checkRecipe(tx: Exec, householdId: string, recipeId: string): void {
  const recipe = tx
    .select({ householdId: recipes.householdId })
    .from(recipes)
    .where(and(eq(recipes.id, recipeId), isNull(recipes.deletedAt)))
    .get();
  if (recipe?.householdId !== householdId) throw new Error(`Recipe ${recipeId} isn't in household ${householdId}`);
}

function setIn(tx: Exec, householdId: string, day: Day, meal: Meal, entry: EntryInput): MealPlanEntry {
  if (entry.kind === 'recipe') checkRecipe(tx, householdId, entry.recipeId);
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

/** Adds the recipe last; returns the new row and the note it took out, or null when it's already there. */
function addIn(
  tx: Exec,
  householdId: string,
  day: Day,
  meal: Meal,
  recipeId: string,
): { row: MealPlanEntry; removed: MealPlanEntry[] } | null {
  checkRecipe(tx, householdId, recipeId);
  const live = tx.select().from(mealPlanEntries).where(slotWhere(householdId, day, meal)).all();
  if (live.some((e) => e.kind === 'recipe' && e.recipeId === recipeId)) return null;
  const removed = updateRows(tx, mealPlanEntries, and(slotWhere(householdId, day, meal), ne(mealPlanEntries.kind, 'recipe')), {
    deletedAt: new Date(),
  });
  const positions = live.filter((e) => e.kind === 'recipe').map((e) => e.position);
  const row = insertRow(tx, mealPlanEntries, {
    id: newId(),
    householdId,
    planDate: day,
    meal,
    position: positions.length === 0 ? 0 : Math.max(...positions) + 1,
    kind: 'recipe',
    recipeId,
    note: null,
  });
  return { row, removed };
}

/**
 * Adds the recipe to the slot, last, beside its recipes, taking out a note there, in one transaction.
 * Returns the new row, or null (writing nothing) when the recipe is already in the slot.
 */
export function addRecipeToSlot(
  householdId: string,
  day: Day,
  meal: Meal,
  recipeId: string,
  exec: Exec = db,
): MealPlanEntry | null {
  return exec.transaction((tx) => addIn(tx, householdId, day, meal, recipeId)?.row ?? null);
}

/**
 * Puts `entry` in the slot, replacing everything there (a note, or Replace all…), in one transaction.
 * Returns the new row.
 */
export function setSlot(householdId: string, day: Day, meal: Meal, entry: EntryInput, exec: Exec = db): MealPlanEntry {
  return exec.transaction((tx) => setIn(tx, householdId, day, meal, entry));
}

/** Empties the slot. Returns the entries it took out (none for an empty slot), for Undo. */
export function clearSlot(householdId: string, day: Day, meal: Meal, exec: Exec = db): MealPlanEntry[] {
  return exec.transaction((tx) => clearIn(tx, householdId, day, meal));
}

/** Takes one entry out of its slot. Returns it, for Undo, or null (writing nothing) when it isn't live. */
export function removeEntry(entryId: string, exec: Exec = db): MealPlanEntry | null {
  return exec.transaction(
    (tx) =>
      updateRows(tx, mealPlanEntries, and(eq(mealPlanEntries.id, entryId), isNull(mealPlanEntries.deletedAt)), {
        deletedAt: new Date(),
      })[0] ?? null,
  );
}

/** A removal's Undo: puts back the entries `removeEntry` took out, leaving the rest of the slot as it is. */
export function restoreEntries(entries: readonly Pick<MealPlanEntry, 'id'>[], exec: Exec = db): void {
  if (entries.length === 0) return;
  exec.transaction((tx) => {
    updateRows(
      tx,
      mealPlanEntries,
      inArray(
        mealPlanEntries.id,
        entries.map((e) => e.id),
      ),
      { deletedAt: null },
    );
  });
}

/**
 * Moves one of the slot's shown recipes to `toIndex` among them, writing only its `position`: halfway
 * between its new neighbours', or one less than the first or one more than the last. Returns the moved
 * row (unchanged, with nothing written, when it's already there), or null when it isn't one of them.
 */
export function moveEntry(
  householdId: string,
  day: Day,
  meal: Meal,
  entryId: string,
  toIndex: number,
  exec: Exec = db,
): MealPlanEntry | null {
  return exec.transaction((tx) => {
    // The slot's recipes in the order the plan shows them (`weekEntriesQuery`'s, deleted recipes left out).
    const shown = tx
      .select({ entry: mealPlanEntries })
      .from(mealPlanEntries)
      .innerJoin(recipes, eq(recipes.id, mealPlanEntries.recipeId))
      .where(and(slotWhere(householdId, day, meal), eq(mealPlanEntries.kind, 'recipe'), isNull(recipes.deletedAt)))
      .orderBy(asc(mealPlanEntries.position), desc(mealPlanEntries.createdAt), desc(mealPlanEntries.id))
      .all()
      .map((r) => r.entry);
    const from = shown.findIndex((e) => e.id === entryId);
    if (from === -1) return null;
    const to = Math.max(0, Math.min(Math.trunc(toIndex), shown.length - 1));
    if (to === from) return shown[from];
    const others = shown.filter((e) => e.id !== entryId);
    const before = others[to - 1];
    const after = others[to];
    const position = !before ? after.position - 1 : !after ? before.position + 1 : (before.position + after.position) / 2;
    return updateRows(tx, mealPlanEntries, eq(mealPlanEntries.id, entryId), { position })[0];
  });
}

/**
 * Clear's Undo: puts back the entries `clearSlot` took out, taking out whatever has filled the slot
 * since, in one transaction.
 */
export function restoreSlot(
  householdId: string,
  day: Day,
  meal: Meal,
  entries: readonly Pick<MealPlanEntry, 'id'>[],
  exec: Exec = db,
): void {
  if (entries.length === 0) return;
  exec.transaction((tx) => {
    clearIn(tx, householdId, day, meal);
    updateRows(
      tx,
      mealPlanEntries,
      inArray(
        mealPlanEntries.id,
        entries.map((e) => e.id),
      ),
      { deletedAt: null },
    );
  });
}

/** What `applyPlanChanges` wrote: the rows it put in and the ones it took out, for `undoPlanChanges`. */
export type AppliedPlanChanges = { added: MealPlanEntry[]; removed: MealPlanEntry[] };

/**
 * Every slot's change in one transaction, in order (the plan modal's Done, the slot sheet's Add). Nothing is
 * written if one fails. Returns what it wrote, for Undo.
 */
export function applyPlanChanges(changes: readonly PlanChange[], exec: Exec = db): AppliedPlanChanges {
  const applied: AppliedPlanChanges = { added: [], removed: [] };
  if (changes.length === 0) return applied;
  exec.transaction((tx) => {
    for (const change of changes) {
      const { householdId, day, meal } = change;
      if ('add' in change) {
        const done = addIn(tx, householdId, day, meal, change.add.recipeId);
        if (done) {
          applied.added.push(done.row);
          applied.removed.push(...done.removed);
        }
      } else {
        // Cleared here to keep what went; setIn's own clear then finds the slot empty.
        applied.removed.push(...clearIn(tx, householdId, day, meal));
        if (change.entry) applied.added.push(setIn(tx, householdId, day, meal, change.entry));
      }
    }
  });
  return applied;
}

/**
 * Undo for `applyPlanChanges`: takes out the rows it put in and puts back the ones it took out, in one
 * transaction, so the slots read as they did before. Anything else written since is left as it is.
 */
export function undoPlanChanges({ added, removed }: AppliedPlanChanges, exec: Exec = db): void {
  if (added.length === 0 && removed.length === 0) return;
  exec.transaction((tx) => {
    if (added.length > 0) {
      updateRows(
        tx,
        mealPlanEntries,
        and(
          inArray(
            mealPlanEntries.id,
            added.map((e) => e.id),
          ),
          isNull(mealPlanEntries.deletedAt),
        ),
        { deletedAt: new Date() },
      );
    }
    // A row added and taken out again in the same batch stays out.
    const addedIds = new Set(added.map((e) => e.id));
    const back = removed.filter((e) => !addedIds.has(e.id));
    if (back.length > 0) {
      updateRows(
        tx,
        mealPlanEntries,
        inArray(
          mealPlanEntries.id,
          back.map((e) => e.id),
        ),
        { deletedAt: null },
      );
    }
  });
}
