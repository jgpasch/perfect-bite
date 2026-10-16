// Lost memberships (spec 4.7, 7.2): purging a household removes its rows, its queued mutations and
// the device settings that point into it, and leaves every other household and the user's own
// rows alone.
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { asc, eq } from 'drizzle-orm';

import {
  categories,
  db,
  deviceSettings,
  householdCategoryOverrides,
  households,
  householdStaples,
  ingredientUnitUsage,
  ingredientUsage,
  listItemContributions,
  listItems,
  lists,
  mealPlanEntries,
  outbox,
  recipeIngredients,
  recipes,
  userCategoryOrder,
  userSettings,
  type OutboxRow,
} from '@/db';
import { createCategory, setCategoryOverride } from '@/features/categories/categories';
import { addItem, checkItems } from '@/features/lists/items';
import { viewModeKey } from '@/features/lists/list-view';
import {
  createList,
  ensureStarterData,
  getDefaultListId,
  LAST_OPENED_LIST_KEY,
  setDefaultList,
  setLastOpenedList,
} from '@/features/lists/lists';
import { setSlot } from '@/features/meal-plan/write';
import { addRecipeIngredient, createRecipe } from '@/features/recipes/recipes';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { newId } from '@/lib/id';
import { SYSTEM_CATEGORIES } from '@/shared/seed/categories';
import { resetDb } from '@/test/db';
import { seedCatalog } from '@/test/seed';
import { outboxRows } from '@/test/outbox';

import { insertRow, upsertRow } from '../mutate';
import { purgeHousehold } from '../purge';

jest.mock('@/db/client', () => require('@/test/db'));

const USER = 'u1';
const PRODUCE = SYSTEM_CATEGORIES.find((c) => c.slug === 'produce')!.id;
const CABIN = 'household-cabin';

let home: string;
let homeList: string;
let cabinList: string;
let cabinRecipe: string;
let homeAisle: string;
let cabinAisle: string;

/** Every row of `table` in `householdId`. */
const rowsIn = (table: typeof lists | typeof recipes, householdId: string) =>
  db.select().from(table).where(eq(table.householdId, householdId)).all();
const itemsIn = (householdId: string) => db.select().from(listItems).where(eq(listItems.householdId, householdId)).all();

const householdIds = () =>
  db
    .select({ id: households.id })
    .from(households)
    .orderBy(asc(households.id))
    .all()
    .map((h) => h.id);

/** Two households with lists, items, recipes, usage and queued mutations in each. */
beforeEach(() => {
  resetDb();
  seedCatalog();
  ensureStarterData(USER);
  home = db.select().from(households).get()!.id;
  homeList = getDefaultListId(USER)!;
  insertRow(db, households, { id: CABIN, name: 'Cabin' });
  cabinList = createList('Cabin groceries', CABIN);

  addItem(homeList, '2 lbs chicken thighs', USER);
  addItem(homeList, 'milk', USER);
  addItem(cabinList, '3 lbs onions', USER);
  addItem(cabinList, 'milk', USER);
  checkItems(
    itemsIn(CABIN)
      .filter((i) => i.ingredientName === 'milk')
      .map((i) => i.id),
    USER,
  );
  cabinRecipe = createRecipe('Chili', CABIN);
  addRecipeIngredient(cabinRecipe, '1 can beans');
  // A contribution that came from the recipe.
  const onions = itemsIn(CABIN).find((i) => i.ingredientName !== 'milk')!;
  insertRow(db, listItemContributions, {
    id: newId(),
    listItemId: onions.id,
    householdId: CABIN,
    source: 'recipe',
    recipeId: cabinRecipe,
    quantity: 1,
    unit: 'lb',
  });
  // Each household's aisles: a custom one, and an override (spec 4.3.2).
  homeAisle = createCategory(USER, home, 'Costco');
  cabinAisle = createCategory(USER, CABIN, 'Farm stand');
  setCategoryOverride(home, 'onions', PRODUCE);
  setCategoryOverride(CABIN, 'onions', cabinAisle);
});

const overridesIn = (householdId: string) =>
  db.select().from(householdCategoryOverrides).where(eq(householdCategoryOverrides.householdId, householdId)).all();
const isOrderFor = (categoryId: string) => (r: OutboxRow) =>
  r.mutation.table === 'user_category_order' && r.mutation.key?.category_id === categoryId;

describe('purgeHousehold', () => {
  test("removes every row of the household and reports what went", () => {
    expect(rowsIn(lists, CABIN)).toHaveLength(1);
    const cabinMutations = outboxRows().filter((r) => r.householdId === CABIN).length;
    expect(cabinMutations).toBeGreaterThan(0);

    const summary = db.transaction((tx) => purgeHousehold(tx, CABIN));

    expect(summary).toEqual({ lists: 1, recipes: 1, items: 2, mutations: cabinMutations });
    expect(householdIds()).toEqual([home]);
    expect(rowsIn(lists, CABIN)).toEqual([]);
    expect(itemsIn(CABIN)).toEqual([]);
    expect(rowsIn(recipes, CABIN)).toEqual([]);
    expect(db.select().from(listItemContributions).where(eq(listItemContributions.householdId, CABIN)).all()).toEqual([]);
    expect(db.select().from(recipeIngredients).where(eq(recipeIngredients.householdId, CABIN)).all()).toEqual([]);
    expect(db.select().from(ingredientUsage).where(eq(ingredientUsage.householdId, CABIN)).all()).toEqual([]);
    expect(db.select().from(ingredientUnitUsage).where(eq(ingredientUnitUsage.householdId, CABIN)).all()).toEqual([]);
  });

  test("leaves the other household's rows and mutations exactly as they were", () => {
    const homeItems = itemsIn(home);
    const homeContributions = db
      .select()
      .from(listItemContributions)
      .where(eq(listItemContributions.householdId, home))
      .all();
    const homeUsage = db.select().from(ingredientUsage).where(eq(ingredientUsage.householdId, home)).all();
    const homeOutbox = outboxRows().filter((r) => r.householdId === home);

    db.transaction((tx) => purgeHousehold(tx, CABIN));

    expect(rowsIn(lists, home).map((l) => l.id)).toEqual([homeList]);
    expect(itemsIn(home)).toEqual(homeItems);
    expect(homeItems.map((i) => i.ingredientName).sort()).toEqual(['chicken thigh', 'milk']);
    expect(db.select().from(listItemContributions).where(eq(listItemContributions.householdId, home)).all()).toEqual(
      homeContributions,
    );
    expect(db.select().from(ingredientUsage).where(eq(ingredientUsage.householdId, home)).all()).toEqual(homeUsage);
    expect(outboxRows().filter((r) => r.householdId === home)).toEqual(homeOutbox);
  });

  test("drops the household's queued mutations, rejected ones too, and keeps the user's own", () => {
    const rejected = outboxRows().find((r) => r.householdId === CABIN)!;
    db.update(outbox)
      .set({ rejectedAt: new Date(), error: { code: '42501', message: 'not a member' } })
      .where(eq(outbox.id, rejected.id))
      .run();
    const perUser = outboxRows().filter((r) => r.householdId === null);
    expect(perUser.map((r) => r.mutation.table)).toEqual(expect.arrayContaining(['user_settings', 'user_category_order']));
    expect(outboxRows().filter((r) => r.householdId === CABIN).map((r) => r.mutation.table)).toEqual(
      expect.arrayContaining(['categories', 'household_category_overrides']),
    );

    db.transaction((tx) => purgeHousehold(tx, CABIN));

    expect(outboxRows().filter((r) => r.householdId === CABIN)).toEqual([]);
    // The user's own mutations stay, except the order for the cabin's aisle, which is gone.
    expect(perUser.filter(isOrderFor(cabinAisle))).toHaveLength(1);
    expect(outboxRows().filter((r) => r.householdId === null)).toEqual(perUser.filter((r) => !isOrderFor(cabinAisle)(r)));
  });

  test("removes the household's overrides and custom aisles, and the user's order for those aisles", () => {
    const homeOverrides = overridesIn(home);
    expect(overridesIn(CABIN)).toHaveLength(1);
    const orderFor = (categoryId: string) =>
      db.select().from(userCategoryOrder).where(eq(userCategoryOrder.categoryId, categoryId)).all();
    expect(orderFor(cabinAisle)).toHaveLength(1);
    const orderRows = db.select().from(userCategoryOrder).all().length;

    db.transaction((tx) => purgeHousehold(tx, CABIN));

    expect(overridesIn(CABIN)).toEqual([]);
    expect(db.select().from(categories).where(eq(categories.householdId, CABIN)).all()).toEqual([]);
    expect(orderFor(cabinAisle)).toEqual([]);
    expect(db.select().from(userCategoryOrder).all()).toHaveLength(orderRows - 1);
    // The other household's aisles, and the user's order for them and the system aisles, stay.
    expect(overridesIn(home)).toEqual(homeOverrides);
    expect(db.select().from(categories).where(eq(categories.id, homeAisle)).get()).toMatchObject({ householdId: home });
    expect(orderFor(homeAisle)).toHaveLength(1);
    expect(orderFor(PRODUCE)).toHaveLength(1);
    expect(db.select().from(categories).where(eq(categories.id, PRODUCE)).get()).toBeDefined();
    expect(getDefaultListId(USER)).toBe(homeList);
  });

  test("removes the household's staples, marked and unmarked, with their queued mutations", () => {
    const mark = (householdId: string, ingredientName: string, deletedAt: Date | null = null) =>
      upsertRow(db, householdStaples, { householdId, ingredientName, createdBy: USER, deletedAt }, { deletedAt });
    mark(home, 'salt');
    mark(CABIN, 'salt');
    mark(CABIN, 'pepper');
    mark(CABIN, 'pepper', new Date());
    const staplesIn = (householdId: string) =>
      db.select().from(householdStaples).where(eq(householdStaples.householdId, householdId)).all();
    const homeStaples = staplesIn(home);
    const stapleMutations = (householdId: string) =>
      outboxRows().filter((r) => r.householdId === householdId && r.mutation.table === 'household_staples');
    expect(staplesIn(CABIN)).toHaveLength(2);
    expect(stapleMutations(CABIN)).toHaveLength(3);
    const homeMutations = stapleMutations(home);

    db.transaction((tx) => purgeHousehold(tx, CABIN));

    expect(staplesIn(CABIN)).toEqual([]);
    expect(stapleMutations(CABIN)).toEqual([]);
    expect(staplesIn(home)).toEqual(homeStaples);
    expect(homeStaples.map((s) => s.ingredientName)).toEqual(['salt']);
    expect(stapleMutations(home)).toEqual(homeMutations);
  });

  test("removes the household's meal plan entries, live and cleared, with their queued mutations", () => {
    const homeRecipe = createRecipe('Soup', home);
    setSlot(home, '2026-10-15', 'dinner', { kind: 'recipe', recipeId: homeRecipe });
    setSlot(CABIN, '2026-10-15', 'dinner', { kind: 'recipe', recipeId: cabinRecipe });
    setSlot(CABIN, '2026-10-15', 'dinner', { kind: 'leftovers' }); // clears the recipe entry
    setSlot(CABIN, '2026-10-16', 'lunch', { kind: 'note', note: 'Picnic' });
    const entriesIn = (householdId: string) =>
      db.select().from(mealPlanEntries).where(eq(mealPlanEntries.householdId, householdId)).all();
    const entryMutations = (householdId: string) =>
      outboxRows().filter((r) => r.householdId === householdId && r.mutation.table === 'meal_plan_entries');
    const homeEntries = entriesIn(home);
    const homeMutations = entryMutations(home);
    expect(entriesIn(CABIN)).toHaveLength(3);
    expect(entryMutations(CABIN)).toHaveLength(4);

    db.transaction((tx) => purgeHousehold(tx, CABIN));

    expect(entriesIn(CABIN)).toEqual([]);
    expect(entryMutations(CABIN)).toEqual([]);
    expect(db.select().from(recipes).where(eq(recipes.id, cabinRecipe)).get()).toBeUndefined();
    expect(entriesIn(home)).toEqual(homeEntries);
    expect(homeEntries.map((e) => e.recipeId)).toEqual([homeRecipe]);
    expect(entryMutations(home)).toEqual(homeMutations);
  });

  test('a Siri default list in the household is cleared locally, without a mutation', () => {
    setDefaultList(USER, cabinList);
    const perUser = outboxRows().filter((r) => r.householdId === null);

    db.transaction((tx) => purgeHousehold(tx, CABIN));

    expect(db.select().from(userSettings).where(eq(userSettings.userId, USER)).get()?.defaultListId).toBeNull();
    // The server clears it on its side (`on delete set null`); nothing new is queued (the cabin
    // aisle's order mutation goes with the aisle).
    expect(outboxRows().filter((r) => r.householdId === null)).toEqual(perUser.filter((r) => !isOrderFor(cabinAisle)(r)));
  });

  test("clears the view modes and last-opened list that point into it, and the old registration flag", () => {
    setDeviceSetting(viewModeKey(cabinList), 'recipe');
    setDeviceSetting(viewModeKey(homeList), 'category');
    setLastOpenedList(cabinList);
    setDeviceSetting(`household.${CABIN}.registeredFor`, USER);
    setDeviceSetting(`household.${home}.registeredFor`, USER);

    db.transaction((tx) => purgeHousehold(tx, CABIN));

    expect(getDeviceSetting(viewModeKey(cabinList), null)).toBeNull();
    expect(getDeviceSetting(viewModeKey(homeList), null)).toBe('category');
    expect(getDeviceSetting(LAST_OPENED_LIST_KEY, null)).toBeNull();
    expect(getDeviceSetting(`household.${CABIN}.registeredFor`, null)).toBeNull();
    expect(getDeviceSetting(`household.${home}.registeredFor`, null)).toBe(USER);
  });

  test('a last-opened list in another household stays', () => {
    setLastOpenedList(homeList);

    db.transaction((tx) => purgeHousehold(tx, CABIN));

    expect(getDeviceSetting(LAST_OPENED_LIST_KEY, null)).toBe(homeList);
  });

  test("a household this device doesn't have purges nothing", () => {
    const outboxBefore = outboxRows();
    const settingsBefore = db.select().from(deviceSettings).all();

    expect(db.transaction((tx) => purgeHousehold(tx, 'household-unknown'))).toEqual({
      lists: 0,
      recipes: 0,
      items: 0,
      mutations: 0,
    });

    expect(householdIds()).toEqual([CABIN, home].sort());
    expect(outboxRows()).toEqual(outboxBefore);
    expect(db.select().from(deviceSettings).all()).toEqual(settingsBefore);
  });

  test('a failure later in the transaction leaves everything in place', () => {
    const outboxBefore = outboxRows();

    expect(() =>
      db.transaction((tx) => {
        purgeHousehold(tx, CABIN);
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(householdIds()).toEqual([CABIN, home].sort());
    expect(itemsIn(CABIN)).toHaveLength(2);
    expect(outboxRows()).toEqual(outboxBefore);
  });

  test('purging every household leaves an empty database apart from per-user rows', () => {
    upsertRow(db, householdStaples, { householdId: home, ingredientName: 'salt' }, {});
    db.transaction((tx) => {
      purgeHousehold(tx, CABIN);
      purgeHousehold(tx, home);
    });

    expect(householdIds()).toEqual([]);
    expect(db.select().from(lists).all()).toEqual([]);
    expect(db.select().from(householdCategoryOverrides).all()).toEqual([]);
    expect(db.select().from(householdStaples).all()).toEqual([]);
    // Only the system aisles are left.
    expect(db.select().from(categories).all()).toHaveLength(SYSTEM_CATEGORIES.length);
    expect(outboxRows().every((r) => r.householdId === null)).toBe(true);
    expect(db.select().from(userSettings).get()).toMatchObject({ userId: USER, defaultListId: null });
  });
});
