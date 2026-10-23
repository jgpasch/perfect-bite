// Lost memberships (spec 4.7, 7.2): when the user leaves a household, is removed from it, or it is
// deleted, this device removes everything it holds for that household and drops the mutations it
// still had queued for it. The server would reject those anyway (not a member).
//
// Pull writes, like the rows it brings down: nothing here goes to the outbox. Per-user rows stay
// (they belong to the user, not the household), except the user's own aisle order for the
// household and its queued mutations, which the server deletes when a member leaves; a Siri
// default list in the household is cleared here, as the server's `on delete set null` does there.
import { and, count, eq, inArray, like, sql } from 'drizzle-orm';

import {
  categories,
  deviceSettings,
  householdCategoryOrder,
  householdCategoryOverrides,
  householdMemberNames,
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
  userHouseholdCategoryOrder,
  userSettings,
} from '@/db';
import { LAST_OPENED_LIST_KEY } from '@/features/lists/lists';
import { listSeenAtKey, viewModeKey } from '@/features/lists/list-view';

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
  tx.delete(mealPlanEntries).where(eq(mealPlanEntries.householdId, householdId)).run();
  const items = tx.select({ n: count() }).from(listItems).where(eq(listItems.householdId, householdId)).get()?.n ?? 0;
  tx.delete(listItems).where(eq(listItems.householdId, householdId)).run();
  tx.delete(recipeIngredients).where(eq(recipeIngredients.householdId, householdId)).run();
  tx.delete(ingredientUsage).where(eq(ingredientUsage.householdId, householdId)).run();
  tx.delete(ingredientUnitUsage).where(eq(ingredientUnitUsage.householdId, householdId)).run();
  tx.delete(householdStaples).where(eq(householdStaples.householdId, householdId)).run();
  // Its aisles (spec 4.3.2, 4.3.3): overrides, custom categories, its aisle order, and the user's
  // own order for it with its queued mutations (per-user, so the household filter below misses them).
  tx.delete(householdCategoryOverrides).where(eq(householdCategoryOverrides.householdId, householdId)).run();
  tx.delete(householdCategoryOrder).where(eq(householdCategoryOrder.householdId, householdId)).run();
  tx.delete(userHouseholdCategoryOrder).where(eq(userHouseholdCategoryOrder.householdId, householdId)).run();
  tx.delete(outbox)
    .where(
      and(
        sql`json_extract(${outbox.mutation}, '$.table') = 'user_household_category_order'`,
        sql`json_extract(${outbox.mutation}, '$.key.household_id') = ${householdId}`,
      ),
    )
    .run();
  tx.delete(categories).where(eq(categories.householdId, householdId)).run();
  if (listIds.length) {
    tx.update(userSettings).set({ defaultListId: null }).where(inArray(userSettings.defaultListId, listIds)).run();
  }
  tx.delete(lists).where(eq(lists.householdId, householdId)).run();
  tx.delete(recipes).where(eq(recipes.householdId, householdId)).run();
  tx.delete(householdMemberNames).where(eq(householdMemberNames.householdId, householdId)).run();
  tx.delete(households).where(eq(households.id, householdId)).run();
  const mutations = tx.select({ n: count() }).from(outbox).where(eq(outbox.householdId, householdId)).get()?.n ?? 0;
  tx.delete(outbox).where(eq(outbox.householdId, householdId)).run();

  if (listIds.length) {
    tx.delete(deviceSettings)
      .where(inArray(deviceSettings.key, [...listIds.map(viewModeKey), ...listIds.map(listSeenAtKey)]))
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
