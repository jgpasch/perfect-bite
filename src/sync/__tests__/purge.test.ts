// Lost memberships (spec 4.7, 7.2): purging a household removes its rows, its queued mutations and
// the device settings that point into it, and leaves every other household and the user's own
// rows alone.
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { asc, eq } from 'drizzle-orm';

import {
  db,
  deviceSettings,
  households,
  ingredientUnitUsage,
  ingredientUsage,
  listItemContributions,
  listItems,
  lists,
  outbox,
  recipeIngredients,
  recipes,
  userCategoryOverrides,
  userSettings,
} from '@/db';
import { loadCatalogSeed, setCategoryOverride } from '@/features/categories/categories';
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
import { addRecipeIngredient, createRecipe } from '@/features/recipes/recipes';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { newId } from '@/lib/id';
import { SYSTEM_CATEGORIES } from '@/shared/seed/categories';
import { resetDb } from '@/test/db';
import { outboxRows } from '@/test/outbox';

import { insertRow } from '../mutate';
import { purgeHousehold } from '../purge';

jest.mock('@/db/client', () => require('@/test/db'));

const USER = 'u1';
const PRODUCE = SYSTEM_CATEGORIES.find((c) => c.slug === 'produce')!.id;
const CABIN = 'household-cabin';

let home: string;
let homeList: string;
let cabinList: string;
let cabinRecipe: string;

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
  loadCatalogSeed();
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
  setCategoryOverride(USER, 'onions', PRODUCE);
});

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
    expect(perUser.map((r) => r.mutation.table)).toEqual(expect.arrayContaining(['user_settings', 'user_category_overrides']));

    db.transaction((tx) => purgeHousehold(tx, CABIN));

    expect(outboxRows().filter((r) => r.householdId === CABIN)).toEqual([]);
    expect(outboxRows().filter((r) => r.householdId === null)).toEqual(perUser);
  });

  test("keeps the user's own preferences: overrides stay, a default list elsewhere stays", () => {
    db.transaction((tx) => purgeHousehold(tx, CABIN));

    expect(db.select().from(userCategoryOverrides).all()).toMatchObject([
      { userId: USER, ingredientName: 'onions', categoryId: PRODUCE },
    ]);
    expect(getDefaultListId(USER)).toBe(homeList);
  });

  test('a Siri default list in the household is cleared locally, without a mutation', () => {
    setDefaultList(USER, cabinList);
    const perUser = outboxRows().filter((r) => r.householdId === null);

    db.transaction((tx) => purgeHousehold(tx, CABIN));

    expect(db.select().from(userSettings).where(eq(userSettings.userId, USER)).get()?.defaultListId).toBeNull();
    // The server clears it on its side (`on delete set null`); nothing new is queued.
    expect(outboxRows().filter((r) => r.householdId === null)).toEqual(perUser);
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
    db.transaction((tx) => {
      purgeHousehold(tx, CABIN);
      purgeHousehold(tx, home);
    });

    expect(householdIds()).toEqual([]);
    expect(db.select().from(lists).all()).toEqual([]);
    expect(outboxRows().every((r) => r.householdId === null)).toBe(true);
    expect(db.select().from(userSettings).get()).toMatchObject({ userId: USER, defaultListId: null });
  });
});
