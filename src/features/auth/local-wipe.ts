// Wiping the device after account deletion (spec 4.8): afterwards the device keeps nothing of the
// user's. Every table in `src/db/schema.ts` must have a step in `WIPE_STEPS` (a test checks it);
// a table that keeps some rows says which and why.
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { eq, inArray, isNull, not, type SQL } from 'drizzle-orm';

import {
  categories,
  db,
  deviceSettings,
  failedImports,
  householdCategoryOverrides,
  householdMemberNames,
  households,
  householdStaples,
  ingredients,
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
} from '@/db';
import { SEED_KEY } from '@/features/categories/categories';
import { FOLD_ACCENTS_KEY } from '@/features/categories/fold-accents';
import { clearMyInvites } from '@/features/households/my-invites';
import { AISLE_COLORS_KEY, ITEM_ROW_STYLE_KEY } from '@/features/lists/list-view';
import { BACKFILL_KEY, UNITS_BACKFILL_KEY } from '@/features/lists/usage';
import { clearNotifications } from '@/features/notifications/notifications';
import { clearFeatures } from '@/features/plans/load';
import { IMPORT_ADD_TO_LIST_KEY } from '@/features/recipes/save-choice';
import { EMPTY_SHARE_QUEUE_STATUS, setShareQueueStatus } from '@/features/recipes/share-queue-status';
import { KEEP_SCREEN_ON_KEY } from '@/features/settings/device-settings';
import { emptyQueues } from '@/features/siri/app-group';
import { clearSiriListSnapshot } from '@/features/siri/list-snapshot';

/**
 * Device settings that survive the wipe: preferences of this device that hold no user data, and
 * markers for the catalog and one-time steps (which would otherwise rerun on data that doesn't need them).
 */
export const KEPT_DEVICE_SETTINGS = [
  AISLE_COLORS_KEY,
  ITEM_ROW_STYLE_KEY,
  KEEP_SCREEN_ON_KEY,
  IMPORT_ADD_TO_LIST_KEY,
  SEED_KEY,
  BACKFILL_KEY,
  UNITS_BACKFILL_KEY,
  FOLD_ACCENTS_KEY,
];

/** One table's delete. `keep` names the rows that stay (all others go) and why; without it the table is emptied. */
type WipeStep = { table: SQLiteTable; keep?: { rows: SQL; reason: string } };

/** In delete order: children before parents, for the foreign keys. */
export const WIPE_STEPS: WipeStep[] = [
  { table: failedImports },
  { table: outbox },
  { table: userSettings },
  { table: householdCategoryOverrides },
  { table: householdStaples },
  { table: householdMemberNames },
  { table: userCategoryOrder },
  { table: ingredientUnitUsage },
  { table: ingredientUsage },
  { table: listItemContributions },
  { table: mealPlanEntries },
  { table: listItems },
  { table: recipeIngredients },
  { table: recipes },
  { table: lists },
  {
    table: categories,
    keep: { rows: isNull(categories.householdId), reason: "System aisles are the global catalog; households' custom aisles go." },
  },
  { table: households },
  {
    table: ingredients,
    keep: {
      rows: eq(ingredients.status, 'categorized'),
      reason: 'Categorized ingredients are the global catalog (seed and server); names still pending or failed are what the user typed.',
    },
  },
  {
    table: deviceSettings,
    keep: { rows: inArray(deviceSettings.key, KEPT_DEVICE_SETTINGS), reason: 'Device-only preferences and markers (KEPT_DEVICE_SETTINGS).' },
  },
];

/** The tables `wipeLocalData` keeps some rows of, with the reason. */
export const KEEP_LIST: Record<string, string> = Object.fromEntries(
  WIPE_STEPS.flatMap(({ table, keep }) => (keep ? [[getTableConfig(table).name, keep.reason]] : [])),
);

/**
 * Deletes the user's data from this device (spec 4.8): every user and household row in SQLite in
 * one transaction (throws if that fails, leaving them all), then the App Group list snapshot and
 * queues, the plans store and its cached answer, the in-memory invites and notifications.
 * Safe to run again.
 */
export function wipeLocalData(): void {
  db.transaction((tx) => {
    for (const { table, keep } of WIPE_STEPS) {
      if (keep) tx.delete(table).where(not(keep.rows)).run();
      else tx.delete(table).run();
    }
  });
  clearSiriListSnapshot();
  try {
    emptyQueues();
  } catch (err) {
    console.warn('[account] emptying the App Group queues failed', err);
  }
  clearFeatures();
  clearMyInvites();
  clearNotifications();
  setShareQueueStatus(EMPTY_SHARE_QUEUE_STATUS);
}
