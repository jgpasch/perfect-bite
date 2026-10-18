import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, households, mealPlanEntries, outbox, recipes } from '@/db';
import { ensureStarterData, getDefaultListId, getList } from '@/features/lists/lists';
import { createRecipe, deleteRecipe } from '@/features/recipes/recipes';
import { resetDb } from '@/test/db';
import { clearOutbox, outboxMutations } from '@/test/outbox';

import { groupWeek, restOfWeekEntriesQuery, upcomingRecipeEntriesQuery, weekEntriesQuery, type PlanEntry } from '../queries';
import { applyPlanChanges, cleanNote, clearSlot, setSlot } from '../write';

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
    pulledEntry('main', { position: 0, createdAt: new Date('2026-10-12T08:00:00Z') });
    pulledEntry('side', { position: 1, createdAt: new Date('2026-10-12T09:00:00Z') });

    expect(shown(week(), '2026-10-15', 'dinner').map((e) => e.id)).toEqual(['main', 'side']);
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
    applyPlanChanges([]);
    expect(outboxMutations()).toEqual([]);
    expect(db.select().from(recipes).all()).toHaveLength(2);
  });
});
