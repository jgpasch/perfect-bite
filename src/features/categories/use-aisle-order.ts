import { useMemo } from 'react';

import { categories, householdCategoryOrder, userHouseholdCategoryOrder } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import type { AisleOrderSource } from '@/domain/aisle-order';

import {
  householdAisleOrderQuery,
  householdAislesQuery,
  myAisleOrderQuery,
  resolvedAisleOrder,
  type CategoryRow,
} from './categories';

/**
 * The household's aisles in the order its lists use for the user (spec 4.3.3), live: it follows
 * new aisles, renames and either order changing (here or pulled).
 */
export function useAisleOrder(userId: string, householdId: string): { categories: CategoryRow[]; source: AisleOrderSource } {
  return useAisleOrders(userId, householdId).resolved;
}

type Order = { categories: CategoryRow[]; source: AisleOrderSource };

/**
 * Both orders the Aisle order screen can edit (spec 4.3.3), live: `resolved` is the one the user's
 * lists use (their own order, or the one a new own order starts from); `household` is the
 * household's order on its own (the default when there is none).
 */
export function useAisleOrders(userId: string, householdId: string): { resolved: Order; household: Order } {
  const { data: categoryRows } = useLiveQueryOn(householdAislesQuery(householdId), [categories], [householdId]);
  const { data: personal } = useLiveQueryOn(
    myAisleOrderQuery(userId, householdId),
    [userHouseholdCategoryOrder],
    [userId, householdId],
  );
  const { data: household } = useLiveQueryOn(householdAisleOrderQuery(householdId), [householdCategoryOrder], [householdId]);
  return useMemo(() => {
    return {
      resolved: resolvedAisleOrder(categoryRows, personal, household),
      household: resolvedAisleOrder(categoryRows, [], household),
    };
  }, [categoryRows, personal, household]);
}
