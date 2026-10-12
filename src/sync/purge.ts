// Lost memberships (spec 4.7, 7.2): when the user leaves a household, is removed from it, or it is
// deleted, this device removes everything it holds for that household and drops the mutations it
// still had queued for it. The server would reject those anyway (not a member).
//
// Pull writes, like the rows it brings down: nothing here goes to the outbox. Per-user rows stay
// (they belong to the user, not the household), except the user's order rows for the household's
// custom aisles, which the server cascades away; a Siri default list in the household is cleared
// here, as the server's `on delete set null` does there.
import { and, count, eq, inArray, like, sql } from 'drizzle-orm';

import {
  categories,
  deviceSettings,
  householdCategoryOverrides,
  households,
  ingredientUnitUsage,
  ingredientUsage,
  listItemContributions,
  listItems,
  lists,
  outbox,
  recipeIngredients,
  recipes,
  userCategoryOrder,
  userSettings,
} from '@/db';
import { LAST_OPENED_LIST_KEY } from '@/features/lists/lists';
import { viewModeKey } from '@/features/lists/list-view';

import type { Exec } from './clock';

export type PurgeSummary = { lists: number; recipes: number; items: number; mutations: number };

/**
 * Deletes `householdId`'s rows from SQLite (children first, for the foreign keys), its outbox
 * mutations (rejected ones too), and the device settings that point into it. Run it inside a
 * transaction. A household this device doesn't have purges nothing.
 */
export function purgeHousehold(tx: Exec, householdId: string): PurgeSummary {
  const listIds = tx
    .select({ id: lists.id })
    .from(lists)
    .where(eq(lists.householdId, householdId))
    .all()
    .map((r) => r.id);
  const recipeIds = tx
    .select({ id: recipes.id })
    .from(recipes)
    .where(eq(recipes.householdId, householdId))
    .all()
    .map((r) => r.id);

  if (recipeIds.length) {
    // Rows elsewhere never point at another household's recipes, but don't let a stray one block the purge.
    tx.update(listItemContributions)
      .set({ recipeId: null })
      .where(inArray(listItemContributions.recipeId, recipeIds))
      .run();
  }
  tx.delete(listItemContributions).where(eq(listItemContributions.householdId, householdId)).run();
  const items = tx.select({ n: count() }).from(listItems).where(eq(listItems.householdId, householdId)).get()?.n ?? 0;
  tx.delete(listItems).where(eq(listItems.householdId, householdId)).run();
  tx.delete(recipeIngredients).where(eq(recipeIngredients.householdId, householdId)).run();
  tx.delete(ingredientUsage).where(eq(ingredientUsage.householdId, householdId)).run();
  tx.delete(ingredientUnitUsage).where(eq(ingredientUnitUsage.householdId, householdId)).run();
  // Its aisles (spec 4.3.2): overrides, custom categories, and the user's order rows for them,
  // with their queued order mutations (per-user, so the household filter below misses them).
  tx.delete(householdCategoryOverrides).where(eq(householdCategoryOverrides.householdId, householdId)).run();
  const categoryIds = tx
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.householdId, householdId))
    .all()
    .map((r) => r.id);
  if (categoryIds.length) {
    tx.delete(userCategoryOrder).where(inArray(userCategoryOrder.categoryId, categoryIds)).run();
    tx.delete(outbox)
      .where(
        and(
          sql`json_extract(${outbox.mutation}, '$.table') = 'user_category_order'`,
          inArray(sql`json_extract(${outbox.mutation}, '$.key.category_id')`, categoryIds),
        ),
      )
      .run();
    tx.delete(categories).where(inArray(categories.id, categoryIds)).run();
  }
  if (listIds.length) {
    tx.update(userSettings).set({ defaultListId: null }).where(inArray(userSettings.defaultListId, listIds)).run();
  }
  tx.delete(lists).where(eq(lists.householdId, householdId)).run();
  tx.delete(recipes).where(eq(recipes.householdId, householdId)).run();
  tx.delete(households).where(eq(households.id, householdId)).run();
  const mutations = tx.select({ n: count() }).from(outbox).where(eq(outbox.householdId, householdId)).get()?.n ?? 0;
  tx.delete(outbox).where(eq(outbox.householdId, householdId)).run();

  if (listIds.length) {
    tx.delete(deviceSettings)
      .where(inArray(deviceSettings.key, listIds.map(viewModeKey)))
      .run();
    const lastOpened = tx.select().from(deviceSettings).where(eq(deviceSettings.key, LAST_OPENED_LIST_KEY)).get();
    if (lastOpened && listIds.includes(lastOpened.value as string)) {
      tx.delete(deviceSettings).where(eq(deviceSettings.key, LAST_OPENED_LIST_KEY)).run();
    }
  }
  // Left by the old registration step (registerHouseholds, removed in M5).
  tx.delete(deviceSettings)
    .where(like(deviceSettings.key, `household.${householdId}.%`))
    .run();

  return { lists: listIds.length, recipes: recipeIds.length, items, mutations };
}
