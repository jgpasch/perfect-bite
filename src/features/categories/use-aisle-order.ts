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
  const { data: categoryRows } = useLiveQueryOn(householdAislesQuery(householdId), [categories], [householdId]);
  const { data: personal } = useLiveQueryOn(
    myAisleOrderQuery(userId, householdId),
    [userHouseholdCategoryOrder],
    [userId, householdId],
  );
  const { data: household } = useLiveQueryOn(householdAisleOrderQuery(householdId), [householdCategoryOrder], [householdId]);
  return useMemo(() => resolvedAisleOrder(categoryRows, personal, household), [categoryRows, personal, household]);
}
