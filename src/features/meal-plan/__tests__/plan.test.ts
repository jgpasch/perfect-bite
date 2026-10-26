import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, households, mealPlanEntries, outbox, recipes } from '@/db';
import { ensureStarterData, getDefaultListId, getList } from '@/features/lists/lists';
import { createRecipe, deleteRecipe } from '@/features/recipes/recipes';
import { resetDb } from '@/test/db';
import { clearOutbox, outboxMutations } from '@/test/outbox';

import { groupWeek, restOfWeekEntriesQuery, upcomingRecipeEntriesQuery, weekEntriesQuery, type PlanEntry } from '../queries';
import {
  addRecipeToSlot,
  applyPlanChanges,
  cleanNote,
  clearSlot,
  moveEntry,
  removeEntry,
  restoreEntries,
  setSlot,
  undoPlanChanges,
} from '../write';

jest.mock('@/db/client', () => require('@/test/db'));

const USER = 'user-1';
const CABIN = 'cabin';
let home: string;
let tacos: string;
let soup: string;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  home = getList(getDefaultListId(USER)!)!.householdId;
  db.insert(households).values({ id: CABIN, name: 'Cabin' }).run();
  tacos = createRecipe('Tacos', home);
  soup = createRecipe('Soup', home);
  clearOutbox();
});

/** An entry as a pull would write it: no outbox, with its own `created_at`. */
function pulledEntry(id: string, values: Partial<typeof mealPlanEntries.$inferInsert>) {
  db.insert(mealPlanEntries)
    .values({
      id,
      householdId: home,
      planDate: '2026-10-15',
      meal: 'dinner',
      kind: 'leftovers',
      createdAt: new Date('2026-10-10T12:00:00Z'),
      ...values,
    })
    .run();
}

const week = (householdId = home, start = '2026-10-11') => weekEntriesQuery(householdId, start).all();
const shown = (entries: PlanEntry[], day: string, meal: 'breakfast' | 'lunch' | 'dinner') =>
  groupWeek(entries).slotEntries(day, meal);
const entryRows = () => db.select().from(mealPlanEntries).all();

describe('weekEntriesQuery and groupWeek', () => {
  test("groups the week's live entries by slot, with their recipes", () => {
    setSlot(home, '2026-10-15', 'dinner', { kind: 'recipe', recipeId: tacos });
    setSlot(home, '2026-10-15', 'lunch', { kind: 'leftovers' });
    setSlot(home, '2026-10-11', 'breakfast', { kind: 'note', note: 'Pancakes' });
    setSlot(home, '2026-10-17', 'dinner', { kind: 'eating-out' });

    const entries = week();
    expect(entries.map((e) => [e.planDate, e.meal, e.kind])).toEqual([
      ['2026-10-11', 'breakfast', 'note'],
      ['2026-10-15', 'lunch', 'leftovers'],
      ['2026-10-15', 'dinner', 'recipe'],
      ['2026-10-17', 'dinner', 'eating-out'],
    ]);
    expect(shown(entries, '2026-10-15', 'dinner')).toEqual([
      expect.objectContaining({ kind: 'recipe', recipeId: tacos, recipeName: 'Tacos', note: null, householdId: home }),
    ]);
    expect(shown(entries, '2026-10-11', 'breakfast')).toEqual([
      expect.objectContaining({ kind: 'note', note: 'Pancakes', recipeId: null, recipeName: null }),
    ]);
    expect(shown(entries, '2026-10-15', 'breakfast')).toEqual([]);
    expect(shown(entries, '2026-10-18', 'dinner')).toEqual([]);
  });

  test('only the week asked for, from Sunday to Saturday, whichever day names it', () => {
    setSlot(home, '2026-10-10', 'dinner', { kind: 'leftovers' }); // the Saturday before
    setSlot(home, '2026-10-11', 'dinner', { kind: 'leftovers' });
    setSlot(home, '2026-10-17', 'dinner', { kind: 'leftovers' });
    setSlot(home, '2026-10-18', 'dinner', { kind: 'leftovers' }); // the Sunday after

    expect(week(home, '2026-10-11').map((e) => e.planDate)).toEqual(['2026-10-11', '2026-10-17']);
    expect(week(home, '2026-10-14').map((e) => e.planDate)).toEqual(['2026-10-11', '2026-10-17']);
    expect(week(home, '2026-10-18').map((e) => e.planDate)).toEqual(['2026-10-18']);
  });

  test("only the household's entries", () => {
    setSlot(home, '2026-10-15', 'dinner', { kind: 'leftovers' });
    setSlot(CABIN, '2026-10-15', 'dinner', { kind: 'eating-out' });

    expect(week(home).map((e) => e.kind)).toEqual(['leftovers']);
    expect(week(CABIN).map((e) => e.kind)).toEqual(['eating-out']);
  });

  test('a slot with two live rows (filled on two devices offline) shows the one created last first', () => {
    pulledEntry('e-older', { kind: 'recipe', recipeId: tacos, createdAt: new Date('2026-10-12T08:00:00Z') });
    pulledEntry('e-newer', { kind: 'recipe', recipeId: soup, createdAt: new Date('2026-10-12T09:00:00Z') });

    const slot = shown(week(), '2026-10-15', 'dinner');
    expect(slot.map((e) => [e.id, e.recipeName])).toEqual([
      ['e-newer', 'Soup'],
      ['e-older', 'Tacos'],
    ]);

    // The next change to the slot clears both.
    setSlot(home, '2026-10-15', 'dinner', { kind: 'leftovers' });
    expect(shown(week(), '2026-10-15', 'dinner').map((e) => e.kind)).toEqual(['leftovers']);
    expect(entryRows().filter((e) => e.deletedAt === null)).toHaveLength(1);
  });

  test('within a slot, position orders before creation time', () => {
    pulledEntry('first', { kind: 'recipe', recipeId: tacos, position: 0, createdAt: new Date('2026-10-12T08:00:00Z') });
    pulledEntry('second', { kind: 'recipe', recipeId: soup, position: 1, createdAt: new Date('2026-10-12T09:00:00Z') });

    expect(shown(week(), '2026-10-15', 'dinner').map((e) => e.id)).toEqual(['first', 'second']);
  });

  test('a slot with live recipes shows only them, by position; a stray note there is ignored', () => {
    pulledEntry('note', { kind: 'note', note: 'Pizza night', createdAt: new Date('2026-10-12T10:00:00Z') });
    pulledEntry('soup', { kind: 'recipe', recipeId: soup, position: 2, createdAt: new Date('2026-10-12T08:00:00Z') });
    pulledEntry('tacos', { kind: 'recipe', recipeId: tacos, position: 1, createdAt: new Date('2026-10-12T09:00:00Z') });

    expect(shown(week(), '2026-10-15', 'dinner').map((e) => [e.id, e.recipeName])).toEqual([
      ['tacos', 'Tacos'],
      ['soup', 'Soup'],
    ]);
  });

  test('a slot whose only recipe was deleted shows its stray note', () => {
    pulledEntry('note', { kind: 'note', note: 'Pizza night' });
    pulledEntry('tacos', { kind: 'recipe', recipeId: tacos });
    deleteRecipe(tacos);

    expect(shown(week(), '2026-10-15', 'dinner').map((e) => e.note)).toEqual(['Pizza night']);
  });

  test('a slot with two notes shows only the one created last, whatever their positions', () => {
    pulledEntry('older', { kind: 'note', note: 'Pizza', position: 0, createdAt: new Date('2026-10-12T08:00:00Z') });
    pulledEntry('newer', { kind: 'eating-out', position: 5, createdAt: new Date('2026-10-12T09:00:00Z') });
    pulledEntry('oldest', { kind: 'leftovers', position: -1, createdAt: new Date('2026-10-11T08:00:00Z') });

    expect(shown(week(), '2026-10-15', 'dinner').map((e) => e.id)).toEqual(['newer']);
  });

  test('two notes created at the same moment: the larger id shows, as the query orders them', () => {
    pulledEntry('note-a', { kind: 'note', note: 'A' });
    pulledEntry('note-b', { kind: 'note', note: 'B' });

    expect(shown(week(), '2026-10-15', 'dinner').map((e) => e.id)).toEqual(['note-b']);
  });

  test("a deleted recipe's entries drop out, so the slot reads as empty; notes stay", () => {
    setSlot(home, '2026-10-15', 'dinner', { kind: 'recipe', recipeId: tacos });
    setSlot(home, '2026-10-16', 'dinner', { kind: 'recipe', recipeId: soup });
    setSlot(home, '2026-10-16', 'lunch', { kind: 'leftovers' });

    deleteRecipe(tacos);

    const entries = week();
    expect(shown(entries, '2026-10-15', 'dinner')).toEqual([]);
    expect(shown(entries, '2026-10-16', 'dinner').map((e) => e.recipeName)).toEqual(['Soup']);
    expect(shown(entries, '2026-10-16', 'lunch').map((e) => e.kind)).toEqual(['leftovers']);
    // The entry itself is untouched; only hidden.
    expect(db.select().from(mealPlanEntries).where(eq(mealPlanEntries.recipeId, tacos)).get()!.deletedAt).toBeNull();
  });

  test("with two live rows, a deleted recipe's newer row drops out and the older one shows", () => {
    pulledEntry('e-older', { kind: 'recipe', recipeId: soup, createdAt: new Date('2026-10-12T08:00:00Z') });
    pulledEntry('e-newer', { kind: 'recipe', recipeId: tacos, createdAt: new Date('2026-10-12T09:00:00Z') });
    deleteRecipe(tacos);

    expect(shown(week(), '2026-10-15', 'dinner').map((e) => e.id)).toEqual(['e-older']);
  });

  test('cleared entries are not shown', () => {
    setSlot(home, '2026-10-15', 'dinner', { kind: 'leftovers' });
    clearSlot(home, '2026-10-15', 'dinner');
    expect(week()).toEqual([]);
  });
});

describe('upcomingRecipeEntriesQuery', () => {
  test("the recipe's live entries from today on, soonest first, meals in day order", () => {
    setSlot(home, '2026-10-14', 'dinner', { kind: 'recipe', recipeId: tacos }); // yesterday
    setSlot(home, '2026-10-22', 'lunch', { kind: 'recipe', recipeId: tacos });
    setSlot(home, '2026-10-15', 'dinner', { kind: 'recipe', recipeId: tacos });
    setSlot(home, '2026-10-15', 'breakfast', { kind: 'recipe', recipeId: tacos });
    setSlot(home, '2026-10-16', 'dinner', { kind: 'recipe', recipeId: soup });
    setSlot(home, '2026-10-17', 'dinner', { kind: 'recipe', recipeId: tacos });
    clearSlot(home, '2026-10-17', 'dinner');

    expect(
      upcomingRecipeEntriesQuery(tacos, '2026-10-15')
        .all()
        .map((e) => [e.planDate, e.meal]),
    ).toEqual([
      ['2026-10-15', 'breakfast'],
      ['2026-10-15', 'dinner'],
      ['2026-10-22', 'lunch'],
    ]);
  });

  test('none once the recipe is deleted', () => {
    setSlot(home, '2026-10-15', 'dinner', { kind: 'recipe', recipeId: tacos });
    deleteRecipe(tacos);
    expect(upcomingRecipeEntriesQuery(tacos, '2026-10-15').all()).toEqual([]);
  });
});

describe('restOfWeekEntriesQuery', () => {
  test("every household's live entries from today through Saturday, by day then meal", () => {
    const pie = createRecipe('Pie', CABIN);
    setSlot(home, '2026-10-14', 'dinner', { kind: 'recipe', recipeId: tacos }); // yesterday
    setSlot(home, '2026-10-15', 'dinner', { kind: 'recipe', recipeId: tacos });
    setSlot(CABIN, '2026-10-15', 'breakfast', { kind: 'recipe', recipeId: pie });
    setSlot(home, '2026-10-16', 'lunch', { kind: 'note', note: 'Pizza night' });
    setSlot(home, '2026-10-17', 'dinner', { kind: 'recipe', recipeId: soup }); // Saturday, kept
    setSlot(home, '2026-10-18', 'dinner', { kind: 'recipe', recipeId: soup }); // next Sunday
    setSlot(home, '2026-10-16', 'dinner', { kind: 'recipe', recipeId: soup });
    clearSlot(home, '2026-10-16', 'dinner');

    expect(
      restOfWeekEntriesQuery('2026-10-15')
        .all()
        .map((e) => [e.householdId === CABIN ? 'cabin' : 'home', e.planDate, e.meal, e.kind, e.recipeName]),
    ).toEqual([
      ['cabin', '2026-10-15', 'breakfast', 'recipe', 'Pie'],
      ['home', '2026-10-15', 'dinner', 'recipe', 'Tacos'],
      ['home', '2026-10-16', 'lunch', 'note', null],
      ['home', '2026-10-17', 'dinner', 'recipe', 'Soup'],
    ]);
  });

  test("a deleted recipe's entry is left out; on Saturday only Saturday is left", () => {
    setSlot(home, '2026-10-17', 'dinner', { kind: 'recipe', recipeId: tacos });
    setSlot(home, '2026-10-17', 'lunch', { kind: 'recipe', recipeId: soup });
    deleteRecipe(soup);
    expect(restOfWeekEntriesQuery('2026-10-17').all().map((e) => [e.planDate, e.meal])).toEqual([['2026-10-17', 'dinner']]);
    expect(restOfWeekEntriesQuery('2026-10-18').all()).toEqual([]);
  });
});

describe('setSlot', () => {
  test('inserts the entry and sends it whole, without added_by', () => {
    const row = setSlot(home, '2026-10-15', 'dinner', { kind: 'recipe', recipeId: tacos });

    expect(row).toMatchObject({
      householdId: home,
      planDate: '2026-10-15',
      meal: 'dinner',
      position: 0,
      kind: 'recipe',
      recipeId: tacos,
      note: null,
      deletedAt: null,
      addedBy: null,
    });
    expect(outboxMutations()).toEqual([
      {
        table: 'meal_plan_entries',
        id: row.id,
        hlc: expect.any(String),
        fields: {
          household_id: home,
          plan_date: '2026-10-15',
          meal: 'dinner',
          position: 0,
          kind: 'recipe',
          recipe_id: tacos,
          note: null,
          deleted_at: null,
          created_at: row.createdAt.toISOString(),
        },
      },
    ]);
    expect(db.select().from(outbox).get()!.householdId).toBe(home);
  });

  test("replacing soft-deletes the slot's live entries and inserts the new one, in that order", () => {
    const first = setSlot(home, '2026-10-15', 'dinner', { kind: 'recipe', recipeId: tacos });
    clearOutbox();

    const second = setSlot(home, '2026-10-15', 'dinner', { kind: 'note', note: '  Pizza night ' });

    const mutations = outboxMutations();
    expect(mutations.map((m) => [m.id, Object.keys(m.fields)])).toEqual([
      [first.id, ['deleted_at']],
      [second.id, expect.arrayContaining(['kind', 'note', 'recipe_id'])],
    ]);
    expect(mutations[1].fields).toMatchObject({ kind: 'note', note: 'Pizza night', recipe_id: null });
    // One transaction, so one clock tick for each write in it, in order.
    expect(mutations[0].hlc < mutations[1].hlc).toBe(true);
    expect(db.select().from(mealPlanEntries).where(eq(mealPlanEntries.id, first.id)).get()!.deletedAt).toBeInstanceOf(Date);
    expect(second).toMatchObject({ kind: 'note', note: 'Pizza night', recipeId: null });
  });

  test("leaves other slots, days and households alone", () => {
    setSlot(home, '2026-10-15', 'lunch', { kind: 'leftovers' });
    setSlot(home, '2026-10-16', 'dinner', { kind: 'leftovers' });
    setSlot(CABIN, '2026-10-15', 'dinner', { kind: 'leftovers' });
    clearOutbox();

    setSlot(home, '2026-10-15', 'dinner', { kind: 'eating-out' });

    expect(outboxMutations()).toHaveLength(1);
    expect(entryRows().filter((e) => e.deletedAt === null)).toHaveLength(4);
  });

  test('refuses a recipe from another household, or a deleted one, and writes nothing', () => {
    const chili = createRecipe('Chili', CABIN);
    setSlot(home, '2026-10-15', 'dinner', { kind: 'leftovers' });
    deleteRecipe(soup);
    clearOutbox();
    const before = entryRows();

    expect(() => setSlot(home, '2026-10-15', 'dinner', { kind: 'recipe', recipeId: chili })).toThrow(
      `Recipe ${chili} isn't in household ${home}`,
    );
    expect(() => setSlot(home, '2026-10-15', 'dinner', { kind: 'recipe', recipeId: soup })).toThrow("isn't in household");
    expect(() => setSlot(home, '2026-10-15', 'dinner', { kind: 'recipe', recipeId: 'missing' })).toThrow("isn't in household");
    expect(entryRows()).toEqual(before);
    expect(outboxMutations()).toEqual([]);
  });

  test('refuses an empty or too long note and writes nothing', () => {
    setSlot(home, '2026-10-15', 'dinner', { kind: 'leftovers' });
    clearOutbox();

    expect(() => setSlot(home, '2026-10-15', 'dinner', { kind: 'note', note: '   ' })).toThrow('A note is 1 to 60 characters');
    expect(() => setSlot(home, '2026-10-15', 'dinner', { kind: 'note', note: 'x'.repeat(61) })).toThrow(
      'A note is 1 to 60 characters',
    );
    expect(outboxMutations()).toEqual([]);
    expect(shown(week(), '2026-10-15', 'dinner').map((e) => e.kind)).toEqual(['leftovers']);
  });
});

describe('addRecipeToSlot', () => {
  const names = () => shown(week(), '2026-10-15', 'dinner').map((e) => [e.recipeName, e.position]);

  test('puts each recipe last, in the order added, starting at 0', () => {
    const pie = createRecipe('Pie', home);
    clearOutbox();

    const first = addRecipeToSlot(home, '2026-10-15', 'dinner', tacos);
    addRecipeToSlot(home, '2026-10-15', 'dinner', soup);
    addRecipeToSlot(home, '2026-10-15', 'dinner', pie);

    expect(first).toMatchObject({ kind: 'recipe', recipeId: tacos, note: null, position: 0, deletedAt: null });
    expect(names()).toEqual([
      ['Tacos', 0],
      ['Soup', 1],
      ['Pie', 2],
    ]);
    // Three inserts, nothing else.
    expect(outboxMutations().map((m) => m.fields.recipe_id)).toEqual([tacos, soup, pie]);
  });

  test("goes one past the slot's highest live position, not its count", () => {
    pulledEntry('high', { kind: 'recipe', recipeId: tacos, position: 7.5 });
    pulledEntry('gone', { kind: 'recipe', recipeId: soup, position: 20, deletedAt: new Date() });

    expect(addRecipeToSlot(home, '2026-10-15', 'dinner', soup)!.position).toBe(8.5);
  });

  test('a recipe already in the slot is skipped: null, and nothing written', () => {
    addRecipeToSlot(home, '2026-10-15', 'dinner', tacos);
    addRecipeToSlot(home, '2026-10-15', 'dinner', soup);
    clearOutbox();

    expect(addRecipeToSlot(home, '2026-10-15', 'dinner', tacos)).toBeNull();
    expect(outboxMutations()).toEqual([]);
    expect(names()).toEqual([
      ['Tacos', 0],
      ['Soup', 1],
    ]);
  });

  test('a recipe taken out of the slot can be added again', () => {
    const row = addRecipeToSlot(home, '2026-10-15', 'dinner', tacos)!;
    removeEntry(row.id);

    expect(addRecipeToSlot(home, '2026-10-15', 'dinner', tacos)).toMatchObject({ recipeId: tacos, position: 0 });
  });

  test('over a note, soft-deletes the note and starts the recipes at 0', () => {
    const note = setSlot(home, '2026-10-15', 'dinner', { kind: 'note', note: 'Pizza night' });
    clearOutbox();

    const row = addRecipeToSlot(home, '2026-10-15', 'dinner', tacos)!;

    expect(row.position).toBe(0);
    expect(outboxMutations().map((m) => [m.id, Object.keys(m.fields)])).toEqual([
      [note.id, ['deleted_at']],
      [row.id, expect.arrayContaining(['kind', 'recipe_id', 'position'])],
    ]);
    expect(names()).toEqual([['Tacos', 0]]);
    expect(entryRows().filter((e) => e.deletedAt === null).map((e) => e.id)).toEqual([row.id]);
  });

  test('leaves other slots and households alone', () => {
    setSlot(home, '2026-10-15', 'lunch', { kind: 'leftovers' });
    setSlot(CABIN, '2026-10-15', 'dinner', { kind: 'leftovers' });
    clearOutbox();

    addRecipeToSlot(home, '2026-10-15', 'dinner', tacos);

    expect(outboxMutations()).toHaveLength(1);
    expect(entryRows().filter((e) => e.deletedAt === null)).toHaveLength(3);
  });

  test('refuses a recipe from another household, a deleted one or a missing one, and writes nothing', () => {
    const chili = createRecipe('Chili', CABIN);
    setSlot(home, '2026-10-15', 'dinner', { kind: 'leftovers' });
    deleteRecipe(soup);
    clearOutbox();
    const before = entryRows();

    expect(() => addRecipeToSlot(home, '2026-10-15', 'dinner', chili)).toThrow(`Recipe ${chili} isn't in household ${home}`);
    expect(() => addRecipeToSlot(home, '2026-10-15', 'dinner', soup)).toThrow("isn't in household");
    expect(() => addRecipeToSlot(home, '2026-10-15', 'dinner', 'missing')).toThrow("isn't in household");
    expect(entryRows()).toEqual(before);
    expect(outboxMutations()).toEqual([]);
  });

  test('a note set over the recipes replaces them all', () => {
    const a = addRecipeToSlot(home, '2026-10-15', 'dinner', tacos)!;
    const b = addRecipeToSlot(home, '2026-10-15', 'dinner', soup)!;
    clearOutbox();

    const note = setSlot(home, '2026-10-15', 'dinner', { kind: 'note', note: 'Eating at Gran’s' });

    expect(outboxMutations().map((m) => [m.id, Object.keys(m.fields).length === 1 ? 'clear' : 'insert'])).toEqual([
      [a.id, 'clear'],
      [b.id, 'clear'],
      [note.id, 'insert'],
    ]);
    expect(shown(week(), '2026-10-15', 'dinner').map((e) => e.note)).toEqual(['Eating at Gran’s']);
  });
});

describe('removeEntry and restoreEntries', () => {
  test("remove takes out just that entry and returns it; restore puts it back where it was", () => {
    addRecipeToSlot(home, '2026-10-15', 'dinner', tacos);
    const middle = addRecipeToSlot(home, '2026-10-15', 'dinner', soup)!;
    const pie = createRecipe('Pie', home);
    addRecipeToSlot(home, '2026-10-15', 'dinner', pie);
    clearOutbox();

    const removed = removeEntry(middle.id)!;

    expect(removed).toMatchObject({ id: middle.id, recipeId: soup, deletedAt: expect.any(Date) });
    expect(outboxMutations().map((m) => [m.id, Object.keys(m.fields)])).toEqual([[middle.id, ['deleted_at']]]);
    expect(shown(week(), '2026-10-15', 'dinner').map((e) => e.recipeName)).toEqual(['Tacos', 'Pie']);

    clearOutbox();
    restoreEntries([removed]);

    expect(outboxMutations()).toEqual([
      { table: 'meal_plan_entries', id: middle.id, hlc: expect.any(String), fields: { deleted_at: null } },
    ]);
    expect(shown(week(), '2026-10-15', 'dinner').map((e) => e.recipeName)).toEqual(['Tacos', 'Soup', 'Pie']);
  });

  test("restore leaves what's been added since", () => {
    const removed = removeEntry(addRecipeToSlot(home, '2026-10-15', 'dinner', tacos)!.id)!;
    addRecipeToSlot(home, '2026-10-15', 'dinner', soup);

    restoreEntries([removed]);

    // Soup went in an empty slot, so both are at 0, and the one created last comes first.
    expect(shown(week(), '2026-10-15', 'dinner').map((e) => [e.recipeName, e.position])).toEqual([
      ['Soup', 0],
      ['Tacos', 0],
    ]);
  });

  test('removing an entry that is already out, or missing, returns null and writes nothing', () => {
    const row = addRecipeToSlot(home, '2026-10-15', 'dinner', tacos)!;
    removeEntry(row.id);
    clearOutbox();

    expect(removeEntry(row.id)).toBeNull();
    expect(removeEntry('missing')).toBeNull();
    expect(outboxMutations()).toEqual([]);
  });

  test('restoring nothing writes nothing', () => {
    restoreEntries([]);
    expect(outboxMutations()).toEqual([]);
  });
});

describe('moveEntry', () => {
  let ids: Record<'a' | 'b' | 'c' | 'd', string>;
  const order = () => shown(week(), '2026-10-15', 'dinner').map((e) => e.recipeName);
  const move = (id: string, to: number) => moveEntry(home, '2026-10-15', 'dinner', id, to);

  beforeEach(() => {
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((name) => {
      const recipeId = createRecipe(name, home);
      return addRecipeToSlot(home, '2026-10-15', 'dinner', recipeId)!.id;
    });
    ids = { a, b, c, d };
    clearOutbox();
  });

  test('to the top: one less than the first', () => {
    expect(move(ids.c, 0)!.position).toBe(-1);
    expect(order()).toEqual(['C', 'A', 'B', 'D']);
    expect(outboxMutations().map((m) => [m.id, m.fields])).toEqual([[ids.c, { position: -1 }]]);
  });

  test('to the middle: halfway between its new neighbours, moving down or up', () => {
    expect(move(ids.a, 2)!.position).toBe(2.5);
    expect(order()).toEqual(['B', 'C', 'A', 'D']);
    expect(move(ids.d, 1)!.position).toBe(1.5);
    expect(order()).toEqual(['B', 'D', 'C', 'A']);
    expect(outboxMutations().map((m) => [m.id, m.fields])).toEqual([
      [ids.a, { position: 2.5 }],
      [ids.d, { position: 1.5 }],
    ]);
  });

  test('to the end: one more than the last', () => {
    expect(move(ids.b, 3)!.position).toBe(4);
    expect(order()).toEqual(['A', 'C', 'D', 'B']);
    expect(outboxMutations().map((m) => [m.id, m.fields])).toEqual([[ids.b, { position: 4 }]]);
  });

  test('an index past either end lands at that end', () => {
    move(ids.b, 99);
    expect(order()).toEqual(['A', 'C', 'D', 'B']);
    move(ids.d, -5);
    expect(order()).toEqual(['D', 'A', 'C', 'B']);
  });

  test("to where it already is: returned as it is, nothing written", () => {
    expect(move(ids.b, 1)).toMatchObject({ id: ids.b, position: 1 });
    expect(outboxMutations()).toEqual([]);
  });

  test("an entry that isn't one of the slot's shown recipes: null, nothing written", () => {
    const lunch = addRecipeToSlot(home, '2026-10-15', 'lunch', tacos)!;
    removeEntry(ids.a);
    clearOutbox();

    expect(move(lunch.id, 0)).toBeNull();
    expect(move(ids.a, 0)).toBeNull();
    expect(move('missing', 0)).toBeNull();
    expect(outboxMutations()).toEqual([]);
  });

  test("a deleted recipe's hidden entry doesn't count as a neighbour", () => {
    deleteRecipe(entryRows().find((e) => e.id === ids.a)!.recipeId!);
    clearOutbox();

    // Shown: B (1), C (2), D (3). To the top goes below B, not below the hidden A.
    expect(move(ids.d, 0)!.position).toBe(0);
    expect(order()).toEqual(['D', 'B', 'C']);
  });
});

describe('cleanNote', () => {
  test('trims and keeps the text as typed, up to 60 characters', () => {
    expect(cleanNote('  Tacos de canasta ')).toBe('Tacos de canasta');
    expect(cleanNote('x'.repeat(60))).toBe('x'.repeat(60));
    expect(cleanNote(` ${'x'.repeat(60)} `)).toBe('x'.repeat(60));
    expect(() => cleanNote('')).toThrow();
    expect(() => cleanNote('x'.repeat(61))).toThrow();
  });
});

describe('clearSlot', () => {
  test("soft-deletes every live entry in the slot, one mutation each, and returns them", () => {
    pulledEntry('a', { createdAt: new Date('2026-10-12T08:00:00Z') });
    pulledEntry('b', { createdAt: new Date('2026-10-12T09:00:00Z') });
    pulledEntry('other', { meal: 'lunch' });

    const cleared = clearSlot(home, '2026-10-15', 'dinner');

    expect(cleared.map((e) => e.id).sort()).toEqual(['a', 'b']);
    expect(cleared.every((e) => e.deletedAt instanceof Date)).toBe(true);
    expect(outboxMutations().map((m) => [m.table, m.id, Object.keys(m.fields)]).sort()).toEqual([
      ['meal_plan_entries', 'a', ['deleted_at']],
      ['meal_plan_entries', 'b', ['deleted_at']],
    ]);
    expect(shown(week(), '2026-10-15', 'lunch').map((e) => e.id)).toEqual(['other']);
  });

  test('an empty slot writes nothing', () => {
    expect(clearSlot(home, '2026-10-15', 'dinner')).toEqual([]);
    expect(outboxMutations()).toEqual([]);
  });
});

describe('applyPlanChanges', () => {
  test('writes every slot in one go: sets, replaces and clears', () => {
    setSlot(home, '2026-10-15', 'dinner', { kind: 'leftovers' });
    setSlot(home, '2026-10-16', 'lunch', { kind: 'eating-out' });
    clearOutbox();

    applyPlanChanges([
      { householdId: home, day: '2026-10-15', meal: 'dinner', entry: { kind: 'recipe', recipeId: tacos } },
      { householdId: home, day: '2026-10-17', meal: 'dinner', entry: { kind: 'recipe', recipeId: tacos } },
      { householdId: home, day: '2026-10-16', meal: 'lunch', entry: null },
    ]);

    const entries = week();
    expect(entries.map((e) => [e.planDate, e.meal, e.recipeName])).toEqual([
      ['2026-10-15', 'dinner', 'Tacos'],
      ['2026-10-17', 'dinner', 'Tacos'],
    ]);
    expect(outboxMutations().map((m) => Object.keys(m.fields).length > 1 ? 'insert' : 'clear')).toEqual([
      'clear',
      'insert',
      'insert',
      'clear',
    ]);
  });

  test('adds beside recipes, over notes and skipping duplicates, with clears, in one go', () => {
    const pie = createRecipe('Pie', home);
    addRecipeToSlot(home, '2026-10-15', 'dinner', tacos);
    setSlot(home, '2026-10-16', 'dinner', { kind: 'note', note: 'Pizza' });
    setSlot(home, '2026-10-17', 'lunch', { kind: 'leftovers' });
    clearOutbox();

    applyPlanChanges([
      { householdId: home, day: '2026-10-15', meal: 'dinner', add: { recipeId: soup } },
      { householdId: home, day: '2026-10-15', meal: 'dinner', add: { recipeId: tacos } }, // already there
      { householdId: home, day: '2026-10-16', meal: 'dinner', add: { recipeId: pie } },
      { householdId: home, day: '2026-10-17', meal: 'lunch', entry: null },
      { householdId: home, day: '2026-10-17', meal: 'dinner', add: { recipeId: pie } },
    ]);

    const entries = week();
    expect(shown(entries, '2026-10-15', 'dinner').map((e) => [e.recipeName, e.position])).toEqual([
      ['Tacos', 0],
      ['Soup', 1],
    ]);
    expect(shown(entries, '2026-10-16', 'dinner').map((e) => e.recipeName)).toEqual(['Pie']);
    expect(shown(entries, '2026-10-17', 'lunch')).toEqual([]);
    expect(shown(entries, '2026-10-17', 'dinner').map((e) => e.recipeName)).toEqual(['Pie']);
    expect(outboxMutations().map((m) => (Object.keys(m.fields).length > 1 ? 'insert' : 'clear'))).toEqual([
      'insert', // Soup
      'clear', // the note
      'insert', // Pie on Friday
      'clear', // Saturday lunch
      'insert', // Pie on Saturday
    ]);
  });

  test('a bad add writes none of the changes', () => {
    const chili = createRecipe('Chili', CABIN);
    clearOutbox();

    expect(() =>
      applyPlanChanges([
        { householdId: home, day: '2026-10-15', meal: 'dinner', add: { recipeId: tacos } },
        { householdId: home, day: '2026-10-16', meal: 'dinner', add: { recipeId: chili } },
      ]),
    ).toThrow("isn't in household");
    expect(entryRows()).toEqual([]);
    expect(outboxMutations()).toEqual([]);
  });

  test('one bad change writes none of them', () => {
    const chili = createRecipe('Chili', CABIN);
    clearOutbox();

    expect(() =>
      applyPlanChanges([
        { householdId: home, day: '2026-10-15', meal: 'dinner', entry: { kind: 'recipe', recipeId: tacos } },
        { householdId: home, day: '2026-10-16', meal: 'dinner', entry: { kind: 'recipe', recipeId: chili } },
      ]),
    ).toThrow("isn't in household");
    expect(entryRows()).toEqual([]);
    expect(outboxMutations()).toEqual([]);
  });

  test('no changes, no write', () => {
    expect(applyPlanChanges([])).toEqual({ added: [], removed: [] });
    expect(outboxMutations()).toEqual([]);
    expect(db.select().from(recipes).all()).toHaveLength(2);
  });

  test('returns the rows it put in and took out: adds over a note, skipped duplicates, sets and clears', () => {
    const pie = createRecipe('Pie', home);
    const kept = addRecipeToSlot(home, '2026-10-15', 'dinner', tacos)!;
    const note = setSlot(home, '2026-10-16', 'dinner', { kind: 'note', note: 'Pizza' });
    const leftovers = setSlot(home, '2026-10-17', 'lunch', { kind: 'leftovers' });

    const applied = applyPlanChanges([
      { householdId: home, day: '2026-10-15', meal: 'dinner', add: { recipeId: tacos } }, // already there
      { householdId: home, day: '2026-10-15', meal: 'dinner', add: { recipeId: soup } },
      { householdId: home, day: '2026-10-16', meal: 'dinner', add: { recipeId: pie } },
      { householdId: home, day: '2026-10-17', meal: 'lunch', entry: { kind: 'recipe', recipeId: pie } },
    ]);

    expect(applied.added.map((e) => [e.planDate, e.meal, e.recipeId])).toEqual([
      ['2026-10-15', 'dinner', soup],
      ['2026-10-16', 'dinner', pie],
      ['2026-10-17', 'lunch', pie],
    ]);
    expect(applied.removed.map((e) => e.id)).toEqual([note.id, leftovers.id]);
    expect(applied.removed.every((e) => e.deletedAt !== null)).toBe(true);
    expect(applied.removed.map((e) => e.id)).not.toContain(kept.id);
  });
});

describe('undoPlanChanges', () => {
  const slot = (day: string, meal: 'breakfast' | 'lunch' | 'dinner') =>
    shown(week(), day, meal).map((e) => [e.id, e.kind, e.recipeName ?? e.note]);

  test('adding several: takes them out again, leaving the recipes that were there', () => {
    const pie = createRecipe('Pie', home);
    const kept = addRecipeToSlot(home, '2026-10-15', 'dinner', tacos)!;
    const applied = applyPlanChanges([
      { householdId: home, day: '2026-10-15', meal: 'dinner', add: { recipeId: soup } },
      { householdId: home, day: '2026-10-15', meal: 'dinner', add: { recipeId: pie } },
    ]);
    expect(slot('2026-10-15', 'dinner').map((e) => e[2])).toEqual(['Tacos', 'Soup', 'Pie']);
    clearOutbox();

    undoPlanChanges(applied);
    expect(slot('2026-10-15', 'dinner')).toEqual([[kept.id, 'recipe', 'Tacos']]);
    // Two soft-deletes; Tacos isn't touched.
    expect(outboxMutations().map((m) => [m.id, Object.keys(m.fields)])).toEqual([
      [applied.added[0].id, ['deleted_at']],
      [applied.added[1].id, ['deleted_at']],
    ]);
  });

  test('adding to an empty slot: empty again', () => {
    const applied = applyPlanChanges([
      { householdId: home, day: '2026-10-15', meal: 'lunch', add: { recipeId: soup } },
      { householdId: home, day: '2026-10-15', meal: 'lunch', add: { recipeId: tacos } },
    ]);
    undoPlanChanges(applied);
    expect(slot('2026-10-15', 'lunch')).toEqual([]);
  });

  test('adding over a note: the note comes back', () => {
    const note = setSlot(home, '2026-10-15', 'dinner', { kind: 'note', note: 'Pizza' });
    const applied = applyPlanChanges([{ householdId: home, day: '2026-10-15', meal: 'dinner', add: { recipeId: soup } }]);
    expect(slot('2026-10-15', 'dinner').map((e) => e[1])).toEqual(['recipe']);
    undoPlanChanges(applied);
    expect(slot('2026-10-15', 'dinner')).toEqual([[note.id, 'note', 'Pizza']]);
  });

  test('replacing (a clear, then adds): every recipe that was there comes back, in its order', () => {
    const pie = createRecipe('Pie', home);
    addRecipeToSlot(home, '2026-10-15', 'dinner', tacos);
    addRecipeToSlot(home, '2026-10-15', 'dinner', soup);
    const before = slot('2026-10-15', 'dinner');
    const applied = applyPlanChanges([
      { householdId: home, day: '2026-10-15', meal: 'dinner', entry: null },
      { householdId: home, day: '2026-10-15', meal: 'dinner', add: { recipeId: pie } },
      { householdId: home, day: '2026-10-15', meal: 'dinner', add: { recipeId: tacos } },
    ]);
    // Tacos comes in again as a new row, after Pie.
    expect(slot('2026-10-15', 'dinner').map((e) => e[2])).toEqual(['Pie', 'Tacos']);
    expect(applied.removed).toHaveLength(2);

    undoPlanChanges(applied);
    expect(slot('2026-10-15', 'dinner')).toEqual(before);
  });

  test('leaves what was written since alone, and does nothing for an empty batch', () => {
    const applied = applyPlanChanges([{ householdId: home, day: '2026-10-15', meal: 'dinner', add: { recipeId: soup } }]);
    const other = addRecipeToSlot(home, '2026-10-15', 'dinner', tacos)!;
    undoPlanChanges(applied);
    expect(slot('2026-10-15', 'dinner')).toEqual([[other.id, 'recipe', 'Tacos']]);
    clearOutbox();
    undoPlanChanges({ added: [], removed: [] });
    expect(outboxMutations()).toEqual([]);
  });

  test('an added row taken out since stays out, and is not written again', () => {
    const applied = applyPlanChanges([{ householdId: home, day: '2026-10-15', meal: 'dinner', add: { recipeId: soup } }]);
    removeEntry(applied.added[0].id);
    clearOutbox();
    undoPlanChanges(applied);
    expect(slot('2026-10-15', 'dinner')).toEqual([]);
    expect(outboxMutations()).toEqual([]);
  });
});
