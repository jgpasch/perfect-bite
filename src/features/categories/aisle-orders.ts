// Saving aisle orders (spec 4.3.3), for the Aisle order screen: the household's order and the
// signed-in user's own order for a household. Each save writes the whole order; reading and
// resolving them is in `categories.ts` (`getAisleOrder`) and `use-aisle-order.ts`.
import { and, eq } from 'drizzle-orm';

import { db, householdCategoryOrder, userHouseholdCategoryOrder } from '@/db';
import { getAccount } from '@/features/auth/account';
import { deleteRows, upsertRow } from '@/sync/mutate';

function signedInUser(): string {
  const userId = getAccount()?.userId;
  if (!userId) throw new Error('not signed in');
  return userId;
}

/**
 * Saves the household's aisle order: the whole order, for every member who follows it. Leaves the
 * user's own order alone.
 */
export function saveHouseholdAisleOrder(householdId: string, ids: readonly string[]): void {
  const categoryIds = [...ids];
  upsertRow(db, householdCategoryOrder, { householdId, categoryIds }, { categoryIds });
}

/** Saves the user's own aisle order for the household, used instead of the household's. */
export function saveMyAisleOrder(householdId: string, ids: readonly string[]): void {
  const userId = signedInUser();
  const categoryIds = [...ids];
  upsertRow(db, userHouseholdCategoryOrder, { userId, householdId, categoryIds }, { categoryIds });
}

/** Use household order: deletes the user's own order, so they follow the household's again. */
export function useHouseholdAisleOrder(householdId: string): void {
  const userId = signedInUser();
  deleteRows(
    db,
    userHouseholdCategoryOrder,
    and(eq(userHouseholdCategoryOrder.userId, userId), eq(userHouseholdCategoryOrder.householdId, householdId)),
  );
}
