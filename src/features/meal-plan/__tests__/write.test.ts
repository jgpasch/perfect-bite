// Writing the meal plan (spec 4.16): Undo after clears, removals and batches, and moves, beyond
// the single-call cases in plan.test.ts.
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, mealPlanEntries } from '@/db';
import { ensureStarterData, getDefaultListId, getList } from '@/features/lists/lists';
import { createRecipe, deleteRecipe } from '@/features/recipes/recipes';
import { resetDb } from '@/test/db';
import { clearOutbox, outboxMutations, outboxPatches } from '@/test/outbox';

import { groupWeek, weekEntriesQuery } from '../queries';
import {
  addRecipeToSlot,
  applyPlanChanges,
  clearSlot,
  moveEntry,
  removeEntry,
  restoreEntries,
  restoreSlot,
  setSlot,
  undoPlanChanges,
} from '../write';

jest.mock('@/db/client', () => require('@/test/db'));

const USER = 'user-1';
const DAY = '2026-10-15';
let home: string;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  home = getList(getDefaultListId(USER)!)!.householdId;
  clearOutbox();
});

/** What the plan shows in the slot: recipe names, or the note's kind/text. */
const slot = (day = DAY, meal: 'breakfast' | 'lunch' | 'dinner' = 'dinner') =>
  groupWeek(weekEntriesQuery(home, '2026-10-11').all())
    .slotEntries(day, meal)
    .map((e) => e.recipeName ?? e.note ?? e.kind);

const recipe = (name: string) => createRecipe(name, home);
const add = (name: string, meal: 'breakfast' | 'lunch' | 'dinner' = 'dinner') =>
  addRecipeToSlot(home, DAY, meal, recipe(name))!;

/** An entry as a pull from another device writes it: no outbox, its own position and creation time. */
function pulled(id: string, recipeId: string, position: number, createdAt: string) {
  db.insert(mealPlanEntries)
    .values({ id, householdId: home, planDate: DAY, meal: 'dinner', kind: 'recipe', recipeId, position, createdAt: new Date(createdAt) })
    .run();
}

describe('clearSlot and restoreSlot', () => {
  test("Undo after a clear puts every recipe back in its order, with one mutation each", () => {
    add('A');
    add('B');
    add('C');
    const removed = clearSlot(home, DAY, 'dinner');
    expect(slot()).toEqual([]);
    clearOutbox();

    restoreSlot(home, DAY, 'dinner', removed);

    expect(slot()).toEqual(['A', 'B', 'C']);
    expect(outboxPatches().map((m) => m.fields)).toEqual([{ deleted_at: null }, { deleted_at: null }, { deleted_at: null }]);
    expect(outboxPatches().map((m) => m.id).sort()).toEqual(removed.map((e) => e.id).sort());
  });

  test('Undo after a clear takes out whatever filled the slot since', () => {
    setSlot(home, DAY, 'dinner', { kind: 'note', note: 'Pizza night' });
    const removed = clearSlot(home, DAY, 'dinner');
    const since = add('Tacos');

    restoreSlot(home, DAY, 'dinner', removed);

    expect(slot()).toEqual(['Pizza night']);
    expect(db.select().from(mealPlanEntries).where(eq(mealPlanEntries.id, since.id)).get()!.deletedAt).not.toBeNull();
  });

  test('restoreSlot leaves other slots alone', () => {
    add('A');
    add('B', 'lunch');
    const removed = clearSlot(home, DAY, 'dinner');
    restoreSlot(home, DAY, 'dinner', removed);
    expect(slot(DAY, 'lunch')).toEqual(['B']);
  });

  test('restoring an empty clear writes nothing, even over a filled slot', () => {
    expect(clearSlot(home, DAY, 'dinner')).toEqual([]);
    add('A');
    clearOutbox();
    restoreSlot(home, DAY, 'dinner', []);
    expect(slot()).toEqual(['A']);
    expect(outboxMutations()).toEqual([]);
  });

  test('a clear only takes live entries, so its Undo never brings back one removed earlier', () => {
    const a = add('A');
    add('B');
    removeEntry(a.id);
    const removed = clearSlot(home, DAY, 'dinner');
    expect(removed.map((e) => e.id)).not.toContain(a.id);
    restoreSlot(home, DAY, 'dinner', removed);
    expect(slot()).toEqual(['B']);
  });
});

describe('removeEntry and restoreEntries', () => {
  test('two removals undone in reverse order put both back in their places', () => {
    add('A');
    const b = add('B');
    const c = add('C');
    const outB = removeEntry(b.id)!;
    const outC = removeEntry(c.id)!;
    expect(slot()).toEqual(['A']);

    restoreEntries([outC]);
    restoreEntries([outB]);
    expect(slot()).toEqual(['A', 'B', 'C']);
  });

  test('a removed entry comes back where it was after the others moved', () => {
    const a = add('A');
    const b = add('B');
    add('C');
    removeEntry(b.id);
    moveEntry(home, DAY, 'dinner', a.id, 1);
    expect(slot()).toEqual(['C', 'A']);

    restoreEntries([b]);
    // B keeps its own position (1): before C (2) and A, which moved past C (3).
    expect(slot()).toEqual(['B', 'C', 'A']);
  });
});

describe('moveEntry', () => {
  test('a series of moves keeps every recipe and lands each where asked', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'].map((n) => add(n).id);
    const [a, b, , d, e] = ids;
    const move = (id: string, to: number) => moveEntry(home, DAY, 'dinner', id, to);

    move(e, 0);
    expect(slot()).toEqual(['E', 'A', 'B', 'C', 'D']);
    move(a, 3);
    expect(slot()).toEqual(['E', 'B', 'C', 'A', 'D']);
    move(d, 1);
    expect(slot()).toEqual(['E', 'D', 'B', 'C', 'A']);
    move(b, 4);
    expect(slot()).toEqual(['E', 'D', 'C', 'A', 'B']);
  });

  test('moving into the same gap again and again keeps the order (positions keep halving)', () => {
    const [a, , c] = ['A', 'B', 'C'].map((n) => add(n).id);
    for (let i = 0; i < 30; i++) {
      moveEntry(home, DAY, 'dinner', i % 2 === 0 ? c : a, 1);
    }
    expect(slot()).toHaveLength(3);
    expect(new Set(slot())).toEqual(new Set(['A', 'B', 'C']));
    moveEntry(home, DAY, 'dinner', c, 1);
    expect(slot()[1]).toBe('C');
  });

  test('a fractional index is truncated', () => {
    const [, , c] = ['A', 'B', 'C'].map((n) => add(n).id);
    moveEntry(home, DAY, 'dinner', c, 1.9);
    expect(slot()).toEqual(['A', 'C', 'B']);
  });

  test("an entry of another slot is not moved", () => {
    add('A');
    const lunch = add('B', 'lunch');
    clearOutbox();
    expect(moveEntry(home, DAY, 'dinner', lunch.id, 0)).toBeNull();
    expect(outboxMutations()).toEqual([]);
  });

  test('a single recipe stays where it is, with nothing written', () => {
    const a = add('A');
    clearOutbox();
    expect(moveEntry(home, DAY, 'dinner', a.id, 5)!.id).toBe(a.id);
    expect(outboxMutations()).toEqual([]);
  });

  test('a removed entry is not moved', () => {
    add('A');
    const b = add('B');
    removeEntry(b.id);
    clearOutbox();
    expect(moveEntry(home, DAY, 'dinner', b.id, 0)).toBeNull();
    expect(outboxMutations()).toEqual([]);
  });

  test('between two recipes two devices added at the same position, it lands where asked', () => {
    const x = recipe('X');
    const y = recipe('Y');
    // Two devices each added a first recipe offline: both at 0. Y's is newer, so it shows first.
    pulled('e-x', x, 0, '2026-10-10T12:00:00Z');
    pulled('e-y', y, 0, '2026-10-10T12:00:05Z');
    const z = add('Z');
    expect(slot()).toEqual(['Y', 'X', 'Z']);
    clearOutbox();

    // Halfway would be 0 again, sorting Z first by its creation time: the slot is numbered afresh.
    expect(moveEntry(home, DAY, 'dinner', z.id, 1)!).toMatchObject({ id: z.id, position: 1 });
    expect(slot()).toEqual(['Y', 'Z', 'X']);
    // Y already sat at 0 and Z (added one past them) at 1, so only X is written.
    expect(outboxPatches()).toEqual([{ table: 'meal_plan_entries', id: 'e-x', fields: { position: 2 } }]);
  });

  test('a gap halved until no number fits between its neighbours is numbered afresh', () => {
    const x = recipe('X');
    const y = recipe('Y');
    // Neighbours a float apart: their halfway point rounds to one of them.
    pulled('e-x', x, 1, '2026-10-10T12:00:00Z');
    pulled('e-y', y, 1 + Number.EPSILON, '2026-10-10T12:00:05Z');
    const z = add('Z');
    expect(slot()).toEqual(['X', 'Y', 'Z']);

    moveEntry(home, DAY, 'dinner', z.id, 1);
    expect(slot()).toEqual(['X', 'Z', 'Y']);
    expect(db.select().from(mealPlanEntries).all().map((e) => [e.id === z.id ? 'Z' : e.id, e.position]).sort()).toEqual([
      ['Z', 1],
      ['e-x', 0],
      ['e-y', 2],
    ]);
  });

  test('moving one of two recipes at the same position past the other works', () => {
    const x = recipe('X');
    const y = recipe('Y');
    pulled('e-x', x, 0, '2026-10-10T12:00:00Z');
    pulled('e-y', y, 0, '2026-10-10T12:00:05Z');
    expect(slot()).toEqual(['Y', 'X']);

    moveEntry(home, DAY, 'dinner', 'e-y', 1);
    expect(slot()).toEqual(['X', 'Y']);
    moveEntry(home, DAY, 'dinner', 'e-y', 0);
    expect(slot()).toEqual(['Y', 'X']);
  });

  test("a deleted recipe's entry keeps its position and doesn't block a move", () => {
    const a = add('A');
    const gone = add('Gone');
    add('C');
    deleteRecipe(gone.recipeId!);
    moveEntry(home, DAY, 'dinner', a.id, 1);
    expect(slot()).toEqual(['C', 'A']);
  });
});

describe('applyPlanChanges and undoPlanChanges', () => {
  test('a Replace over recipes, undone, brings the old recipes back in order and takes out the new ones', () => {
    add('A');
    add('B');
    const c = recipe('C');
    const applied = applyPlanChanges([
      { householdId: home, day: DAY, meal: 'dinner', entry: null },
      { householdId: home, day: DAY, meal: 'dinner', add: { recipeId: c } },
    ]);
    expect(slot()).toEqual(['C']);
    expect(applied.added.map((e) => e.recipeId)).toEqual([c]);
    expect(applied.removed).toHaveLength(2);

    undoPlanChanges(applied);
    expect(slot()).toEqual(['A', 'B']);
  });

  test('setting a note over recipes, undone, brings the recipes back and the note goes', () => {
    add('A');
    add('B');
    const applied = applyPlanChanges([{ householdId: home, day: DAY, meal: 'dinner', entry: { kind: 'note', note: 'Out' } }]);
    expect(slot()).toEqual(['Out']);
    undoPlanChanges(applied);
    expect(slot()).toEqual(['A', 'B']);
  });

  test('changes across slots undo together, each slot back as it was', () => {
    setSlot(home, DAY, 'lunch', { kind: 'leftovers' });
    add('A');
    const b = recipe('B');
    const applied = applyPlanChanges([
      { householdId: home, day: DAY, meal: 'lunch', add: { recipeId: b } },
      { householdId: home, day: DAY, meal: 'dinner', entry: null },
      { householdId: home, day: DAY, meal: 'breakfast', entry: { kind: 'eating-out' } },
    ]);
    expect([slot(DAY, 'breakfast'), slot(DAY, 'lunch'), slot()]).toEqual([['eating-out'], ['B'], []]);

    undoPlanChanges(applied);
    expect([slot(DAY, 'breakfast'), slot(DAY, 'lunch'), slot()]).toEqual([[], ['leftovers'], ['A']]);
  });

  test('a set followed by a clear of the same slot in one batch: its Undo brings back only what was there', () => {
    add('A');
    const applied = applyPlanChanges([
      { householdId: home, day: DAY, meal: 'dinner', entry: { kind: 'leftovers' } },
      { householdId: home, day: DAY, meal: 'dinner', entry: null },
    ]);
    expect(slot()).toEqual([]);
    clearOutbox();

    undoPlanChanges(applied);
    expect(slot()).toEqual(['A']);
    // The leftovers row was already out: only A is written.
    expect(outboxPatches()).toEqual([{ table: 'meal_plan_entries', id: expect.any(String), fields: { deleted_at: null } }]);
  });

  test('undoing twice is the same as once', () => {
    add('A');
    const applied = applyPlanChanges([{ householdId: home, day: DAY, meal: 'dinner', add: { recipeId: recipe('B') } }]);
    undoPlanChanges(applied);
    clearOutbox();
    undoPlanChanges(applied);
    expect(slot()).toEqual(['A']);
    expect(outboxMutations()).toEqual([]);
  });
});
